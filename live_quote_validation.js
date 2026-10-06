// Pure source validation shared by ingestion and regression tests.
'use strict';

const number = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const round = v => Math.round(v * 100) / 100;
function sessionDate(ts) {
  const n = number(ts);
  if (n == null || n <= 0) return null;
  const d = new Date(n * 1000 + 5 * 3600000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function validatedTicks(rows, date, now = Date.now()) {
  const unique = new Map();
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const ts = number(r[0]), price = number(r[1]), volume = number(r[2]);
    if (ts == null || price == null || price <= 0 || ts * 1000 > now + 60000 || sessionDate(ts) !== date) continue;
    if (volume != null && (!Number.isSafeInteger(volume) || volume < 0)) continue;
    unique.set(ts, [ts, price, volume]);
  }
  return [...unique.values()].sort((a, b) => b[0] - a[0]);
}
function quoteFromTicks(symbol, ticks, previousClose) {
  if (!ticks.length) return null;
  const base = number(previousClose);
  const last = ticks[0][1];
  return {
    symbol, last, open: ticks[ticks.length - 1][1],
    high: Math.max(...ticks.map(t => t[1])), low: Math.min(...ticks.map(t => t[1])),
    volume: ticks.every(t => t[2] != null) ? ticks.reduce((s, t) => s + t[2], 0) : null,
    ldcp: base > 0 ? base : null,
    change: base > 0 ? round(last - base) : null,
    change_pct: base > 0 ? round((last - base) / base * 100) : null,
    refreshed_at: new Date(ticks[0][0] * 1000).toISOString(), fresh: true,
  };
}
function parseEod(symbol, rows, latestDate) {
  const unique = new Map();
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const date = sessionDate(r[0]);
    const close = number(r[1]), volume = number(r[2]);
    const open = number(r[3]), high = number(r[4]), low = number(r[5]);
    // Never manufacture OHLC from a close-only series.
    if (!date || date > latestDate || close == null || close <= 0 || open == null || open <= 0 || high == null || low == null || low <= 0) continue;
    if (high < Math.max(open, close) || low > Math.min(open, close) || high < low) continue;
    if (volume == null || !Number.isSafeInteger(volume) || volume < 0) continue;
    unique.set(date, {symbol, traded_on: date, open, high, low, close, volume});
  }
  return [...unique.values()].sort((a, b) => a.traded_on.localeCompare(b.traded_on));
}
function freshQuoteRows(quotes) {
  return quotes.filter(q => q?.fresh === true && number(q.last) > 0 && Number.isFinite(Date.parse(q.refreshed_at)))
    .map(q => ({symbol: q.symbol, last_price: q.last, change: q.change, change_pct: q.change_pct,
      open: q.open, high: q.high, low: q.low, volume: q.volume, ldcp: q.ldcp, refreshed_at: q.refreshed_at}));
}
function quoteFromSnapshot(symbol, snapshot, date, now = Date.now()) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const match = String(snapshot?.date ?? '').match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/);
  if (!match || !months.includes(match[1])) return null;
  const month = months.indexOf(match[1]) + 1;
  const hour12 = Number(match[4]), minute = Number(match[5]);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = hour12 % 12 + (match[6] === 'PM' ? 12 : 0);
  const civil = `${match[3]}-${String(month).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  const timestamp = Date.parse(`${civil}T${String(hour).padStart(2,'0')}:${match[5]}:00+05:00`);
  if (civil !== date || !Number.isFinite(timestamp) || timestamp > now + 60000 || sessionDate(timestamp / 1000) !== civil) return null;
  const numeric = v => number(String(v ?? '').replace(/Rs\.?|[,\s]/g,''));
  const last = numeric(snapshot.close), open = numeric(snapshot.stats?.Open), high = numeric(snapshot.stats?.High), low = numeric(snapshot.stats?.Low);
  const volume = numeric(snapshot.stats?.Volume), base = numeric(snapshot.stats?.LDCP);
  if (!(last > 0 && open > 0 && high >= Math.max(open,last) && low > 0 && low <= Math.min(open,last))) return null;
  if (volume == null || !Number.isSafeInteger(volume) || volume < 0) return null;
  return {symbol,last,open,high,low,volume,ldcp:base > 0 ? base : null,
    change:base > 0 ? round(last-base) : null,change_pct:base > 0 ? round((last-base)/base*100) : null,
    refreshed_at:new Date(timestamp).toISOString(),fresh:true};
}
module.exports = {number, round, sessionDate, validatedTicks, quoteFromTicks, parseEod, freshQuoteRows, quoteFromSnapshot};
