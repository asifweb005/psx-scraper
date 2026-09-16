import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Content-Type": "application/x-www-form-urlencoded",
  "X-Requested-With": "XMLHttpRequest",
  "Referer": "https://dps.psx.com.pk/",
};

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function extractRows(html: string): string[][] {
  const rows: string[][] = [];
  const trMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  for (const tr of trMatches) {
    const tdMatches = tr.match(/<td[\s\S]*?<\/td>/gi) ?? [];
    if (tdMatches.length === 0) continue;
    rows.push(tdMatches.map(stripTags));
  }
  return rows;
}

async function main() {
  const action = Deno.args[0] ?? "all";
  let detail = "";
  console.log(`Starting Corporate Events Sync: ${action}...`);

  try {
    // ── Payouts (Dividends/Bonus/Rights) ──────────────────────────────────
    if (action === "all" || action === "exdates") {
      const r = await fetch("https://dps.psx.com.pk/payouts", {
        method: "POST",
        headers: BASE_HEADERS,
        body: "offset=0&limit=100",
        signal: AbortSignal.timeout(25000),
      });
      const html = await r.text();
      const rows = extractRows(html);
      const upsertRows: Record<string, unknown>[] = [];

      for (const cells of rows) {
        if (cells.length < 5) continue;
        const symbol      = cells[0].replace(/\s+/g, "");
        const companyName = cells[1];
        const payoutRaw   = cells[3];
        const closureRaw  = cells[5] ?? "";

        if (!symbol || !closureRaw || symbol === "Symbol") continue;

        const dateMatch = closureRaw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (!dateMatch) continue;

        let dd = dateMatch[1], mm = dateMatch[2];
        const yyyy = dateMatch[3];

        if (parseInt(mm) > 12) { const tmp = mm; mm = dd; dd = tmp; }

        const dInt = parseInt(dd);
        const mInt = parseInt(mm);
        if (dInt < 1 || dInt > 31 || mInt < 1 || mInt > 12) continue; 

        const bc2 = yyyy + "-" + mm.padStart(2,"0") + "-" + dd.padStart(2,"0");
        const lower = payoutRaw.toLowerCase();
        const ptype = lower.includes("(b)") ? "bonus" : lower.includes("(r)") ? "right" : "dividend";

        upsertRows.push({
          symbol: symbol.toUpperCase(),
          company_name: companyName,
          payout_type: ptype,
          payout_value: payoutRaw,
          bc2_start_date: bc2,
          ex_price: null,
          refreshed_at: new Date().toISOString(),
        });
      }

      const seen = new Set<string>();
      const dedupedRows = upsertRows.filter((r) => {
        const key = r.symbol + "|" + r.bc2_start_date + "|" + r.payout_type;
        if (seen.has(key as string)) return false;
        seen.add(key as string);
        return true;
      });

      if (dedupedRows.length > 0) {
        const { error } = await SB.from("ex_dates").upsert(dedupedRows, {
          onConflict: "symbol,bc2_start_date,payout_type",
        });
        if (error) throw new Error("ex_dates upsert: " + error.message);
        detail += `ex_dates: upserted ${dedupedRows.length} rows`;
      } else {
        detail += `ex_dates: 0 rows parsed (tr=${rows.length})`;
      }
    }

    // ── Board Meetings ───────────────────────────────────────────────────
    if (action === "all" || action === "board") {
      const r = await fetch("https://dps.psx.com.pk/announcements", {
        method: "POST",
        headers: BASE_HEADERS,
        body: "type=C&symbol=&query=board+meeting&count=100&offset=0&date_from=&date_to=&page=annc",
        signal: AbortSignal.timeout(25000),
      });
      const html = await r.text();
      const rows = extractRows(html);
      const upsertRows: Record<string, unknown>[] = [];

      for (const cells of rows) {
        if (cells.length < 5) continue;
        const dateRaw = cells[0];
        const timeRaw = cells[1];
        const symbol  = cells[2].replace(/\s+/g, "");
        const name    = cells[3];
        const title   = cells[4];

        if (!symbol || !dateRaw || symbol === "DATE" || symbol === "SYMBOL") continue;

        const titleLower = title.toLowerCase();
        if (
          !titleLower.includes("board meeting") &&
          !titleLower.includes("closed period") &&
          !titleLower.includes("board of directors")
        ) continue;

        const d = new Date(dateRaw + " " + timeRaw);
        if (isNaN(d.getTime())) continue;
        const meetingDate = d.toISOString().slice(0, 10);
        const meetingTime = d.getHours().toString().padStart(2,"0") + ":" + d.getMinutes().toString().padStart(2,"0") + ":00";

        upsertRows.push({
          symbol: symbol.toUpperCase(),
          company_name: name,
          meeting_date: meetingDate,
          meeting_time: meetingTime,
          subject: title,
          source_ref: null,
          refreshed_at: new Date().toISOString(),
        });
      }

      const seenB = new Set<string>();
      const dedupedBoard = upsertRows.filter((r) => {
        const key = r.symbol + "|" + r.meeting_date;
        if (seenB.has(key as string)) return false;
        seenB.add(key as string);
        return true;
      });

      if (dedupedBoard.length > 0) {
        const { error } = await SB.from("board_meetings").upsert(dedupedBoard, {
          onConflict: "symbol,meeting_date",
        });
        if (error) throw new Error("board_meetings upsert: " + error.message);
        detail += `; board_meetings: upserted ${dedupedBoard.length} rows`;
      } else {
        detail += `; board_meetings: 0 rows (status=${r.status} tr=${rows.length})`;
      }
    }

    await SB.from("sync_log").insert({ job: `corporate-events:${action}`, status: "ok", detail });
    console.log(`✅ Success: ${detail}`);

  } catch (e) {
    const msg = String(e).slice(0, 500);
    await SB.from("sync_log").insert({ job: `corporate-events:${action}`, status: "error", detail: msg });
    console.error(`❌ Error: ${msg}`);
    Deno.exit(1);
  }
}

main();
