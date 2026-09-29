import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

let diagnosticReason = "Unknown error. Could not fetch valid data.";
let consecutiveBlocks = 0;
let breakerTripped = false;
const BREAKER_THRESHOLD = 15;

// 1. Private Google Server Proxy (Bypasses Cloudflare & Geo-blocks)
// PASTE YOUR GOOGLE SCRIPT URL HERE:
const GOOGLE_PROXY = "https://script.google.com/macros/s/AKfycbxrLBJreQnheCy4KUDuVl49Xn7W8WE22gD2ErMAwo8iQ-TK8oZFQ6K3rfAAglgRPQzJ/exec";

async function psxJson(path: string, timeoutMs = 15000): Promise<unknown[]> {
  if (breakerTripped) throw new Error(diagnosticReason);
  
  const sep = path.includes("?") ? "&" : "?";
  const targetUrl = `https://dps.psx.com.pk${path}${sep}_t=${Math.floor(Date.now() / 60000)}`;
  
  const fetchUrl = `${GOOGLE_PROXY}?url=${encodeURIComponent(targetUrl)}`;

  let r: Response | null = null;
  try {
    r = await fetch(fetchUrl, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await r.text();
    
    if (r.ok) {
      const trimmed = text.trim();
      if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed);
        const finalArray = Array.isArray(parsed) ? parsed : (parsed?.data ?? null);
        
        if (finalArray && Array.isArray(finalArray)) {
          consecutiveBlocks = 0; 
          return finalArray;
        }
      }
      diagnosticReason = `Google Proxy returned invalid JSON. Body: ${trimmed.slice(0, 60)}...`;
    } else {
      // We now log the exact body of the 403 so we know if it's Google Auth or Cloudflare
      diagnosticReason = `Google Proxy HTTP ${r.status}. Body: ${text.slice(0, 100).replace(/\n/g, ' ')}`;
    }
  } catch (e) {
    diagnosticReason = `Google Proxy Failed: ${String(e).slice(0, 100)}`;
  }
  
  if (++consecutiveBlocks >= BREAKER_THRESHOLD) {
    breakerTripped = true;
    diagnosticReason = `BREAKER TRIPPED. Last Error: ${diagnosticReason}`;
  }
  
  throw new Error(diagnosticReason);
}

const num = (v: unknown): number => { const f = Number(v); return Number.isFinite(f) ? f : 0; };
const round2 = (v: number) => Math.round(v * 100) / 100;
const n2 = (v: number | null | undefined) => (v == null ? null : round2(v));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const todayStr = () => { const d = new Date(); d.setUTCHours(d.getUTCHours() + 5); return d.toISOString().slice(0, 10); };

async function trackedSymbols(): Promise<string[]> {
  const { data, error } = await SB.from("stocks").select("symbol").eq("is_active", true).order("symbol");
  if (error) throw error;
  return (data ?? []).map((r) => r.symbol);
}

interface Bar { symbol: string; traded_on: string; open: number; high: number; low: number; close: number; volume: number; prev_close: number | null; }

async function latestBars(): Promise<Map<string, Bar>> {
  const { data } = await SB.from("v_latest_bars").select("symbol, traded_on, open, high, low, close, volume, prev_close");
  const m = new Map<string, Bar>();
  for (const r of (data ?? [])) { m.set(r.symbol, { symbol: r.symbol, traded_on: r.traded_on, open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume), prev_close: r.prev_close == null ? null : num(r.prev_close) }); }
  return m;
}

interface DayQuote { symbol: string; last: number; open: number; high: number; low: number; volume: number; ldcp: number; change: number; change_pct: number; fresh: boolean; }

async function buildQuote(sym: string, bar?: Bar): Promise<DayQuote | null> {
  const today = todayStr();
  const ldcpFromBar = bar ? (bar.traded_on === today ? (bar.prev_close ?? bar.close) : bar.close) : 0;
  
  let intraday: number[][] = [];
  try {
    intraday = await psxJson(`/timeseries/int/${sym}`) as number[][];
    if (intraday.length) {
       const tickDate = new Date(num(intraday[0][0]) * 1000);
       tickDate.setUTCHours(tickDate.getUTCHours() + 5);
       if (tickDate.toISOString().slice(0, 10) !== today) intraday = []; 
    }
  } catch (e) { intraday = []; }

  if (!intraday.length) {
    const currentUtc = new Date().getUTCHours();
    const isMarketOpen = currentUtc >= 4 && currentUtc < 11;

    if (!isMarketOpen) {
      try {
        const eod = await psxJson(`/timeseries/eod/${sym}`) as number[][];
        if (eod.length) {
          const rec = eod[0];
          const eodDate = new Date(num(rec[0]) * 1000);
          eodDate.setUTCHours(eodDate.getUTCHours() + 5); 
          if (eodDate.toISOString().slice(0, 10) === today) {
            const close = num(rec[1]);
            const volume = num(rec[2]);
            const open = num(rec[3]) || close;
            const high = num(rec[4]) || Math.max(open, close);
            const low = num(rec[5]) || Math.min(open, close);
            const base = ldcpFromBar || open;
            return { symbol: sym, last: close, open, high, low, volume, ldcp: base, change: round2(close - base), change_pct: base ? round2((close - base) / base * 100) : 0, fresh: true };
          }
        }
      } catch (e) {}
    }

    if (!bar) return null;
    const base = bar.prev_close ?? bar.close;
    return { symbol: sym, last: bar.close, open: bar.close, high: bar.close, low: bar.close, volume: 0, ldcp: base, change: 0, change_pct: 0, fresh: false };
  }

  let high = -Infinity, low = Infinity, volume = 0;
  for (const t of intraday) {
    const p = num(t[1]);
    if (p <= 0) continue;
    if (p > high) high = p;
    if (p < low) low = p;
    volume += num(t[2]);
  }
  const last = num(intraday[0][1]);
  const open = num(intraday[intraday.length - 1][1]);
  if (last <= 0) return null;
  const base = ldcpFromBar || open;
  return { symbol: sym, last, open, high, low, volume, ldcp: base, change: round2(last - base), change_pct: base ? round2((last - base) / base * 100) : 0, fresh: true };
}

