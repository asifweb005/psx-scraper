'use strict';
// Official DPS index panel; timestamps are Pakistan Standard Time (UTC+05).
function indexFromSnapshot(s, now = Date.now()) {
  const num = x => {
    if(x == null || String(x).trim()==='') return NaN;
    return Number(String(x).replace(/,/g,'').trim());
  };
  if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s?.date || '')) throw Error('Missing index source timestamp');
  const ts = Date.parse(s.date.replace(' ','T')+'+05:00');
  if(!Number.isFinite(ts) || ts>now+60000 || now-ts>7*86400000) throw Error('Invalid or stale index source timestamp');
  const last=num(s.close), prev=num(s.stats?.['Previous Close']);
  const high=num(s.stats?.High),low=num(s.stats?.Low),volume=num(s.stats?.Volume);
  if(![last,prev,high,low,volume].every(Number.isFinite) ||
     Math.min(last,prev,high,low)<=0 || high<low || last<low || last>high ||
     volume<0 || !Number.isInteger(volume)) throw Error('Invalid index values');
  const round=x=>Math.round(x*100)/100;
  return {index_code:'KSE100',name:'KSE-100 Index',last_value:last,
    change:round(last-prev),change_pct:round((last-prev)/prev*100),
    high,low,volume,advancers:null,decliners:null,unchanged:null,refreshed_at:new Date(ts).toISOString()};
}
module.exports={indexFromSnapshot};
