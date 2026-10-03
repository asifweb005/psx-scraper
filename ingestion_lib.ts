// Pure source parsing and Pakistan trading-date rules, shared by both jobs.
export const pktDate = (ms = Date.now()) => new Date(ms + 5 * 3600000).toISOString().slice(0,10);
export function tradingDay(date: string, holidays: Set<string>): boolean {
  const day = new Date(date + "T00:00:00Z").getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(date);
}
export function expectedSession(now: number, holidays: Set<string>): string {
  const pkt = new Date(now + 5 * 3600000);
  let date = pktDate(now);
  // Until the final Friday close, the last completed session is yesterday.
  if (pkt.getUTCHours() < 17) date = pktDate(now - 86400000);
  while (!tradingDay(date, holidays)) date = pktDate(Date.parse(date+"T00:00:00Z") - 86400000 - 5*3600000);
  return date;
}
export function rows(payload: unknown): unknown[][] {
  const data = Array.isArray(payload) ? payload : (payload as {data?:unknown})?.data;
  if (!Array.isArray(data)) throw new Error("Source response does not contain a data array");
  return data as unknown[][];
}
export function positive(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid positive source value");
  return n;
}
export function timestamp(v: unknown): number {
  const n = positive(v);
  const ms = n < 1e11 ? n*1000 : n;
  if (!Number.isFinite(ms) || ms > Date.now()+60000 || ms < Date.UTC(2000,0,1)) throw new Error("Invalid source timestamp");
  return ms;
}
export function parseDaily(payload: unknown) {
  const out = new Map<string,{traded_on:string;open:number;high:number|null;low:number|null;close:number;volume:number|null;range_quality:string}>();
  for (const r of rows(payload)) {
    if (!Array.isArray(r) || r.length<2) throw new Error("Malformed daily record");
    const traded_on = pktDate(timestamp(r[0])), close=positive(r[1]);
    const open=r[3]==null ? close : positive(r[3]);
    const volume=r[2]==null ? null : Number(r[2]);
    if (volume!==null && (!Number.isSafeInteger(volume) || volume<0)) throw new Error("Invalid daily volume");
    // The PSX chart response documents close, volume, open, but no true daily high/low.
    out.set(traded_on,{traded_on,open,high:null,low:null,close,volume,range_quality:"close_open_only"});
  }
  return [...out.values()].sort((a,b)=>a.traded_on.localeCompare(b.traded_on));
}
export function parseTicks(payload: unknown) {
  const out = new Map<number,{ts:string;price:number}>();
  for (const r of rows(payload)) {
    if (!Array.isArray(r) || r.length<2) throw new Error("Malformed tick record");
    const ms=timestamp(r[0]);
    out.set(ms,{ts:new Date(ms).toISOString(),price:positive(r[1])});
  }
  return [...out.values()].sort((a,b)=>a.ts.localeCompare(b.ts));
}
