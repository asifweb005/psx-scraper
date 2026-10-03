// indicators_lib.ts -- pure indicator math, no network / DB access.
//
// score + signal are an EXACT copy of the formula in backtest-signals'
// scoreAt() (RSI / SMA50 / SMA200 / MACD / Bollinger + liquidity gate on the
// label), so live signals and backtested signals are the same rule.
//
// Columns the backtest does not define (ATR, OBV, VWAP, support/resistance,
// relative strength, OBV divergence) use the conventional definitions below.
// If you have the original psx-sync definitions, run `--verify` (see
// indicators.ts) to see how far these differ from what is stored.

export interface Bar {
  traded_on: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorRow {
  computed_on: string;
  sma_20: number | null;
  sma_50: number | null;
  sma_200: number | null;
  ema_12: number;
  ema_26: number;
  ema_50: number | null;
  rsi_14: number | null;
  macd_line: number;
  macd_signal: number;
  macd_histogram: number;
  bb_upper: number | null;
  bb_middle: number | null;
  bb_lower: number | null;
  atr_14: number | null;
  obv: number;
  vwap: number | null;
  support: number | null;
  resistance: number | null;
  signal: string;
  signal_score: number;
  rel_strength_1m: number | null;
  obv_divergence: string | null;
}

/** Returns the index close on or before `date`, or null. */
export type IndexCloseLookup = (date: string) => number | null;

const num = (v: unknown): number => {
  const f = Number(v);
  return Number.isFinite(f) ? f : 0;
};
const round = (v: number, d = 4) => {
  const m = 10 ** d;
  return Math.round(v * m) / m;
};
const orNull = (v: number | null, d = 4) => (v === null ? null : round(v, d));

export function sma(vals: number[], n: number): number | null {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((a, b) => a + b, 0) / n;
}

export function emaSeries(vals: number[], n: number): number[] {
  const k = 2 / (n + 1), out: number[] = [];
  let prev = vals[0] ?? 0;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[0] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function rsi14(closes: number[]): number | null {
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
  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

/** Wilder ATR(14). */
export function atr14(bars: Bar[]): number | null {
  if (bars.length < 15) return null;
  const tr = (i: number) =>
    Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  let atr = 0;
  for (let i = 1; i <= 14; i++) atr += tr(i);
  atr /= 14;
  for (let i = 15; i < bars.length; i++) atr = (atr * 13 + tr(i)) / 14;
  return atr;
}

/** Cumulative on-balance volume over the supplied window. */
export function obvSeries(bars: Bar[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    out.push(out[i - 1] + (d > 0 ? bars[i].volume : d < 0 ? -bars[i].volume : 0));
  }
  return out;
}

/** 20-session rolling VWAP using the typical price (H+L+C)/3. */
export function vwap20(bars: Bar[]): number | null {
  const w = bars.slice(-20);
  let pv = 0, v = 0;
  for (const b of w) {
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

/** Support / resistance = lowest low / highest high of the last 20 sessions. */
export function supportResistance(
  bars: Bar[],
): { support: number | null; resistance: number | null } {
  const w = bars.slice(-20);
  const lows = w.map((b) => b.low).filter((x) => x > 0);
  const highs = w.map((b) => b.high).filter((x) => x > 0);
  return {
    support: lows.length ? Math.min(...lows) : null,
    resistance: highs.length ? Math.max(...highs) : null,
  };
}

/**
 * Compute the indicator row for the LAST bar of `bars` (ascending order,
 * oldest first; must end on the day being computed). Returns null with fewer
 * than 20 bars, matching backtest-signals.
 *
 * relative strength: stock 21-session return minus KSE-100 return over the
 * same two dates, in percentage points (null when index history is missing).
 */
export function computeIndicators(
  bars: Bar[],
  indexClose: IndexCloseLookup | null = null,
): IndicatorRow | null {
  if (bars.length < 20) return null;
  if (bars.some((b,i) => !Number.isFinite(b.close) || b.close <= 0 || !Number.isFinite(b.volume) || b.volume < 0 || (i > 0 && b.traded_on <= bars[i-1].traded_on))) throw new Error("Invalid or unordered indicator bars");

  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];

  const ema12 = emaSeries(closes, 12), ema26 = emaSeries(closes, 26);
  const ema50 = emaSeries(closes, 50);
  const macdSeries = ema12.map((v, i) => v - ema26[i]);
  const macdSignal = emaSeries(macdSeries, 9);
  const macd = macdSeries[macdSeries.length - 1];
  const macdSig = macdSignal[macdSignal.length - 1];

  const s20 = sma(closes, 20), s50 = sma(closes, 50), s200 = sma(closes, 200);
  const rsi = rsi14(closes);

  let bbU: number | null = null, bbL: number | null = null;
  if (s20 !== null) {
    const w = closes.slice(-20);
    const sd = Math.sqrt(w.reduce((a, v) => a + (v - s20) ** 2, 0) / 20);
    bbU = s20 + 2 * sd;
    bbL = s20 - 2 * sd;
  }

  const w20 = bars.slice(-20);
  const avgVolume = w20.reduce((a, r) => a + num(r.volume), 0) / 20;

  // ---- score: identical to backtest-signals scoreAt() ----
  let score = 0;
  if (rsi !== null) score += rsi < 30 ? 25 : rsi > 70 ? -25 : (50 - rsi) * 0.5;
  if (s50 !== null) score += last > s50 ? 15 : last < s50 ? -15 : 0;
  if (s200 !== null) score += last > s200 ? 15 : last < s200 ? -15 : 0;
  score += macd > macdSig ? 20 : macd < macdSig ? -20 : 0;
  if (bbL !== null && last < bbL) score += 10;
  if (bbU !== null && last > bbU) score -= 10;
  score = Math.max(-100, Math.min(100, Math.round(score * 100) / 100));

  let signal = score >= 50 ? "strong_buy" : score >= 20 ? "buy"
    : score <= -50 ? "strong_sell" : score <= -20 ? "sell" : "hold";

  // Liquidity gate on the label only (same thresholds as backtest-signals).
  if (avgVolume < 25000) {
    if (signal === "strong_buy" || signal === "buy") signal = "hold";
    if (signal === "strong_sell" || signal === "sell") signal = "hold";
  } else if (avgVolume < 100000) {
    if (signal === "strong_buy") signal = "buy";
    if (signal === "strong_sell") signal = "sell";
  }

  // ---- extras ----
  const obv = obvSeries(bars);
  const validRanges = bars.every(b => b.low > 0 && b.high >= Math.max(b.open,b.close) && b.low <= Math.min(b.open,b.close));
  const { support, resistance } = validRanges ? supportResistance(bars) : { support: null, resistance: null };

  // Relative strength vs KSE-100 over 21 sessions (percentage points).
  let rel: number | null = null;
  if (indexClose && bars.length > 21) {
    const a = bars[bars.length - 1], b = bars[bars.length - 1 - 21];
    const ia = indexClose(a.traded_on), ib = indexClose(b.traded_on);
    if (ia && ib && b.close > 0) {
      rel = ((a.close / b.close - 1) - (ia / ib - 1)) * 100;
    }
  }

  // OBV divergence over 20 sessions: price and OBV moving opposite ways.
  let div: string | null = null;
  if (bars.length > 20) {
    const pBase = closes[closes.length - 21];
    const priceChgPct = pBase > 0 ? (last / pBase - 1) * 100 : 0;
    const obvChg = obv[obv.length - 1] - obv[obv.length - 21];
    if (priceChgPct > 2 && obvChg < 0) div = "bearish_divergence";
    else if (priceChgPct < -2 && obvChg > 0) div = "bullish_divergence";
  }

  return {
    computed_on: bars[bars.length - 1].traded_on,
    sma_20: orNull(s20), sma_50: orNull(s50), sma_200: orNull(s200),
    ema_12: round(ema12[ema12.length - 1]),
    ema_26: round(ema26[ema26.length - 1]),
    // null with < 50 bars (an EMA seeded on a short series is misleading; the
    // rows your old pipeline stored were null here too)
    ema_50: closes.length >= 50 ? round(ema50[ema50.length - 1]) : null,
    rsi_14: orNull(rsi),
    macd_line: round(macd), macd_signal: round(macdSig),
    macd_histogram: round(macd - macdSig),
    bb_upper: orNull(bbU), bb_middle: orNull(s20), bb_lower: orNull(bbL),
    atr_14: validRanges ? orNull(atr14(bars)) : null,
    obv: Math.round(obv[obv.length - 1]),
    vwap: validRanges ? orNull(vwap20(bars)) : null,
    support: orNull(support), resistance: orNull(resistance),
    signal, signal_score: score,
    rel_strength_1m: orNull(rel, 2),
    obv_divergence: div,
  };
}
