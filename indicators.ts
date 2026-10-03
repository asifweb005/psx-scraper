// indicators.ts -- recompute technical_indicators from historical_prices.
//
// Run after the EOD bar has been appended (chained in eod-sync.yml).
//
//   deno run --allow-net --allow-env indicators.ts                  # latest day
//   deno run --allow-net --allow-env indicators.ts --backfill 5     # last 5 trading days
//   deno run --allow-net --allow-env indicators.ts --dry-run        # compute, don't write
//   deno run --allow-net --allow-env indicators.ts --verify 2026-09-11
//        # READ-ONLY: recompute that date and diff against the rows already
//        # stored, per column. Use it to see how close these definitions are
//        # to whatever produced your existing rows.
//   Optional: --symbols PIOC,NETSOL   (limit to a few symbols)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional env (relative strength vs KSE-100 needs an index price history):
//   INDEX_TABLE (default index_history), INDEX_CODE (KSE100),
//   INDEX_CODE_COL (index_code), INDEX_DATE_COL (traded_on), INDEX_CLOSE_COL (close)
// If that table/columns don't exist, rel_strength_1m is left null with a warning.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Bar, IndexCloseLookup, IndicatorRow } from "./indicators_lib.ts";
import { computeIndicators } from "./indicators_lib.ts";

const SB = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const INDEX_TABLE = Deno.env.get("INDEX_TABLE") ?? "index_history";
const INDEX_CODE = Deno.env.get("INDEX_CODE") ?? "KSE100";
const INDEX_CODE_COL = Deno.env.get("INDEX_CODE_COL") ?? "index_code";
const INDEX_DATE_COL = Deno.env.get("INDEX_DATE_COL") ?? "traded_on";
const INDEX_CLOSE_COL = Deno.env.get("INDEX_CLOSE_COL") ?? "close";
const BARS_PER_SYMBOL = 400; // enough for SMA200 + indicator warm-up

const args = Deno.args;
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const num = (v: unknown): number => {
  const f = Number(v);
  return Number.isFinite(f) ? f : 0;
};

async function activeSymbols(): Promise<string[]> {
  const only = opt("--symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (only?.length) return only;
  const { data, error } = await SB.from("stocks").select("symbol").eq("is_active", true).order("symbol");
  if (error) throw error;
  return (data ?? []).map((r: { symbol: string }) => r.symbol);
}

async function loadBars(symbol: string): Promise<Bar[]> {
  // Newest N bars (descending), then reverse -> oldest first.
  const { data, error } = await SB.from("historical_prices")
    .select("traded_on, open, high, low, close, volume, range_quality")
    .eq("symbol", symbol)
    .order("traded_on", { ascending: false })
    .limit(BARS_PER_SYMBOL);
  if (error) throw error;
  return (data ?? []).reverse().map((r: Record<string, unknown>) => ({
    traded_on: String(r.traded_on),
    open: num(r.open), high: r.range_quality === "verified_ohlc" ? num(r.high) : 0, low: r.range_quality === "verified_ohlc" ? num(r.low) : 0,
    close: num(r.close), volume: num(r.volume),
  }));
}

async function loadIndexLookup(): Promise<IndexCloseLookup | null> {
  try {
    const { data, error } = await SB.from(INDEX_TABLE)
      .select(`${INDEX_DATE_COL}, ${INDEX_CLOSE_COL}`)
      .eq(INDEX_CODE_COL, INDEX_CODE)
      .order(INDEX_DATE_COL, { ascending: false })
      .limit(600);
    if (error || !data?.length) {
      console.warn(`[warn] no index history in ${INDEX_TABLE} (${error?.message ?? "empty"}); rel_strength_1m will be null`);
      return null;
    }
    const rows = (data as Record<string, unknown>[]).reverse()
      .map((r) => ({ d: String(r[INDEX_DATE_COL]).slice(0, 10), c: num(r[INDEX_CLOSE_COL]) }))
      .filter((r) => r.c > 0);
    return (date: string) => {
      // last index close on or before `date`
      let lo = 0, hi = rows.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].d <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans >= 0 && (Date.parse(date)-Date.parse(rows[ans].d)) <= 4*86400000 ? rows[ans].c : null;
    };
  } catch (e) {
    console.warn(`[warn] index history unavailable: ${String(e).slice(0, 120)}`);
    return null;
  }
}

/** Real column list of technical_indicators (so a wrong column name can't break the insert). */
async function tableColumns(): Promise<{ cols: Set<string>; timeframe: string }> {
  const { data, error } = await SB.from("technical_indicators")
    .select("*").order("computed_on", { ascending: false }).limit(1);
  if (error) throw error;
  const row = data?.[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("technical_indicators is empty; cannot detect columns/timeframe. Insert one row manually first.");
  }
  return { cols: new Set(Object.keys(row)), timeframe: String(row.timeframe ?? "1d") };
}

const NUM_COLS: (keyof IndicatorRow)[] = [
  "sma_20", "sma_50", "sma_200", "ema_12", "ema_26", "ema_50", "rsi_14",
  "macd_line", "macd_signal", "macd_histogram", "bb_upper", "bb_middle",
  "bb_lower", "atr_14", "obv", "vwap", "support", "resistance", "signal_score",
];

