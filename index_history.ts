// index_history.ts -- keep public.index_history (daily KSE-100 closes) current.
//
//   deno run --allow-net --allow-env index_history.ts            # upsert recent history
//   deno run --allow-net --allow-env index_history.ts --dry-run  # fetch + print, no write
//
// Source 1: PSX  /timeseries/eod/<INDEX_CODE>  (same JSON API scraper.ts uses;
//           newest-first rows: [unix_ts, close, ...]).
// Source 2 (fallback for today's point): index_quotes.last_value written by
//           scraper.ts syncIndex.
// Idempotent: upsert on (index_code, traded_on). Run it before indicators.ts.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, optional INDEX_CODE (KSE100)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CODE = Deno.env.get("INDEX_CODE") ?? "KSE100";
const KEEP = 500; // most recent trading days to (re)write

const num = (v: unknown): number => {
  const f = Number(v);
  return Number.isFinite(f) ? f : 0;
};

/** PKT calendar date (UTC+5) for a unix timestamp given in seconds or ms. */
function pktDate(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  d.setUTCHours(d.getUTCHours() + 5);
  return d.toISOString().slice(0, 10);
}

export interface IndexRow { index_code: string; traded_on: string; close: number }

/** Parse PSX EOD rows ([ts, close, ...], newest first) into deduped rows. */
export function parseEod(raw: unknown[], code = CODE): IndexRow[] {
  const seen = new Set<string>();
  const out: IndexRow[] = [];
  for (const rec of raw) {
    if (!Array.isArray(rec)) continue;
    const ts = num(rec[0]), close = num(rec[1]);
    if (ts <= 0 || close <= 0) continue;
    const traded_on = pktDate(ts);
    if (seen.has(traded_on)) continue;
    seen.add(traded_on);
    out.push({ index_code: code, traded_on, close });
  }
  return out;
}

async function fetchEod(): Promise<unknown[]> {
  const url = `https://dps.psx.com.pk/timeseries/eod/${CODE}?_t=${Math.floor(Date.now() / 60000)}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Referer": "https://dps.psx.com.pk/",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`PSX HTTP ${r.status} on eod/${CODE}`);
  const raw = await r.json();
  return Array.isArray(raw) ? raw : (raw?.data ?? []);
}

export async function main(dry: boolean) {
  const SB = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let rows: IndexRow[] = [];
  try {
    rows = parseEod(await fetchEod()).slice(0, KEEP);
    console.log(`PSX eod/${CODE}: ${rows.length} rows` +
      (rows.length ? `, newest ${rows[0].traded_on} = ${rows[0].close}, oldest ${rows[rows.length - 1].traded_on}` : ""));
  } catch (e) {
    console.warn(`[warn] could not fetch PSX EOD history: ${String(e).slice(0, 160)}`);
  }

  // Fallback / top-up for today's point from the live index snapshot.
  const { data } = await SB.from("index_quotes")
    .select("index_code, last_value, refreshed_at").eq("index_code", CODE).limit(1);
  const q = data?.[0] as { last_value?: unknown; refreshed_at?: string } | undefined;
  if (q && num(q.last_value) > 0 && q.refreshed_at) {
    const d = pktDate(new Date(q.refreshed_at).getTime());
    const dow = new Date(d + "T00:00:00Z").getUTCDay();
    const weekday = dow !== 0 && dow !== 6;
    if (weekday && !rows.some((r) => r.traded_on === d)) {
      rows.unshift({ index_code: CODE, traded_on: d, close: num(q.last_value) });
      console.log(`added ${d} from index_quotes snapshot = ${num(q.last_value)}`);
    }
  }

  if (!rows.length) throw new Error("no index rows from PSX or index_quotes");
  if (dry) { console.log("[dry-run] would upsert", rows.length, "rows; sample:", rows.slice(0, 3)); return; }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await SB.from("index_history")
      .upsert(rows.slice(i, i + 200), { onConflict: "index_code,traded_on" });
    if (error) throw error;
  }
  await SB.from("sync_log").insert({
    job: "index-history", status: "ok",
    detail: `${rows.length} rows, newest ${rows[0].traded_on}`,
  });
  console.log(`OK: upserted ${rows.length} rows into index_history`);
}

if (import.meta.main) {
  main(Deno.args.includes("--dry-run")).catch((e) => {
    console.error(`ERROR: ${String((e as { message?: string })?.message ?? e).slice(0, 400)}`);
    Deno.exit(1);
  });
}
