const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const validation=require('./live_quote_validation');
const source=fs.readFileSync(require('node:path').join(__dirname,'scraper.js'),'utf8');
const now=Date.parse('2026-10-06T05:00:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
async function run(snapshot, intradayError=null){
 const writes=[];let closed=false;
 const process={argv:['node','scraper.js','quotes'],env:{}};
 const db={from(table){
   const result=table==='stocks'?{data:[{symbol:'HBL'}]}:table==='v_latest_bars'?{data:[{symbol:'HBL',traded_on:'2026-10-05',close:295.21}]}:{data:[]};
   return {select(){return this;},eq(){return this;},order(){return this;},then(resolve,reject){return Promise.resolve(result).then(resolve,reject);},async upsert(rows,options){writes.push({table,rows,options});return {error:table==='intraday_prices'?intradayError:null};},async insert(row){writes.push({table,rows:[row]});return {error:null};}};}};
 const page={async goto(){},async cookies(){return [{name:'session',value:'test'}];},async evaluate(){if(!snapshot)throw Error('HTTP 404');return snapshot;}};
 const browser={async newPage(){return page;},async close(){closed=true;}};
 const ctx={process,Date:Clock,Map,console:{log(){},error(){}},AbortSignal,setTimeout(fn){fn();},require(name){if(name==='puppeteer')return {async launch(){return browser;}};if(name==='@supabase/supabase-js')return {createClient(){return db;}};return validation;},async fetch(){return {ok:false};}};
 vm.createContext(ctx);
 await vm.runInContext(source.replace('main().catch(e=>{console.error(String(e));process.exitCode=1;});','main()'),ctx);
 return {writes,closed,exit:process.exitCode};
}
const snapshot={date:'As of Tue, Oct 6, 2026 9:58 AM',close:'Rs.300.00',stats:{Open:'298.00',High:'301.00',Low:'297.00',Volume:'12,345',LDCP:'295.21'}};
test('official snapshot restores actual change, volume and source time',async()=>{
 const r=await run(snapshot);const q=r.writes.find(w=>w.table==='market_quotes').rows[0];
 assert.equal(q.change,4.79);assert.equal(q.change_pct,1.62);assert.equal(q.volume,12345);
 assert.equal(q.refreshed_at,'2026-10-06T04:58:00.000Z');assert.equal(r.closed,true);
 const p=r.writes.find(w=>w.table==='intraday_prices');
 assert.equal(p.rows[0].ts,q.refreshed_at);assert.equal(p.rows[0].price,300);assert.equal(p.rows[0].volume,null);
 assert.equal(p.options.onConflict,'symbol,ts');assert.equal(p.options.ignoreDuplicates,true);
});
test('unavailable source cannot overwrite stored quotes with zero fallbacks',async()=>{
 const r=await run();assert.equal(r.writes.some(w=>w.table==='market_quotes'||w.table==='intraday_prices'),false);assert.equal(r.exit,1);assert.equal(r.closed,true);
});
test('intraday write failure fails the run while preserving successful quote updates',async()=>{
 const r=await run(snapshot,{message:'database unavailable'});
 assert.equal(r.exit,1);assert.equal(r.closed,true);
 assert.equal(r.writes.some(w=>w.table==='market_quotes'),true);
 assert.equal(r.writes.some(w=>w.table==='sync_log'&&w.rows[0].status==='error'),true);
});
test('yesterday snapshot cannot be relabelled as current',async()=>{
 const r=await run({...snapshot,date:'As of Mon, Oct 5, 2026 3:44 PM'});assert.equal(r.writes.some(w=>w.table==='market_quotes'),false);assert.equal(r.exit,1);
});



