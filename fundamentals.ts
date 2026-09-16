import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function toPlainText(html: string): string {
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
const TOKEN_RE = /Rs\.\s*[\d,]+\.?\d*|-?\d+(?:\.\d+)?\s*%|-?\d+(?:\.\d+)?\s*x\b/gi;

function extractRow(text: string, labels: string[]): string[] | null {
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

// Clamps extreme outliers to prevent PostgreSQL numeric overflow errors
function numFromToken(token: string | undefined): number | null {
  if (!token) return null;
  const m = token.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const val = parseFloat(m[0]);
  if (!Number.isFinite(val)) return null;
  if (val > 99999.99) return 99999.99;
  if (val < -99999.99) return -99999.99;
  return Math.round(val * 100) / 100;
}

const EARNINGS_LABELS = [
  "Latest EPS Upto", "EPS Last Quarter", "Last Annual EPS Upto",
  "Price To Earning P/E Upto", "Exp Price To Earning P/E Upto",
  "Exp Earning Gowth Upto", "Price Earning Growth Upto",
];
const EQUITY_LABELS = [
  "Book Value Upto", "Exp Book Value Upto", "Book Value Growth Upto",
  "Exp Book Value Growth Upto", "Price To Book Value Upto",
  "Exp Price To Book Value Upto", "Return On Equity Upto",
  "Exp Return On Equity Upto", "Retention Ratio Upto",
  "Exp Retention Ratio Upto", "Equity To Assets Ratio Upto",
  "Return On Assets Upto", "Return On Cap Employed Upto",
];
const DIVIDENDS_LABELS = [
  "Latest Dividend Upto", "Dividend Last Quarter", "Last Annual Dividend Upto",
  "Dividend Yield Upto", "Expected Dividend Upto", "Expected Dividend Yield Upto",
  "Expected Dividend Growth Upto", "Dividend Cover Upto", "Payout Ratio Upto",
  "Expected Payout Ratio Upto",
];
const SOLVENCY_LABELS = [
  "Long Debt To Equity", "Total Debt To Equity",
  "Long Debt To Assets Upto", "Total Debt To Assets Upto",
];

interface Ratios {
  peRatio: number | null;
  pbRatio: number | null;
  roe: number | null;
  debtToEquity: number | null;
  dividendYield: number | null;
}

function extractRatios(html: string): Ratios {
  const text = toPlainText(html);

  const earnings = extractRow(text, EARNINGS_LABELS);
  const peRatio = earnings ? numFromToken(earnings[3]) : null;

  const equity = extractRow(text, EQUITY_LABELS);
  const pbRatio = equity ? numFromToken(equity[4]) : null;
  const roe = equity ? numFromToken(equity[6]) : null;

  const dividends = extractRow(text, DIVIDENDS_LABELS);
  const dividendYield = dividends ? numFromToken(dividends[3]) : null;

  const solvency = extractRow(text, SOLVENCY_LABELS);
  const debtToEquity = solvency ? numFromToken(solvency[1]) : null;

  return { peRatio, pbRatio, roe, debtToEquity, dividendYield };
}

async function main() {
  console.log("Starting Fundamentals Sync...");

  try {
    const { data: stocks, error: stockErr } = await supabase
      .from("stocks").select("symbol").eq("is_active", true);
    if (stockErr) throw stockErr;
    
    if (!stocks || stocks.length === 0) {
      console.log("No active stocks found.");
      Deno.exit(0);
    }

    console.log(`Found ${stocks.length} active stocks. Scraping scstrade.com safely...`);

    let full = 0, partial = 0, empty = 0, saved = 0;

    for (let i = 0; i < stocks.length; i++) {
      const symbol = stocks[i].symbol;
      try {
        const res = await fetch(
          `https://scstrade.com/stockscreening/SS_CompanySnapShot.aspx?symbol=${symbol}`,
          { 
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(15000)
          }
        );
        
        if (!res.ok) {
          empty++;
          continue;
        }

        const html = await res.text();
        const { peRatio, pbRatio, roe, debtToEquity, dividendYield } = extractRatios(html);
        const gotCount = [peRatio, pbRatio, roe, debtToEquity, dividendYield].filter((v) => v !== null).length;

        if (gotCount > 0) {
          const payload = {
            symbol,
            pe_ratio: peRatio,
            pb_ratio: pbRatio,
            roe,
            debt_to_equity: debtToEquity,
            dividend_yield: dividendYield,
            updated_at: new Date().toISOString(),
          };

          // Upsert row-by-row so a single problem stock never stops the remaining stocks
          const { error: singleErr } = await supabase
            .from("fundamentals")
            .upsert(payload, { onConflict: "symbol" });

          if (!singleErr) {
            saved++;
            if (gotCount === 5) full++; else partial++;
          } else {
            console.warn(`Database warning on ${symbol}: ${singleErr.message}`);
            empty++;
          }
        } else {
          empty++;
        }
      } catch {
        empty++;
      }
      
      if ((i + 1) % 10 === 0) {
        console.log(`Processed ${i + 1}/${stocks.length} stocks (${saved} saved)...`);
      }
      
      await new Promise((r) => setTimeout(r, 1000));
    }

    const summary = `Total: ${stocks.length} | Saved: ${saved} | Full: ${full} | Partial: ${partial} | Empty: ${empty}`;
    await supabase.from("sync_log").insert({ job: "sync-fundamentals", status: "ok", detail: summary });
    console.log(`✅ Success: ${summary}`);
    
  } catch (error: unknown) {
    const err = error as { message?: string; details?: string; hint?: string };
    const msg = err?.message ? `${err.message} (${err.details ?? err.hint ?? ""})` : JSON.stringify(error);
    await supabase.from("sync_log").insert({ job: "sync-fundamentals", status: "error", detail: msg.slice(0, 500) });
    console.error(`❌ Error: ${msg}`);
    Deno.exit(1);
  }
}

main();
