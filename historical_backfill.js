// Same Node/Puppeteer environment as live-quotes.yml, official historical UI.
'use strict';
const puppeteer=require('puppeteer');
const {createClient}=require('@supabase/supabase-js');
const {isoDate,monthsBetween,historicalRows,persistMissing}=require('./history_validation');

async function main(){
  const from=isoDate(process.env.HISTORY_FROM),to=isoDate(process.env.HISTORY_TO);
  const pktToday=new Date(Date.now()+5*3600000).toISOString().slice(0,10);
  if(to>=pktToday)throw Error('Backfill end must be before today; today is handled by EOD sync');
  const months=monthsBetween(from,to);
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
  const browser=await puppeteer.launch({headless:'new',args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  let restored=0;const failures=[];
  try{
    const page=await browser.newPage();
    await page.goto('https://dps.psx.com.pk/historical',{waitUntil:'networkidle2',timeout:30000});
    // Use the site's own AJAX client, including its page-issued headers.
    for(const symbol of symbols){
      const {data:existing,error:readError}=await sb.from('historical_prices').select('traded_on').eq('symbol',symbol).gte('traded_on',from).lte('traded_on',to);
      if(readError)throw readError;
      const present=new Set((existing??[]).map(r=>r.traded_on));
      for(const {year,month} of months){
        const result=await page.evaluate(async ({symbol,year,month})=>{
          const response=await new Promise(resolve=>{
            if(!window.jQuery)return resolve({error:'PSX AJAX client unavailable'});
            window.jQuery.ajax({type:'POST',url:'/historical',data:{symbol,year,month},dataType:'html',timeout:20000})
              .done(html=>resolve({html})).fail(xhr=>resolve({error:`PSX historical HTTP ${xhr.status}`}));
          });
          if(response.error)return response;
          const d=new DOMParser().parseFromString(response.html,'text/html');
          const table=d.querySelector('#historicalTable');
          if(!table)return {error:'PSX historical table missing (unexpected source markup)'};
          return {headers:[...table.querySelectorAll('thead th')].map(c=>c.textContent.trim()),rows:[...table.querySelectorAll('tbody tr')].map(r=>[...r.querySelectorAll('td')].map(c=>c.textContent.trim()))};
        },{symbol,year,month});
        if(result.error){
          failures.push(`${symbol} ${year}-${month}: ${result.error}`);
          console.error(failures.at(-1));
          // Avoid requesting every symbol if the source is blocked globally.
          if(/HTTP (403|404|429)/.test(result.error))throw Error(failures.at(-1));
          continue;
        }
        let parsed;
        try{parsed=historicalRows(symbol,result,from,to);}catch(e){failures.push(`${symbol}: ${e.message}`);continue;}
        const missing=parsed.rows.filter(r=>!present.has(r.traded_on));
        await persistMissing(sb,missing,dryRun);
        restored+=missing.length;
        for(const row of missing)present.add(row.traded_on);
        console.log(`${dryRun?'DRY RUN':'RESTORED'} ${symbol} ${year}-${month}: ${missing.length} missing bars; ${parsed.rejected} rejected`);
        if(parsed.rejected)failures.push(`${symbol} ${year}-${month}: ${parsed.rejected} malformed rows`);
        if(!parsed.rows.length)failures.push(`${symbol} ${year}-${month}: no validated rows in requested dates`);
        await new Promise(r=>setTimeout(r,500));
      }
      const uncovered=expected.filter(date=>!present.has(date));
      if(uncovered.length)failures.push(`${symbol}: still missing ${uncovered.join(',')}`);
    }
    console.log(JSON.stringify({from,to,dryRun,symbols:symbols.length,missingBars:restored,failures:failures.length}));
    if(failures.length)throw Error(`Backfill incomplete: ${failures.slice(0,3).join('; ')}`);
    if(!dryRun){
      const {error}=await sb.from('sync_log').insert({job:'history-backfill',status:'ok',detail:`${from}..${to}: inserted ${restored} missing bars for ${symbols.length} symbols`});
      if(error)throw error;
    }
  }finally{await browser.close();}
}
main().catch(e=>{console.error(String(e));process.exitCode=1;});
