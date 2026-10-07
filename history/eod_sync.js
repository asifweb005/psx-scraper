'use strict';
const fs=require('node:fs');
const {createClient}=require('@supabase/supabase-js');
const {fetchHistory}=require('./historical_backfill');
const {isoDate,historicalRows}=require('./history_validation');
// Same obsolete/unavailable tickers excluded from scheduled historical repair.
const EXCLUDED=new Set(['AKZO','DAWH','GHNL','LPCL','PSMC','SHEL']);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function sessionDate(requested,now=Date.now()) {
 const pkt=new Date(now+5*3600000),today=pkt.toISOString().slice(0,10);
 const date=isoDate(requested||today);
 if(date>today||Date.parse(today)-Date.parse(date)>7*86400000)throw Error('Session must be today or within the preceding 7 days');
 // Conservative close guard, including the later Friday session.
 if(date===today&&pkt.getUTCHours()<17)throw Error('Final candles may only be fetched after 17:00 PKT');
 return date;
}
function verifyCandles(expected,saved) {
 const map=new Map(saved.map(r=>[r.symbol,r]));
 const missing=expected.filter(r=>!map.has(r.symbol)||['open','high','low','close','volume'].some(k=>!Number.isFinite(Number(map.get(r.symbol)[k]))||Number(map.get(r.symbol)[k])!==Number(r[k])));
 if(missing.length)throw Error('Stored candle verification failed: '+missing.map(r=>r.symbol).join(','));
}
async function restore(sb,symbols,date,fetcher=fetchHistory,sleep=pause,dry=false) {
 if(!symbols.length)throw Error('No eligible EOD symbols');
 const rows=[],failures=[];
 for(const symbol of symbols){
  let bar,lastError;
  for(let attempt=0;attempt<3;attempt++){
   try{
    const parsed=historicalRows(symbol,await fetcher(symbol,date,date),date,date);
    if(parsed.rejected||parsed.rows.length!==1)throw Error('Final session candle unavailable or malformed');
    bar=parsed.rows[0];break;
   }catch(e){lastError=e.message;if(attempt<2)await sleep(20000*(attempt+1));}
  }
  if(bar)rows.push(bar);else failures.push(symbol+': '+lastError);
  await sleep(1500);
 }
 // Do not present an incomplete fetch as a successful EOD batch.
 if(failures.length)throw Error('EOD source coverage incomplete: '+failures.join('; '));
 if(dry)return rows;
 const {error}=await sb.from('historical_prices').upsert(rows,{onConflict:'symbol,traded_on'});
 if(error)throw Error('EOD write: '+error.message);
 const {data:saved,error:readError}=await sb.from('historical_prices').select('symbol,open,high,low,close,volume').eq('traded_on',date).in('symbol',symbols);
 if(readError)throw readError;
 verifyCandles(rows,saved??[]);return rows;
}
async function verifyIndicators(sb,symbols,date){
 const {data,error}=await sb.from('technical_indicators').select('symbol').eq('computed_on',date).eq('timeframe','daily').in('symbol',symbols);
 if(error)throw error;
 const present=new Set((data??[]).map(r=>r.symbol)),missing=symbols.filter(s=>!present.has(s));
 if(missing.length)throw Error('Daily indicator coverage incomplete: '+missing.join(','));
}
async function main(){
 const date=sessionDate(process.env.EOD_SESSION);
 const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);
 const verify=process.argv.includes('--verify-indicators');
 try{
  if(verify){
   const symbols=String(process.env.EOD_SYMBOLS||'').split(',').filter(Boolean);
   if(!symbols.length)throw Error('Missing verified EOD symbol list');
   await verifyIndicators(sb,symbols,date);
   const {error}=await sb.from('sync_log').insert({job:'psx-eod-verified',status:'ok',detail:`${date}: verified final OHLCV and daily indicators for ${symbols.length} stocks`});
   if(error)throw error;
   console.log(`Verified daily indicators for ${symbols.length} stocks on ${date}`);return;
  }
  const {data:holidays,error:holidayError}=await sb.from('market_holidays').select('traded_on').eq('traded_on',date);
  if(holidayError)throw holidayError;
  const dow=new Date(date+'T12:00:00Z').getUTCDay();
  if(dow===0||dow===6||holidays?.length){
   if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'skip=true\n');
   console.log('No trading session on '+date);return;
  }
  const {data:stocks,error}=await sb.from('stocks').select('symbol').eq('is_active',true).order('symbol');
  if(error)throw error;
  const symbols=(stocks??[]).map(r=>r.symbol).filter(s=>!EXCLUDED.has(s));
  await restore(sb,symbols,date);
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`skip=false\nsession=${date}\nsymbols=${symbols.join(',')}\n`);
  console.log(`Verified final OHLCV for ${symbols.length} stocks on ${date}`);
 }catch(e){
  await sb.from('sync_log').insert({job:'psx-eod-verified',status:'error',detail:`${date}: ${String(e.message||e).slice(0,450)}`});
  throw e;
 }
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={sessionDate,verifyCandles,restore,verifyIndicators};

