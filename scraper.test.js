const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const validation = require('./quote_validation');
const source = fs.readFileSync(require('node:path').join(__dirname,'scraper.js'),'utf8');
const now = Date.parse('2026-10-05T10:00:00Z');
class Clock extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }

async function run({action='quotes',feeds={},dryRun=false,browserFeeds={},dbError=null,snapshots={}}={}) {
  const writes=[],calls=[]; let closed=false;
  const process={argv:['node','scraper.js',action,...(dryRun?['--dry-run']:[])],env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test'}};
  const db={from(table){
    const result = table==='stocks'?{data:[{symbol:'HBL'}]}:table==='v_latest_bars'?{data:[{symbol:'HBL',traded_on:'2026-10-02',close:95}]}:table==='market_holidays'?{data:[]}:table==='index_history'?{data:{close:100}}:{data:[]};
    const query={select(){return this;},eq(){return this;},order(){return this;},maybeSingle(){return Promise.resolve(result);},then(resolve,reject){return Promise.resolve(result).then(resolve,reject);},
      async upsert(rows){writes.push({table,rows});return {error:dbError};},async insert(row){writes.push({table,rows:[row]});return {error:null};}};
    return query;
  }};
  const page={async goto(){},async cookies(){return [{name:'cf_clearance',value:'test'}];},async evaluate(fn,url){if(!url)return 'test-request-id'; if(!url.startsWith('http'))return snapshots[url]??{error:'missing snapshot'}; const path=new URL(url).pathname;return browserFeeds[path]?{rows:browserFeeds[path]}:{error:'HTTP 403'};}};
  const browser={async newPage(){return page;},async close(){closed=true;}};
  const context={process,Date:Clock,URL,AbortSignal,Map,Set,console:{log(){},error(){}},setTimeout(fn){fn();},
    require(name){if(name==='puppeteer')return {async launch(){return browser;}};if(name==='@supabase/supabase-js')return {createClient(){return db;}};if(name==='./quote_validation')return validation;throw Error(name);},
    async fetch(url){const path=new URL(url).pathname;calls.push(path);const rows=feeds[path];return {ok:rows!==undefined,status:rows!==undefined?200:403,async json(){return rows;}};}};
  vm.createContext(context);
  // Await main explicitly so tests cannot pass before its asynchronous work.
  const task=vm.runInContext(source.replace('main().catch(e => {console.error(String(e)); process.exitCode = 1;});','main()'),context);
  await task;
  return {writes,calls,closed,exit:process.exitCode};
}
const tick=[[now/1000,101,3],[now/1000-60,100,2]];
test('blocked source fails and preserves existing market/index/history data',async()=>{
  const r=await run();assert.equal(r.exit,1);assert.equal(r.closed,true);
  assert.deepEqual(r.writes.filter(x=>x.table!=='sync_log'),[]);
  assert.equal(r.writes.at(-1).rows[0].status,'error');
});
test('valid live source writes source timestamps and deduplicated ticks',async()=>{
  const r=await run({feeds:{'/timeseries/int/HBL':tick,'/timeseries/int/KSE100':tick}});
  assert.equal(r.exit,undefined);assert.equal(r.closed,true);
  assert.equal(r.writes.find(x=>x.table==='intraday_prices').rows.length,2);
  const q=r.writes.find(x=>x.table==='market_quotes').rows[0];assert.equal(q.change,6);assert.equal(q.refreshed_at,'2026-10-05T10:00:00.000Z');
  assert.equal(r.writes.find(x=>x.table==='index_quotes').rows[0].change,1);
});
test('browser retry can recover after native fetch fails',async()=>{
  const r=await run({browserFeeds:{'/timeseries/int/HBL':tick,'/timeseries/int/KSE100':tick}});
  assert.equal(r.exit,undefined);assert.ok(r.writes.some(x=>x.table==='market_quotes'));
});
test('dry run validates without database writes',async()=>{
  const r=await run({dryRun:true,feeds:{'/timeseries/int/HBL':tick,'/timeseries/int/KSE100':tick}});
  assert.equal(r.exit,undefined);assert.equal(r.writes.length,0);
});
test('EOD fetches missing actual bars instead of copying market quote snapshots',async()=>{
  const t=Date.parse('2026-10-02T10:30:00Z')/1000;
  const r=await run({action:'eod',feeds:{'/timeseries/eod/HBL':[[t,101,20,99,102,98]],'/timeseries/eod/KSE100':[[t,170000]]}});
  assert.equal(r.exit,undefined);const rows=r.writes.find(x=>x.table==='historical_prices').rows;
  assert.equal(rows[0].traded_on,'2026-10-02');assert.equal(rows[0].open,99);
  assert.ok(!r.calls.includes('/timeseries/int/HBL'));
});
test('close-only EOD source fails rather than inventing OHLC',async()=>{
  const r=await run({action:'eod',feeds:{'/timeseries/eod/HBL':[[now/1000-86400*3,101,20]]}});
  assert.equal(r.exit,1);assert.ok(!r.writes.some(x=>x.table==='historical_prices'));
});
test('database write failure makes the workflow fail',async()=>{
  const r=await run({feeds:{'/timeseries/int/HBL':tick},dbError:{message:'write denied'}});
  assert.equal(r.exit,1);assert.equal(r.closed,true);
});
test('official snapshot fallback restores real quote changes without summing cumulative volume into ticks',async()=>{
  const r=await run({feeds:{'/timeseries/int/KSE100':tick},snapshots:{HBL:{date:'Mon, Oct 5, 2026 2:59 PM',close:'101',stats:{Open:'100',High:'102',Low:'99',Volume:'500',LDCP:'95'}}}});
  assert.equal(r.exit,undefined);
  assert.equal(r.writes.find(x=>x.table==='market_quotes').rows[0].volume,500);
  assert.equal(r.writes.find(x=>x.table==='intraday_prices').rows[0].volume,null);
});
