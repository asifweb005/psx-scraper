const {test}=require('node:test');
const assert=require('node:assert/strict');
const {isoDate,monthsBetween,historicalRows,persistMissing}=require('./history_validation');
const headers=['Date','Open','High','Low','Close','Volume'];
test('range validates civil dates and traverses month boundaries',()=>{
  assert.throws(()=>isoDate('2026-02-30'));
  assert.throws(()=>monthsBetween('2026-10-01','2026-09-01'));
  assert.deepEqual(monthsBetween('2026-09-25','2026-10-02'),[{year:2026,month:9},{year:2026,month:10}]);
});
test('dated historical table produces actual OHLCV and preserves source session',()=>{
  const result=historicalRows('HBL',{headers,rows:[['Oct 2, 2026','300.03','301.99','294.40','295.21','723,612'],['24-Sep-2026','300','305','299','302','1,000']]},'2026-09-25','2026-10-02');
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].traded_on,'2026-10-02');assert.equal(result.rows[0].high,301.99);assert.equal(result.rows[0].volume,723612);
});
test('header order can change, but missing ranges are rejected',()=>{
  assert.throws(()=>historicalRows('HBL',{headers:['Date','Close','Volume'],rows:[]},'2026-09-25','2026-10-02'));
  const r=historicalRows('HBL',{headers:['Volume','Close','Low','High','Open','Date'],rows:[['100','101','99','102','100','2026-10-02']]},'2026-09-25','2026-10-02');
  assert.equal(r.rows[0].open,100);
});
test('invalid range, missing values and invalid calendar dates cannot be written',()=>{
  const r=historicalRows('HBL',{headers,rows:[['2026-10-02','100','90','99','101','100'],['2026-10-02','100','','99','101','100'],['31-Sep-2026','100','102','99','101','100']]},'2026-09-25','2026-10-02');
  assert.equal(r.rows.length,0);assert.equal(r.rejected,3);
});
test('dry run never writes; backfill ignores conflicting existing candles',async()=>{
  const writes=[];const sb={from(){return {async upsert(rows,options){writes.push({rows,options});return {error:null};}};}};
  await persistMissing(sb,[{symbol:'HBL'}],true);assert.equal(writes.length,0);
  await persistMissing(sb,[{symbol:'HBL'}],false);assert.equal(writes[0].options.ignoreDuplicates,true);
});
test('write errors propagate instead of returning a successful job',async()=>{
  const sb={from(){return {async upsert(){return {error:{message:'denied'}};}};}};
  await assert.rejects(persistMissing(sb,[{symbol:'HBL'}],false),/denied/);
});
