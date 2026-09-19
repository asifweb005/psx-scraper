// fundamentals_test.ts -- run: deno test fundamentals_test.ts
//
// Uses SYNTHETIC pages built to match how extractRow reads the snapshot page
// (a contiguous label block followed by its value tokens). This verifies the
// guards, not scstrade's real HTML.

import {
  DIVIDENDS_LABELS, EARNINGS_LABELS, EQUITY_LABELS, SOLVENCY_LABELS,
  extractRatios, numFromToken,
} from "./fundamentals_lib.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const cells = (xs: string[]) => xs.map((x) => `<td>${x}</td>`).join("");
const section = (labels: string[], values: string[]) =>
  `<table><tr>${cells(labels)}</tr><tr>${cells(values)}</tr></table><p>filler text between sections</p>`;

// A healthy company: EPS 12.5, P/E 8.2, P/B 1.3, ROE 15.2, yield 6.5%, D/E 0.9
const EARN = ["Rs. 12.50", "Rs. 3.10", "Rs. 11.80", "8.20x", "7.10x", "12.00 %", "0.70x"];
const EQ = ["Rs. 85.00", "Rs. 90.00", "10.00 %", "9.00 %", "1.30x", "1.20x", "15.20 %",
  "14.00 %", "40.00 %", "42.00 %", "55.00 %", "8.00 %", "12.00 %"];
const DIV = ["Rs. 4.00", "Rs. 1.00", "Rs. 3.50", "6.50 %", "Rs. 4.50", "7.00 %", "5.00 %",
  "1.50x", "45.00 %", "50.00 %"];
const SOLV = ["0.45x", "0.90x", "10.00 %", "20.00 %"];

const page = (o: { earn?: string[]; eq?: string[]; div?: string[]; solv?: string[] } = {}) =>
  "<html><body>" +
  section(EARNINGS_LABELS, o.earn ?? EARN) +
  section(EQUITY_LABELS, o.eq ?? EQ) +
  section(DIVIDENDS_LABELS, o.div ?? DIV) +
  section(SOLVENCY_LABELS, o.solv ?? SOLV) + "</body></html>";

Deno.test("healthy page extracts every value", () => {
  const { ratios, rejected } = extractRatios(page());
  assert(rejected.length === 0, `no rejections, got ${rejected}`);
  assert(ratios.eps === 12.5, `eps ${ratios.eps}`);
  assert(ratios.peRatio === 8.2, `pe ${ratios.peRatio}`);
  assert(ratios.pbRatio === 1.3, `pb ${ratios.pbRatio}`);
  assert(ratios.roe === 15.2, `roe ${ratios.roe}`);
  assert(ratios.dividendYield === 6.5, `yield ${ratios.dividendYield}`);
  assert(ratios.debtToEquity === 0.9, `de ${ratios.debtToEquity}`);
});

Deno.test("thousands separator: 'Rs. 1,234.50' is 1234.5, not 1", () => {
  assert(numFromToken("Rs. 1,234.50") === 1234.5, "comma handled");
  const { ratios } = extractRatios(page({ earn: ["Rs. 1,234.50", ...EARN.slice(1)] }));
  assert(ratios.eps === 1234.5, `eps ${ratios.eps}`);
  assert(ratios.peRatio === 8.2, "later columns stay aligned");
});

Deno.test("negative EPS keeps tokens aligned (was: every later value shifted left)", () => {
  const earn = ["Rs. -5.20", "Rs. -1.10", "Rs. -4.00", "8.20x", "7.10x", "12.00 %", "0.70x"];
  const { ratios, rejected } = extractRatios(page({ earn }));
  assert(ratios.eps === -5.2, `eps ${ratios.eps}`);
  // loss-maker never keeps a P/E
  assert(ratios.peRatio === null && rejected.includes("peRatio:loss"), "P/E dropped for loss-maker");
  assert(ratios.roe === 15.2 && ratios.pbRatio === 1.3, "other rows unaffected");
});

Deno.test("loss-maker with BLANK P/E cell: shifted neighbour is not stored as P/E", () => {
  // P/E cell empty -> tokens shift; position 3 would be the 'expected P/E' (6.00x)
  const earn = ["Rs. -5.20", "Rs. -1.10", "Rs. -4.00", "6.00x", "12.00 %", "0.70x", "1.00x"];
  const { ratios } = extractRatios(page({ earn }));
  assert(ratios.peRatio === null, `P/E must be null, got ${ratios.peRatio}`);
});

Deno.test("dividend row with a missing first cell: wrong-unit value is dropped", () => {
  // first cell missing -> position 3 becomes 'Rs. 4.50' (expected dividend), not a %
  const div = DIV.slice(1);
  const { ratios, rejected } = extractRatios(page({ div }));
  assert(ratios.dividendYield === null, `yield must be null, got ${ratios.dividendYield}`);
  assert(rejected.includes("dividendYield:unit"), `unit rejection, got ${rejected}`);
});

Deno.test("impossible yields (170%, 117%, 85%, 81%) are dropped by the range guard", () => {
  for (const bad of ["169.84 %", "116.99 %", "84.68 %", "81.28 %"]) {
    const div = ["Rs. 4.00", "Rs. 1.00", "Rs. 3.50", bad, ...DIV.slice(4)];
    const { ratios, rejected } = extractRatios(page({ div }));
    assert(ratios.dividendYield === null, `${bad} must be dropped`);
    assert(rejected.includes("dividendYield:range"), `range rejection for ${bad}`);
  }
  // a plausible high yield is kept
  const ok = extractRatios(page({ div: ["Rs. 4.00", "Rs. 1.00", "Rs. 3.50", "14.20 %", ...DIV.slice(4)] }));
  assert(ok.ratios.dividendYield === 14.2, "14.2% kept");
});

Deno.test("earnings row shifted by TWO cells lands on a % token: P/E dropped by unit check", () => {
  const earn = ["Rs. 11.80", "8.20x", "7.10x", "12.00 %", "0.70x", "1.00x", "2.00x"];
  const { ratios, rejected } = extractRatios(page({ earn }));
  assert(ratios.peRatio === null && rejected.includes("peRatio:unit"), "unit mismatch -> null");
});

Deno.test("KNOWN LIMITATION: a shift by ONE cell that lands on the same unit is not detected", () => {
  // first Rs cell missing -> position 3 is '7.10x' (expected P/E), still an 'x' value in range.
  // Pinned here so nobody assumes the guards cover this case; fixing it needs
  // cell-level HTML parsing (send a sample page).
  const earn = ["Rs. 3.10", "Rs. 11.80", "8.20x", "7.10x", "12.00 %", "0.70x", "1.00x"];
  const { ratios } = extractRatios(page({ earn }));
  assert(ratios.peRatio === 7.1, `documented behaviour: stores the shifted value, got ${ratios.peRatio}`);
});

Deno.test("layout drift (a label missing) still fails closed for that row only", () => {
  const html = page().replace("Dividend Yield Upto", "Dividend Yield");
  const { ratios } = extractRatios(html);
  assert(ratios.dividendYield === null, "dividend row unreadable -> null");
  assert(ratios.peRatio === 8.2 && ratios.roe === 15.2, "other rows still parsed");
});

Deno.test("numFromToken clamps extreme values", () => {
  assert(numFromToken("9999999 %") === 99999.99, "upper clamp");
  assert(numFromToken("-9999999 %") === -99999.99, "lower clamp");
  assert(numFromToken(undefined) === null, "undefined -> null");
});
