// indicators_test.ts -- run: deno test indicators_test.ts
//
// The REFERENCE block below is copied verbatim from backtest-signals/index.ts
// (sma, emaSeries, rsi14, scoreAt). The parity test proves indicators_lib.ts
// produces the exact same score + signal on the same data, so live signals
// and backtested signals are the same rule.

import { computeIndicators } from "./indicators_lib.ts";
import type { Bar } from "./indicators_lib.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

// ------------------------- REFERENCE (from backtest-signals) ---------------
const num = (v: unknown): number => {
  const f = Number(v);
  return Number.isFinite(f) ? f : 0;
};
const round2 = (v: number) => Math.round(v * 100) / 100;
function rsma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function remaSeries(vals: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function rrsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= 14; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  let ag = g / 14, al = l / 14;
  for (let i = 15; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * 13 + Math.max(d, 0)) / 14;
    al = (al * 13 + Math.max(-d, 0)) / 14;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function refScoreAt(bars: Bar[], cutoff: number): { score: number; signal: string } | null {
  const window = bars.slice(0, cutoff + 1);
  if (window.length < 20) return null;
  const closes = window.map((r) => r.close);
  const last = closes[closes.length - 1];
  const ema12 = remaSeries(closes, 12), ema26 = remaSeries(closes, 26);
  const macdSeries = ema12.map((v, i) => v - ema26[i]);
  const macdSignal = remaSeries(macdSeries, 9);
  const macd = macdSeries[macdSeries.length - 1];
  const macdSig = macdSignal[macdSignal.length - 1];
  const s20 = rsma(closes, 20), s50 = rsma(closes, 50), s200 = rsma(closes, 200);
  const rsi = rrsi14(closes);
  let bbU: number | null = null, bbL: number | null = null;
  if (s20 !== null && closes.length >= 20) {
    const w = closes.slice(-20);
    const sd = Math.sqrt(w.reduce((a, v) => a + (v - s20) ** 2, 0) / 20);
    bbU = s20 + 2 * sd; bbL = s20 - 2 * sd;
  }
  const w20 = window.slice(-20);
  const vsum = w20.reduce((a, r) => a + num(r.volume), 0);
  const avgVolume = vsum / 20;
  let score = 0;
  if (rsi !== null) score += rsi < 30 ? 25 : rsi > 70 ? -25 : (50 - rsi) * 0.5;
  if (s50 !== null) score += last > s50 ? 15 : -15;
  if (s200 !== null) score += last > s200 ? 15 : -15;
  score += macd > macdSig ? 20 : -20;
  if (bbL !== null && last < bbL) score += 10;
  if (bbU !== null && last > bbU) score -= 10;
  score = Math.max(-100, Math.min(100, round2(score)));
  let signal = score >= 50 ? "strong_buy" : score >= 20 ? "buy"
    : score <= -50 ? "strong_sell" : score <= -20 ? "sell" : "hold";
  if (avgVolume < 25000) {
    if (signal === "strong_buy" || signal === "buy") signal = "hold";
    if (signal === "strong_sell" || signal === "sell") signal = "hold";
  } else if (avgVolume < 100000) {
    if (signal === "strong_buy") signal = "buy";
    if (signal === "strong_sell") signal = "sell";
  }
  return { score, signal };
}
// ---------------------------------------------------------------------------

// deterministic PRNG so the test is reproducible
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBars(seed: number, n: number, baseVol: number, drift = 0): Bar[] {
  const rnd = mulberry32(seed);
  const out: Bar[] = [];
  let px = 50 + rnd() * 200;
  const start = new Date("2025-01-01T00:00:00Z").getTime();
  for (let i = 0; i < n; i++) {
    const ret = (rnd() - 0.5) * 0.06 + drift;
    const open = px;
    px = Math.max(1, px * (1 + ret));
    const hi = Math.max(open, px) * (1 + rnd() * 0.015);
    const lo = Math.min(open, px) * (1 - rnd() * 0.015);
    out.push({
      traded_on: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open, high: hi, low: lo, close: px,
      volume: Math.round(baseVol * (0.4 + rnd() * 1.6)),
    });
  }
  return out;
}

Deno.test("score + signal match backtest-signals scoreAt exactly", () => {
  let checked = 0;
  const seen = new Set<string>();
  // mix of liquidity levels (exercises the liquidity gate) and trends
  const vols = [10000, 60000, 500000, 5000000];
  const drifts = [-0.012, -0.004, 0, 0.004, 0.012];
  for (let seed = 1; seed <= 40; seed++) {
    const bars = makeBars(seed, 420, vols[seed % 4], drifts[seed % 5]);
    for (let cut = 19; cut < bars.length; cut += 7) {
      const ref = refScoreAt(bars, cut);
      const mine = computeIndicators(bars.slice(0, cut + 1));
      assert(ref && mine, `both must compute at cut ${cut}`);
      assert(ref!.score === mine!.signal_score, `score mismatch seed ${seed} cut ${cut}: ${ref!.score} vs ${mine!.signal_score}`);
      assert(ref!.signal === mine!.signal, `signal mismatch seed ${seed} cut ${cut}: ${ref!.signal} vs ${mine!.signal}`);
      seen.add(mine!.signal);
      checked++;
    }
  }
  console.log(`parity checked on ${checked} points; signals seen: ${[...seen].sort().join(", ")}`);
  assert(checked > 1000, "should check many points");
  assert(seen.has("strong_buy") && seen.has("strong_sell") && seen.has("buy") && seen.has("sell") && seen.has("hold"), `test data should hit all 5 buckets, saw: ${[...seen].join(",")}`);
});

Deno.test("returns null with fewer than 20 bars, computes at exactly 20", () => {
  const bars = makeBars(7, 40, 500000);
  assert(computeIndicators(bars.slice(0, 19)) === null, "19 bars -> null");
  assert(computeIndicators(bars.slice(0, 20)) !== null, "20 bars -> row");
});

Deno.test("sanity: ranges and ordering of derived columns", () => {
  const bars = makeBars(11, 300, 800000);
  const r = computeIndicators(bars)!;
  assert(r.computed_on === bars[bars.length - 1].traded_on, "computed_on = last bar date");
  assert(r.rsi_14! >= 0 && r.rsi_14! <= 100, "RSI in 0..100");
  assert(r.bb_lower! < r.bb_middle! && r.bb_middle! < r.bb_upper!, "BB ordered");
  assert(r.support! <= r.resistance!, "support <= resistance");
  assert(r.atr_14! > 0, "ATR positive");
  assert(Math.abs(r.macd_histogram - (r.macd_line - r.macd_signal)) < 1e-3, "hist = line - signal");
  assert(r.sma_200 !== null, "SMA200 present with 300 bars");
  assert(computeIndicators(bars.slice(0, 120))!.sma_200 === null, "SMA200 null with 120 bars");
});

Deno.test("RSI is 100 on a monotone rise", () => {
  const bars: Bar[] = Array.from({ length: 40 }, (_, i) => ({
    traded_on: `2025-02-${String((i % 28) + 1).padStart(2, "0")}`,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 500000,
  }));
  assert(computeIndicators(bars)!.rsi_14 === 100, "RSI = 100");
});

Deno.test("relative strength = stock 21d return minus index 21d return (pp)", () => {
  const bars = makeBars(3, 60, 500000);
  const a = bars[bars.length - 1], b = bars[bars.length - 1 - 21];
  // index is flat at 1000 except +5% between the two dates
  const idx = (d: string) => (d === a.traded_on ? 1050 : d === b.traded_on ? 1000 : 1000);
  const r = computeIndicators(bars, idx)!;
  const expected = ((a.close / b.close - 1) - 0.05) * 100;
  assert(Math.abs(r.rel_strength_1m! - expected) < 0.01, `rs ${r.rel_strength_1m} vs ${expected}`);
  assert(computeIndicators(bars, null)!.rel_strength_1m === null, "null without index history");
  assert(computeIndicators(bars, () => null)!.rel_strength_1m === null, "null when index missing on dates");
});

Deno.test("OBV divergence: price up + volume only on down days => bearish", () => {
  const bars: Bar[] = [];
  let px = 100;
  for (let i = 0; i < 60; i++) {
    // last 25 sessions: small rising days on tiny volume, sharp dips on huge volume
    const late = i >= 35;
    const up = late ? i % 3 !== 0 : true;
    const nextPx = up ? px * (late ? 1.012 : 1.002) : px * 0.985;
    bars.push({
      traded_on: `2025-03-${String((i % 28) + 1).padStart(2, "0")}-${i}`,
      open: px, high: Math.max(px, nextPx) * 1.005, low: Math.min(px, nextPx) * 0.995,
      close: nextPx, volume: late ? (up ? 20000 : 900000) : 300000,
    });
    px = nextPx;
  }
  const r = computeIndicators(bars)!;
  assert(r.obv_divergence === "bearish_divergence", `expected bearish, got ${r.obv_divergence}`);
});
