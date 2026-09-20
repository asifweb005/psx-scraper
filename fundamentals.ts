
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractRatios } from "./fundamentals_lib.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
    // How often each value was dropped by the unit / range / consistency guards.
    const rejections = new Map<string, number>();

    for (let i = 0; i < stocks.length; i++) {
      const symbol = stocks[i].symbol;
      try {
        const res = await fetch(
          `https://scstrade.com/stockscreening/SS_CompanySnapShot.aspx?symbol=${symbol}`,
          {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(15000),
          },
        );

        if (!res.ok) {
          empty++;
          continue;
        }

        const html = await res.text();
        const { ratios, rejected } = extractRatios(html);
        const { eps, peRatio, pbRatio, roe, debtToEquity, dividendYield } = ratios;

        for (const r of rejected) rejections.set(r, (rejections.get(r) ?? 0) + 1);
        if (rejected.length) console.warn(`${symbol}: dropped ${rejected.join(", ")}`);

        // "full" / "partial" keep their old meaning: the five core ratios.
        const gotCount = [peRatio, pbRatio, roe, debtToEquity, dividendYield].filter((v) => v !== null).length;

        if (gotCount > 0 || eps !== null) {
          const payload = {
            symbol,
            eps,
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

    const rej = [...rejections].sort().map(([k, n]) => `${k}=${n}`).join(", ") || "none";
    const summary = `Total: ${stocks.length} | Saved: ${saved} | Full: ${full} | Partial: ${partial} | Empty: ${empty} | Dropped: ${rej}`;
    await supabase.from("sync_log").insert({ job: "sync-fundamentals", status: "ok", detail: summary.slice(0, 500) });
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
