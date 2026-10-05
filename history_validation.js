'use strict';
const {parseEod} = require('./quote_validation');
function isoDate(value) {
  const s=String(value??'').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Error('Date must be YYYY-MM-DD');
  const d=new Date(s+'T12:00:00Z');
  if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==s)throw Error('Invalid calendar date');
  return s;
}
function sourceDate(value) {
  const s=String(value??'').trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s))return isoDate(s);
  const m=s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ,]+(\d{4})$/)||s.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if(!m)return null;
  const leading=/^[A-Za-z]/.test(m[1]);
  const names=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const month=names.indexOf((leading?m[1]:m[2]).toLowerCase())+1;
  if(!month)return null;
  return isoDate(`${m[3]}-${String(month).padStart(2,'0')}-${String(leading?m[2]:m[1]).padStart(2,'0')}`);
}
function monthsBetween(from,to) {
  isoDate(from);isoDate(to);
  if(from>to)throw Error('from must be before to');
  if((Date.parse(to)-Date.parse(from))/86400000>366)throw Error('Backfill is limited to 366 days per run');
  const months=[];const d=new Date(from.slice(0,7)+'-01T12:00:00Z');
  while(d.toISOString().slice(0,7)<=to.slice(0,7)){
    months.push({year:d.getUTCFullYear(),month:d.getUTCMonth()+1});d.setUTCMonth(d.getUTCMonth()+1);
  }
  return months;
}
function historicalRows(symbol,table,from,to) {
  const aliases={date:['date','tradedon'],open:['open','opening'],high:['high'],low:['low'],close:['close','closing'],volume:['volume','vol']};
  const normalize=s=>String(s).toLowerCase().replace(/[^a-z]/g,'');
  const heads=(table.headers??[]).map(normalize);
  const fields=Object.fromEntries(Object.entries(aliases).map(([k,values])=>[k,heads.findIndex(h=>values.includes(h))]));
  if(Object.values(fields).some(i=>i<0))throw Error('Historical table is missing required Date/Open/High/Low/Close/Volume columns');
  const parsed=[];let rejected=0;
  for(const cells of table.rows??[]){
    let date;
    try{date=sourceDate(cells[fields.date]);}catch{rejected++;continue;}
    if(!date){rejected++;continue;}
    if(date<from||date>to)continue;
    const numeric=k=>{
      const value=String(cells[fields[k]]??'').replace(/,/g,'').trim();
      return /^\d+(?:\.\d+)?$/.test(value)?Number(value):null;
    };
    const raw=[Date.parse(date+'T12:00:00+05:00')/1000,numeric('close'),numeric('volume'),numeric('open'),numeric('high'),numeric('low')];
    const bars=parseEod(symbol,[raw],to);
    if(bars.length)parsed.push({...bars[0],range_quality:'verified_ohlc'});else rejected++;
  }
  return {rows:[...new Map(parsed.map(r=>[r.traded_on,r])).values()].sort((a,b)=>a.traded_on.localeCompare(b.traded_on)),rejected};
}
async function persistMissing(sb,rows,dryRun){
  if(dryRun||!rows.length)return;
  // Existing candles are preserved, including rows written by another job.
  const {error}=await sb.from('historical_prices').upsert(rows,{onConflict:'symbol,traded_on',ignoreDuplicates:true});
  if(error)throw Error(`Historical backfill write: ${error.message}`);
}
module.exports={isoDate,sourceDate,monthsBetween,historicalRows,persistMissing};