// ---------------------------------------------------------------- verify --
async function verify(date: string) {
  const symbols = await activeSymbols();
  const idx = await loadIndexLookup();
  const stats = new Map<string, { n: number; over01: number; over1: number; maxPct: number }>();
  let compared = 0, signalSame = 0;

  for (const sym of symbols) {
    const bars = await loadBars(sym);
    const end = bars.findIndex((b) => b.traded_on === date);
    if (end < 0) continue;
    const mine = computeIndicators(bars.slice(0, end + 1), idx);
    const { data } = await SB.from("technical_indicators").select("*")
      .eq("symbol", sym).eq("computed_on", date).limit(1);
    const stored = data?.[0] as Record<string, unknown> | undefined;
    if (!mine || !stored) continue;
    compared++;
    if (mine.signal === stored.signal) signalSame++;
    const close = bars[end].close;
    for (const col of NUM_COLS) {
      const a = mine[col] as number | null;
      const b = stored[col] == null ? NaN : Number(stored[col]);
      if (a === null || !Number.isFinite(b)) continue;
      // relative to the stored value, floored at 0.5% of price so values near
      // zero (MACD histogram) don't blow up the percentage.
      const denom = Math.max(Math.abs(b), Math.abs(close) * 0.005, 1e-9);
      const pct = Math.abs(a - b) / denom * 100;
      const s = stats.get(col) ?? { n: 0, over01: 0, over1: 0, maxPct: 0 };
      s.n++;
      if (pct > 0.1) s.over01++;
      if (pct > 1) s.over1++;
      s.maxPct = Math.max(s.maxPct, pct);
      stats.set(col, s);
    }
  }

  console.log(`\nVERIFY ${date}: compared ${compared} symbols`);
  console.log(`signal label identical: ${signalSame}/${compared}`);
  console.log("column           compared  >0.1%  >1%   max%");
  for (const col of NUM_COLS) {
    const s = stats.get(col);
    if (!s) { console.log(`${String(col).padEnd(16)} (no comparable values)`); continue; }
    console.log(
      `${String(col).padEnd(16)} ${String(s.n).padStart(8)} ${String(s.over01).padStart(6)} ${String(s.over1).padStart(5)} ${s.maxPct.toFixed(2).padStart(7)}`,
    );
  }
  console.log("\nColumns with many >1% diffs use a different definition than mine;");
  console.log("paste this output back and the definition can be aligned.");
}

// ------------------------------------------------------------------ run ---
async function run(backfill: number, dry: boolean): Promise<string> {
  const { cols, timeframe } = await tableColumns();
  const symbols = await activeSymbols();
  const idx = await loadIndexLookup();

  const rows: Record<string, unknown>[] = [];
  let skipped = 0, rsPopulated = 0;
  const dropped = new Set<string>();

  for (const sym of symbols) {
    const bars = await loadBars(sym);
    if (bars.length < 20) { skipped++; continue; }
    for (let k = 0; k < backfill; k++) {
      const end = bars.length - k;
      if (end < 20) break;
      const r = computeIndicators(bars.slice(0, end), idx);
      if (!r) continue;
      if (r.rel_strength_1m !== null) rsPopulated++;
      const full: Record<string, unknown> = { symbol: sym, timeframe, ...r };
      const row: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(full)) {
        if (cols.has(key)) row[key] = val; else dropped.add(key);
      }
      rows.push(row);
    }
  }
  if (!rows.length) throw new Error("no indicator rows computed (no historical_prices?)");

  const dates = [...new Set(rows.map((r) => r.computed_on as string))].sort();
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.signal as string] = (counts[r.signal as string] ?? 0) + 1;

  const newest = dates[dates.length - 1];
  const ageDays = (Date.now() - new Date(newest).getTime()) / 86400000;
  if (ageDays > 4) throw new Error(`Newest bar is stale: ${newest}; ingestion must catch up first`);
  if (dropped.size) console.warn(`[warn] not in table, skipped: ${[...dropped].join(", ")}`);
  const stored = new Set(Object.keys(rows[0]));
  const uncomputed = [...cols].filter((c) =>
    !stored.has(c) && !["id", "created_at", "updated_at"].includes(c)
  );
  if (uncomputed.length) console.warn(`[warn] table columns this job does not fill: ${uncomputed.join(", ")}`);

  const detail =
    `indicators: ${rows.length} rows, ${symbols.length - skipped}/${symbols.length} symbols, ` +
    `dates ${dates[0]}..${newest}, rs ${rsPopulated}/${rows.length}, signals ${JSON.stringify(counts)}`;

  if (dry) { console.log(`[dry-run] ${detail}`); console.log(rows[0]); return `dry-run ${detail}`; }

  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await SB.from("technical_indicators").upsert(rows.slice(i,i+100), { onConflict: "symbol,computed_on,timeframe" });
    if (error) throw error;
  }
  return detail;
}

async function main() {
  // Always print something, so a silent run can never look like success.
  console.log(`indicators.ts started, args=${JSON.stringify(Deno.args)}`);
  const verifyDate = opt("--verify");
  if (verifyDate) { await verify(verifyDate); return; }
  const dry = flag("--dry-run");
  const backfill = Math.max(1, Math.min(60, Number(opt("--backfill") ?? 1) || 1));
  try {
    const detail = await run(backfill, dry);
    if (!dry) await SB.from("sync_log").insert({ job: "indicators", status: "ok", detail });
    console.log(`OK: ${detail}`);
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e).slice(0, 500);
    if (!dry) await SB.from("sync_log").insert({ job: "indicators", status: "error", detail: msg });
    console.error(`ERROR: ${msg}`);
    Deno.exit(1);
  }
}

main();
