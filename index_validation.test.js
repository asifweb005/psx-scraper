const {test}=require('node:test');
const assert=require('node:assert/strict');
const {indexFromSnapshot}=require('./index_validation');
const snapshot=()=>({date:'2026-10-08 12:38:15',close:'168128.16',stats:{High:'169,486.60',Low:'168,036.74',Volume:'85,911,208','Previous Close':'168,580.40'}});
const now=Date.parse('2026-10-08T08:00:00Z');
test('official previous close and exact PKT source timestamp',()=>{
 const q=indexFromSnapshot(snapshot(),now);
 assert.equal(q.last_value,168128.16);assert.equal(q.change,-452.24);
 assert.equal(q.change_pct,-0.27);assert.equal(q.volume,85911208);
 assert.equal(q.refreshed_at,'2026-10-08T07:38:15.000Z');
 assert.equal(q.advancers,null);
});
test('rising index and unchanged index',()=>{
 let s=snapshot();s.close='169000';assert.equal(indexFromSnapshot(s,now).change,419.6);
 s.close='168580.40';assert.equal(indexFromSnapshot(s,now).change_pct,0);
});
test('source precision may differ from displayed range by less than one cent',()=>{
 const s=snapshot();s.close='168036.735';
 assert.equal(indexFromSnapshot(s,now).last_value,168036.735);
 s.close='168036.70';assert.throws(()=>indexFromSnapshot(s,now),/last/);
});
test('reject stale, future and missing source dates',()=>{
 for(const date of ['2026-09-24 12:38:15','2026-10-09 12:38:15',undefined]){
 assert.throws(()=>indexFromSnapshot({...snapshot(),date},now));
 }
});
test('reject invalid, absent and inconsistent prices and volumes',()=>{
 for(const [key,value] of [['Previous Close',''],['Previous Close','0'],['Low','170000'],['High','NaN'],['Volume','-1'],['Volume','1.5']]){
 const s=snapshot();s.stats[key]=value;assert.throws(()=>indexFromSnapshot(s,now));
 }
 assert.throws(()=>indexFromSnapshot({...snapshot(),close:'not a number'},now));
});

