const {test}=require('node:test');const assert=require('node:assert/strict');
const {sessionDate,restore,verifyCandles,retainedCloseRow,verifyIndicators}=require('./eod_sync');
const table={headers:['Date','Open','High','Low','Close','Volume'],rows:[['2026-10-06','100','105','95','102','1000']]};
test('current date cannot become final before close, future and old dates rejected',()=>{
 assert.throws(()=>sessionDate('',Date.parse('2026-10-07T08:00Z')),/17:00/);
 assert.equal(sessionDate('',Date.parse('2026-10-07T12:00Z')),'2026-10-07');
 assert.equal(sessionDate('2026-10-06',Date.parse('2026-10-07T08:00Z')),'2026-10-06');
 assert.throws(()=>sessionDate('2026-10-08',Date.parse('2026-10-07T12:00Z')));
});
test('missing or malformed source prevents all writes after bounded retries',async()=>{
 let calls=0,writes=0;const sb={from(){return {upsert(){writes++},select(){return this},eq(){return this},lt(){return this},order(){return this},limit(){return this},async maybeSingle(){return {data:null}}}}};
 await assert.rejects(restore(sb,['HBL'],'2026-10-06',async()=>{calls++;return {...table,rows:[]}},async()=>{}),/coverage incomplete/);
 assert.equal(calls,3);assert.equal(writes,0);
});
test('PSX retained official close outside traded range requires low turnover and verified previous close',()=>{
 const source={headers:['Date','OPEN','HIGH','LOW','CLOSE','VOLUME'],rows:[['2026-10-06','33.99','33.99','33.41','33.2','223.0']]};
 assert.equal(retainedCloseRow('PKGP',source,'2026-10-06',33.2).close,33.2);
 assert.equal(retainedCloseRow('PKGP',source,'2026-10-06',33.99),null);
 assert.equal(retainedCloseRow('PKGP',{...source,rows:[['2026-10-06','33.99','33.99','33.41','33.2','500']]},'2026-10-06',33.2),null);
 assert.equal(retainedCloseRow('PKGP',{...source,rows:[['2026-10-06','100','100','90','80','300']]},'2026-10-06',80),null);
 assert.equal(retainedCloseRow('PKGP',source,'2026-10-05',33.2),null);
});
test('retry recovers genuine OHLCV and read-back mismatch fails',async()=>{
 let calls=0,stored;
 const sb={from(){return {async upsert(rows){stored=rows;return {}},select(){return this},eq(){return this},async in(){return {data:stored.map(r=>({...r,close:101}))}}}}};
 await assert.rejects(restore(sb,['HBL'],'2026-10-06',async()=>{if(++calls===1)throw Error('source busy');return table},async()=>{}),/verification failed/);
 assert.equal(calls,2);assert.equal(stored[0].close,102);
});
test('verified source replaces earlier intraday-derived bar at same session',async()=>{
 let stored,options;const sb={from(){return {async upsert(rows,opt){stored=rows;options=opt;return {}},select(){return this},eq(){return this},async in(){return {data:stored}}}}};
 const rows=await restore(sb,['HBL'],'2026-10-06',async()=>table,async()=>{});
 assert.equal(rows[0].volume,1000);assert.equal(options.onConflict,'symbol,traded_on');assert.equal(options.ignoreDuplicates,undefined);
});
test('zero coverage and missing daily indicators fail',async()=>{
 assert.throws(()=>verifyCandles([{symbol:'HBL',open:100}],[]),/verification failed/);
 const sb={from(){return {select(){return this},eq(){return this},async in(){return {data:[]}}}}};
 await assert.rejects(verifyIndicators(sb,['HBL'],'2026-10-06'),/indicator coverage incomplete/);
});

