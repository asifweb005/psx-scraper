// fundamentals_lib.ts -- pure parsing of the scstrade "Company Snapshot" page.
// No network / DB access, so it can be unit-tested (see fundamentals_test.ts).
//
// Same approach as before (labels are located contiguously, then the value
// tokens after them are read by position) with four hardening changes:
//   1. numFromToken strips thousands separators ("Rs. 1,234.50" was read as 1).
//   2. TOKEN_RE also matches negative rupee values ("Rs. -5.20"); before, a
//      loss-making company lost tokens and every later value shifted left.
//   3. Each value must have the UNIT its position implies (P/E is "x",
//      ROE and yield are "%", EPS is "Rs."). A shifted row usually lands on a
//      different unit, so the value is dropped instead of stored wrong.
//   4. Plausibility ranges (e.g. dividend yield 0..25%), plus: a loss-making
//      company (EPS < 0) never keeps a P/E, because its P/E cell is normally
//      blank and the neighbouring "expected P/E" would be read instead.
//
// LIMIT: a shift that lands on a token of the SAME unit and in range cannot be
// detected from flattened text. The reliable fix is to parse table cells from
// the raw HTML (needs a sample page). Rejections are counted so drift is visible.

export function toPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_LABEL_GAP = 20;
// Rs. values (optionally negative), percentages, and multiples ("8.2x").
export const TOKEN_RE = /Rs\.\s*-?[\d,]+\.?\d*|-?\d+(?:\.\d+)?\s*%|-?\d+(?:\.\d+)?\s*x\b/gi;

export function extractRow(text: string, labels: string[]): string[] | null {
  const lower = text.toLowerCase();
  let cursor = lower.indexOf(labels[0].toLowerCase());
  if (cursor === -1) return null;
  cursor += labels[0].length;

  for (let i = 1; i < labels.length; i++) {
    const window = lower.slice(cursor, cursor + MAX_LABEL_GAP + labels[i].length);
    const idx = window.indexOf(labels[i].toLowerCase());
    if (idx === -1) return null;
    cursor += idx + labels[i].length;
  }

  const valueRegion = text.slice(cursor, cursor + 2500);
  const tokens = valueRegion.match(TOKEN_RE) ?? [];
  return tokens.length >= labels.length ? tokens : null;
}

/** Numeric value of a token; clamps extremes to avoid numeric overflow in Postgres. */
export function numFromToken(token: string | undefined): number | null {
  if (!token) return null;
  const m = token.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const val = parseFloat(m[0]);
  if (!Number.isFinite(val)) return null;
  if (val > 99999.99) return 99999.99;
  if (val < -99999.99) return -99999.99;
  return Math.round(val * 100) / 100;
}

type Kind = "rs" | "pct" | "x";
export function kindOf(token: string): Kind {
  if (token.includes("%")) return "pct";
  if (/^rs\./i.test(token.trim())) return "rs";
  return "x";
}

export const EARNINGS_LABELS = [
  "Latest EPS Upto", "EPS Last Quarter", "Last Annual EPS Upto",
  "Price To Earning P/E Upto", "Exp Price To Earning P/E Upto",
  "Exp Earning Gowth Upto", "Price Earning Growth Upto",
];
export const EQUITY_LABELS = [
  "Book Value Upto", "Exp Book Value Upto", "Book Value Growth Upto",
  "Exp Book Value Growth Upto", "Price To Book Value Upto",
  "Exp Price To Book Value Upto", "Return On Equity Upto",
  "Exp Return On Equity Upto", "Retention Ratio Upto",
  "Exp Retention Ratio Upto", "Equity To Assets Ratio Upto",
  "Return On Assets Upto", "Return On Cap Employed Upto",
];
export const DIVIDENDS_LABELS = [
  "Latest Dividend Upto", "Dividend Last Quarter", "Last Annual Dividend Upto",
  "Dividend Yield Upto", "Expected Dividend Upto", "Expected Dividend Yield Upto",
  "Expected Dividend Growth Upto", "Dividend Cover Upto", "Payout Ratio Upto",
  "Expected Payout Ratio Upto",
];
export const SOLVENCY_LABELS = [
  "Long Debt To Equity", "Total Debt To Equity",
  "Long Debt To Assets Upto", "Total Debt To Assets Upto",
];

export interface Ratios {
  eps: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
}

// field -> [row index, required unit (null = any), min, max]
const SPEC = {
  eps:           { idx: 0, kind: "rs",  lo: -5000, hi: 20000 },
  peRatio:       { idx: 3, kind: "x",   lo: -1000, hi: 2000 },
  pbRatio:       { idx: 4, kind: "x",   lo: -100,  hi: 500 },
  roe:           { idx: 6, kind: "pct", lo: -500,  hi: 500 },
  dividendYield: { idx: 3, kind: "pct", lo: 0,     hi: 25 },
  debtToEquity:  { idx: 1, kind: null,  lo: 0,     hi: 5000 },
} as const;

function pick(
  tokens: string[] | null,
  field: keyof typeof SPEC,
  rejected: string[],
): number | null {
  const s = SPEC[field];
  const t = tokens?.[s.idx];
  if (!t) return null;
  if (s.kind && kindOf(t) !== s.kind) { rejected.push(`${field}:unit`); return null; }
  const v = numFromToken(t);
  if (v === null) return null;
  if (v < s.lo || v > s.hi) { rejected.push(`${field}:range`); return null; }
  return v;
}

export function extractRatios(html: string): { ratios: Ratios; rejected: string[] } {
  const text = toPlainText(html);
  const rejected: string[] = [];

  const earnings = extractRow(text, EARNINGS_LABELS);
  const equity = extractRow(text, EQUITY_LABELS);
  const dividends = extractRow(text, DIVIDENDS_LABELS);
  const solvency = extractRow(text, SOLVENCY_LABELS);

  const eps = pick(earnings, "eps", rejected);
  let peRatio = pick(earnings, "peRatio", rejected);
  // Loss-maker: its P/E cell is normally blank, so position 3 would be the
  // neighbouring "expected P/E". Drop it rather than store the wrong value.
  if (eps !== null && eps < 0 && peRatio !== null) { rejected.push("peRatio:loss"); peRatio = null; }
  // Profitable company must have a positive P/E.
  if (eps !== null && eps > 0 && peRatio !== null && peRatio <= 0) { rejected.push("peRatio:sign"); peRatio = null; }

  const pbRatio = pick(equity, "pbRatio", rejected);
  const roe = pick(equity, "roe", rejected);
  const dividendYield = pick(dividends, "dividendYield", rejected);
  const debtToEquity = pick(solvency, "debtToEquity", rejected);

  return { ratios: { eps, peRatio, pbRatio, roe, debtToEquity, dividendYield }, rejected };
}