async function pmap<T, R>(items: T[], size: number, fn: (t: T) => Promise<R | null>, delayMs = 500): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    if (breakerTripped) break;
    const chunk = await Promise.all(items.slice(i, i + size).map((x) => fn(x)));
    for (const c of chunk) if (c) out.push(c);
    if (i + size < items.length) await sleep(delayMs);
  }
  return out;
}

async function syncQuotes(): Promise<string> {
  const syms = await trackedSymbols();
  const bars = await latestBars();
  
  // Luxury Pacing
  const quotes = await pmap(syms, 2, (s) => buildQuote(s, bars.get(s)), 800);

  if (!quotes.length) throw new Error(diagnosticReason);

  const fresh = quotes.filter((q) => q.fresh);
  const holding = quotes.length - fresh.length;

  if (!fresh.length) {
    throw new Error(
      breakerTripped
        ? `FEED BLOCKED: ${diagnosticReason}`
        : `No fresh quotes today. Market closed or holiday?`,
    );
  }

  const rows = fresh.map((q) => ({ symbol: q.symbol, last_price: q.last, change: q.change, change_pct: q.change_pct, open: q.open, high: q.high, low: q.low, volume: q.volume, ldcp: q.ldcp, refreshed_at: new Date().toISOString() }));
  const { error } = await SB.from("market_quotes").upsert(rows);
  if (error) throw error;

  return `upserted ${rows.length}/${syms.length} fresh quotes ${holding > 0 ? "(" + holding + " held)" : ""}`;
}

async function syncIndex(): Promise<string> {
  const today = todayStr();
  let row: Record<string, unknown> | null = null;
  
  let ticks: number[][] = [];
  try {
    ticks = await psxJson(`/timeseries/int/KSE100`) as number[][];
    if (ticks.length) {
       const tickDate = new Date(num(ticks[0][0]) * 1000);
       tickDate.setUTCHours(tickDate.getUTCHours() + 5);
       if (tickDate.toISOString().slice(0, 10) !== today) ticks = [];
    }
  } catch (e) { ticks = []; }

  if (ticks.length) {
    let high = -Infinity, low = Infinity;
    for (const t of ticks) {
      const p = num(t[1]);
      if (p > high) high = p;
      if (p > 0 && p < low) low = p;
    }
    const last = num(ticks[0][1]);
    const open = num(ticks[ticks.length - 1][1]);
    row = {
      index_code: "KSE100", name: "KSE-100 Index", last_value: last, high, low,
      change: round2(last - open), change_pct: round2(open ? ((last - open) / open) * 100 : 0),
      refreshed_at: new Date().toISOString(),
    };
  }
  
  const { data: q } = await SB.from("market_quotes").select("change_pct");
  if (q?.length) {
    const adv = q.filter((r) => num(r.change_pct) > 0).length;
    const dec = q.filter((r) => num(r.change_pct) < 0).length;
    row = {
      ...(row ?? { index_code: "KSE100", name: "KSE-100 Index", last_value: 0 }),
      advancers: adv, decliners: dec, unchanged: q.length - adv - dec,
    };
  }
  if (!row) return "index: nothing to write";
  const { error } = await SB.from("index_quotes").upsert(row);
  if (error) throw error;
  return "index updated";
}

async function syncEod(): Promise<string> {
  const dow = new Date().getUTCDay();
  const { data: mq } = await SB.from("market_quotes").select("*");
  let appended = 0;
  if (dow !== 0 && dow !== 6) {
    const today = todayStr();
    const rows = (mq ?? [])
      .filter((q) => num(q.last_price) > 0 && String(q.refreshed_at).slice(0, 10) === today)
      .filter((q) => {
        const o = num(q.open), h = num(q.high), l = num(q.low), c = num(q.last_price);
        const flat = o === h && h === l && l === c;
        return !(flat && num(q.volume) === 0);
      })
      .map((q) => ({
        symbol: q.symbol, traded_on: today, open: num(q.open), high: num(q.high),
        low: num(q.low), close: num(q.last_price), volume: num(q.volume),
      }));
    if (rows.length) {
      const { error } = await SB.from("historical_prices").upsert(rows, { onConflict: "symbol,traded_on" });
      if (error) throw error;
      appended = rows.length;
    }
  }
  return `eod: ${appended} bars appended`;
}

// 3. Command Line Interface Trigger for GitHub Actions
async function main() {
  const action = Deno.args[0] || "quotes";
  console.log(`Starting PSX Sync Job: ${action}...`);
  
  try {
    let detail = "";
    if (action === "quotes") detail = `${await syncQuotes()}; ${await syncIndex()}`;
    else if (action === "eod") detail = await syncEod();
    else if (action === "index") detail = await syncIndex();
    else {
      console.error("Unknown action.");
      Deno.exit(1);
    }
    
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "ok", detail });
    console.log(`✅ Success: ${detail}`);
  } catch (e) {
    const msg = String(e).slice(0, 500);
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "error", detail: msg });
    console.error(`❌ Error: ${msg}`);
    
    // Clean exit logic
    if (msg.includes("BREAKER TRIPPED") || msg.includes("No fresh quotes")) {
      console.log("ℹ️ Exiting cleanly to prevent GitHub Actions failure spam.");
      Deno.exit(0); 
    } else {
      Deno.exit(1); 
    }
  }
}

main();
