const {test} = require('node:test');
const assert = require('node:assert/strict');
const {validatedTicks, quoteFromTicks, parseEod, freshQuoteRows, quoteFromSnapshot} = require('./live_quote_validation');
const now = Date.parse('2026-10-05T10:00:00Z');
const ts = now / 1000;
test('fallback records cannot overwrite real quotes or acquire a fresh timestamp', () => {
  assert.deepEqual(freshQuoteRows([{symbol:'HBL',last:100,change:0,volume:0,fresh:false,refreshed_at:new Date(now).toISOString()}]), []);
});
test('ticks validate session, sort timestamps, deduplicate and reject invalid prices', () => {
  const ticks = validatedTicks([[ts-60,100,2],[ts,101,3],[ts,101,3],[ts-86400,90,4],[ts+120,102,3],[ts-10,0,4],[ts-20,102,-1]],'2026-10-05',now);
  assert.deepEqual(ticks, [[ts,101,3],[ts-60,100,2]]);
});
test('quote uses previous close and source time, not opening price or fetch time', () => {
  const q = quoteFromTicks('HBL',[[ts,101,3],[ts-60,100,2]],95);
  assert.equal(q.change,6);
  assert.equal(q.change_pct,6.32);
  assert.equal(q.open,100);
  assert.equal(q.refreshed_at,'2026-10-05T10:00:00.000Z');
});
test('missing baseline and missing volume stay unknown', () => {
  const q=quoteFromTicks('HBL',[[ts,101,null]],null);
  assert.equal(q.change,null);
  assert.equal(q.change_pct,null);
  assert.equal(q.volume,null);
});
test('EOD backfill rejects close-only, invalid ranges, null values and future sessions', () => {
  const previous=Date.parse('2026-10-02T10:30:00Z')/1000;
  const rows=parseEod('HBL',[[previous,101,30,99,103,98],[previous-86400,100,30],[previous-172800,100,30,null,101,99],[ts,102,20,101,103,100]],'2026-10-02');
  assert.equal(rows.length,1);
  assert.equal(rows[0].traded_on,'2026-10-02');
  assert.equal(rows[0].open,99);
});
test('official company snapshot preserves PKT source time, actual range, change and cumulative volume', () => {
  const q=quoteFromSnapshot('HBL',{date:'^ As of Mon, Oct 5, 2026 3:44 PM',close:'Rs.295.21',stats:{Open:'300.03',High:'301.99',Low:'294.40',Volume:'723,612',LDCP:'302.29'}},'2026-10-05',Date.parse('2026-10-05T11:00:00Z'));
  assert.equal(q.refreshed_at,'2026-10-05T10:44:00.000Z');
  assert.equal(q.change,-7.08);assert.equal(q.change_pct,-2.34);assert.equal(q.volume,723612);
});
test('old or malformed company snapshots cannot become current quotes',()=>{
  assert.equal(quoteFromSnapshot('HBL',{date:'Mon, Sep 24, 2026 3:44 PM'},'2026-10-05',now),null);
  assert.equal(quoteFromSnapshot('HBL',{date:'Mon, Oct 5, 2026 3:44 PM',close:'0',stats:{}},'2026-10-05',now),null);
});

