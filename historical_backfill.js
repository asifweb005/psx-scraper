'use strict';
const {createClient}=require('@supabase/supabase-js');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const path=require('node:path');
const {isoDate,monthsBetween,historicalRows,persistMissing}=require('./history_validation');
const run=promisify(execFile);
async function fetchHistory(symbol,from,to){
  const {stdout,stderr}=await run(process.env.PYTHON_BIN||'python',[path.join(__dirname,'export_history.py'),symbol,from,to],{timeout:180000,maxBuffer:8*1024*1024});
  if(stderr)process.stderr.write(stderr);
  return JSON.parse(stdout);
}
async function main(){
  const from=isoDate(process.env.HISTORY_FROM),to=isoDate(process.env.HISTORY_TO);
  const pktToday=new Date(Date.now()+5*3600000).toISOString().slice(0,10);
  if(to>=pktToday)throw Error('Backfill end must be before today; today is handled by EOD sync');
  monthsBetween(from,to);
  const dryRun=process.argv.includes('--dry-run');
  const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
  const {data:holidays,error:holidayError}=await sb.from('market_holidays').select('traded_on').gte('traded_on',from).lte('traded_on',to);
  if(holidayError)throw holidayError;
  const closed=new Set((holidays??[]).map(r=>r.traded_on));
  const expected=[];
  for(let day=new Date(from+'T00:00:00Z');day.toISOString().slice(0,10)<=to;day.setUTCDate(day.getUTCDate()+1)){
    const date=day.toISOString().slice(0,10);
    if(day.getUTCDay()!==0&&day.getUTCDay()!==6&&!closed.has(date))expected.push(date);
  }
  const {data:stocks,error}=await sb.from('stocks').select('symbol').eq('is_active',true).order('symbol');
  if(error)throw error;
  const requested=(process.env.HISTORY_SYMBOLS??'').trim();
  if(requested&&!/^[A-Za-z0-9-]+(?:,[A-Za-z0-9-]+)*$/.test(requested))throw Error('Symbols must be comma-separated tickers');
  const wanted=requested?new Set(requested.toUpperCase().split(',')):null;
  const symbols=(stocks??[]).map(r=>r.symbol).filter(s=>!wanted||wanted.has(s));
  if(!symbols.length||wanted&&symbols.length!==wanted.size)throw Error('Requested symbol is not active/tracked');
  let restored=0;const failures=[];
  for(const symbol of symbols){
    const {data:existing,error:readError}=await sb.from('historical_prices').select('traded_on').eq('symbol',symbol).gte('traded_on',from).lte('traded_on',to);
    if(readError)throw readError;
    const present=new Set((existing??[]).map(r=>r.traded_on));
    if(expected.every(date=>present.has(date))){console.log(`${symbol}: requested sessions already stored`);continue;}
    let parsed;
    try{parsed=historicalRows(symbol,await fetchHistory(symbol,from,to),from,to);}
    catch(e){failures.push(`${symbol}: toolkit/validation failed`);console.error(`${symbol}: ${e.message}`);continue;}
    const missing=parsed.rows.filter(r=>!present.has(r.traded_on));
    await persistMissing(sb,missing,dryRun);
    restored+=missing.length;
    for(const row of missing)present.add(row.traded_on);
    if(!dryRun){
      const {data:saved,error:verifyError}=await sb.from('historical_prices').select('traded_on').eq('symbol',symbol).gte('traded_on',from).lte('traded_on',to);
      if(verifyError)throw verifyError;
      present.clear();for(const row of saved??[])present.add(row.traded_on);
    }
    console.log(`${dryRun?'DRY RUN':'RESTORED'} pypsx-toolkit ${symbol}: ${missing.length} missing bars; ${parsed.rejected} rejected`);
    if(parsed.rejected)failures.push(`${symbol}: ${parsed.rejected} malformed rows`);
    const uncovered=expected.filter(date=>!present.has(date));
    if(uncovered.length)failures.push(`${symbol}: still missing ${uncovered.join(',')}`);
    await new Promise(r=>setTimeout(r,500));
  }
  console.log(JSON.stringify({source:'pypsx-toolkit@3.1.2',from,to,dryRun,symbols:symbols.length,missingBars:restored,failures:failures.length}));
  if(failures.length)throw Error(`Backfill incomplete: ${failures.slice(0,3).join('; ')}`);
  if(!dryRun){
    const {error}=await sb.from('sync_log').insert({job:'history-backfill',status:'ok',detail:`pypsx-toolkit@3.1.2 ${from}..${to}: inserted ${restored} missing bars for ${symbols.length} symbols`});
    if(error)throw error;
  }
}
if(require.main===module)main().catch(e=>{console.error(String(e));process.exitCode=1;});
module.exports={fetchHistory};
