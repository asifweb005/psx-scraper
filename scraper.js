const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const {sessionDate, validatedTicks, quoteFromTicks, parseEod, freshQuoteRows, quoteFromSnapshot} = require('./quote_validation');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const action = process.argv[2] || 'quotes';
  if (!['quotes', 'eod'].includes(action)) throw new Error(`Unknown action: ${action}`);
  const dryRun = process.argv.includes('--dry-run');
  const failures = [];
  console.log(`Starting PSX Sync Job (Lightning Fast Hybrid): ${action}...`);

  // Keep the existing browser session available for source-side retries.
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  let cookieHeader = '';
  
  try {
    console.log('Establishing Cloudflare clearance session...');
    await page.goto('https://dps.psx.com.pk/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // Let challenge settle

    const cookies = await page.cookies();
    cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    console.error('Failed to get cookies from browser:', e.message);
  }

  console.log('Browser session initialized. Fetching market data via native requests first...');
  // PSX's own script attaches this page-issued header to AJAX requests.
  const requestId = await page.evaluate(() => window.__ps?._k ?? '');

  // Step 2: High-speed native fetch helper using the harvested cookies
  async function psxJson(path) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://dps.psx.com.pk${path}${sep}_t=${Math.floor(Date.now() / 60000)}`;
    
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": "https://dps.psx.com.pk/",
          "Cookie": cookieHeader,
          "X-Req-Id": requestId
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const raw = await r.json();
      const rows = Array.isArray(raw) ? raw : raw?.data;
      if (!Array.isArray(rows)) throw new Error('Unexpected JSON shape');
      return rows;
    } catch (err) {
      // Some clearance cookies are bound to the browser's TLS/session.
      // Preserve native fetching first; retry inside the existing browser.
      const result = await page.evaluate(async target => {
        try {
          const r = await fetch(target, {credentials: 'include', headers: {'X-Req-Id':window.__ps?._k ?? '', 'X-Requested-With':'XMLHttpRequest','Accept':'application/json, text/javascript, */*; q=0.01'}, signal: AbortSignal.timeout(10000)});
          if (!r.ok) return {error: `HTTP ${r.status}`};
          const raw = await r.json();
          const rows = Array.isArray(raw) ? raw : raw?.data;
          return Array.isArray(rows) ? {rows} : {error: 'Unexpected JSON shape'};
        } catch (e) { return {error: String(e)}; }
      }, url).catch(e => ({error: String(e)}));
      if (result.rows) return result.rows;
      failures.push(`${path}: native=${String(err)}; browser=${result.error}`);
      return [];
    }
  }

  async function companySnapshot(symbol) {
    // Fetch the same public company page the website displays. Do not infer
    // price/session fields from fetch time, the current clock, or old DB bars.
    const snapshot = await page.evaluate(async symbol => {
      try {
        const r = await fetch(`/company/${encodeURIComponent(symbol)}`, {credentials:'include',signal:AbortSignal.timeout(15000)});
        if (!r.ok) return {error:`company page HTTP ${r.status}`};
        const doc = new DOMParser().parseFromString(await r.text(),'text/html');
        const root = doc.querySelector('#quote');
        if (!root) return {error:'company quote markup missing'};
        const stats = {};
        for (const item of root.querySelectorAll('.tabs__panel[data-name="REG"] .stats_item')) {
          const label = item.querySelector('.stats_label')?.textContent.trim();
          if (label) stats[label] = item.querySelector('.stats_value')?.textContent.trim();
        }
        return {date:root.querySelector('.quote__date')?.textContent.trim(),close:root.querySelector('.quote__close')?.textContent.trim(),stats};
      } catch(e) {return {error:String(e)};}
    },symbol).catch(e=>({error:String(e)}));
    if(snapshot.error) failures.push(`${symbol}: ${snapshot.error}`);
    return snapshot;
  }

  try {
    const { data: stocks, error: stockErr } = await SB.from("stocks").select("symbol").eq("is_active", true).order("symbol");
    if (stockErr) throw stockErr;
    const syms = (stocks ?? []).map(r => r.symbol);

    const { data: latestBarsData, error: barsErr } = await SB.from("v_latest_bars").select("symbol, traded_on, open, high, low, close, volume, prev_close");
    if (barsErr) throw barsErr;
    const barsMap = new Map();
    for (const r of (latestBarsData ?? [])) {
      barsMap.set(r.symbol, r);
    }

    const todayStr = () => {
      const d = new Date();
      d.setUTCHours(d.getUTCHours() + 5);
      return d.toISOString().slice(0, 10);
    };
    const today = todayStr();

    // Fast parallel batching (chunks of 10 for maximum speed)
    async function pmap(items, size, fn) {
      const out = [];
      for (let i = 0; i < items.length; i += size) {
        const chunk = await Promise.all(items.slice(i, i + size).map(x => fn(x)));
        for (const c of chunk) if (c) out.push(c);
      }
      return out;
    }

    console.log(`Scraping ${syms.length} symbols in high-speed parallel batches...`);


    const {data: holidays, error: holidayError} = await SB.from('market_holidays').select('traded_on');
    if (holidayError) throw holidayError;
    const holidayDates = new Set((holidays || []).map(h => h.traded_on));
    function previousSession(date) {
      const d = new Date(date + 'T12:00:00Z');
      do {d.setUTCDate(d.getUTCDate() - 1);}
      while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidayDates.has(d.toISOString().slice(0, 10)));
      return d.toISOString().slice(0, 10);
    }
    const isNonSession = [0, 6].includes(new Date(today + 'T12:00:00Z').getUTCDay()) || holidayDates.has(today);
    if (isNonSession) {
      console.log(`No trading session on ${today}; existing data preserved.`);
      return;
    }
    const previousDate = previousSession(today);
    const minutePkt = new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 300;
    const closingMinute = new Date(today + 'T12:00:00Z').getUTCDay() === 5 ? 990 : 930;
    const expectedEod = minutePkt >= closingMinute ? today : previousDate;
    const write = async (table, rows, options) => {
      if (!rows.length) return;
      if (dryRun) { console.log(`DRY RUN: ${table}: ${rows.length} rows`); return; }
      for (let i = 0; i < rows.length; i += 500) {
        const {error} = await SB.from(table).upsert(rows.slice(i, i + 500), options);
        if (error) throw new Error(`${table}: ${error.message}`);
      }
    };

    if (action === 'eod') {
      const coverage = await pmap(syms, 10, async symbol => {
        const raw = await psxJson(`/timeseries/eod/${symbol}`);
        const bars = parseEod(symbol, raw, expectedEod);
        if (expectedEod === today) {
          const q = quoteFromSnapshot(symbol,await companySnapshot(symbol),today);
          // A dated, post-close official snapshot has actual OHLCV; this is
          // a daily bar, not a relabelled quote from an earlier session.
          if (q && Date.parse(q.refreshed_at) >= Date.parse(`${today}T${String(Math.floor(closingMinute/60)).padStart(2,'0')}:${String(closingMinute%60).padStart(2,'0')}:00+05:00`)) {
            if (!bars.some(b=>b.traded_on===today)) bars.push({symbol,traded_on:today,open:q.open,high:q.high,low:q.low,close:q.last,volume:q.volume});
          }
        }
        if (!bars.length) {
          failures.push(`${symbol}: EOD response has no validated OHLCV rows (row width ${raw[0]?.length ?? 0})`);
          return null;
        }
        // Bounded replay repairs missed sessions and is idempotent.
        await write('historical_prices', bars.slice(-60).map(b=>({...b,range_quality:'verified_ohlc'})), {onConflict: 'symbol,traded_on'});
        return bars[bars.length - 1].traded_on === expectedEod ? symbol : null;
      });
      const indexRaw = await psxJson('/timeseries/eod/KSE100');
      const indexRows = indexRaw.filter(r => Array.isArray(r) && sessionDate(r[0]) && sessionDate(r[0]) <= expectedEod && Number.isFinite(Number(r[1])) && Number(r[1]) > 0)
        .map(r => ({index_code: 'KSE100', traded_on: sessionDate(r[0]), close: Number(r[1])}));
      await write('index_history', [...new Map(indexRows.map(r => [r.traded_on, r])).values()], {onConflict:'index_code,traded_on'});
      const detail = `EOD ${expectedEod}: ${coverage.length}/${syms.length} current symbols; ${failures.slice(0, 3).join('; ')}`;
      console.log(detail);
      if (!dryRun) {
        const {error} = await SB.from('sync_log').insert({job:'psx-sync:eod',status: coverage.length === syms.length ? 'ok' : 'error',detail: detail.slice(0, 500)});
        if (error) throw error;
      }
      if (coverage.length !== syms.length) throw new Error(detail);
      return;
    }

    const freshQuotes = await pmap(syms, 10, async sym => {
      const bar = barsMap.get(sym);
      // A weeks-old historical close is not today's previous close.
      const base = bar?.traded_on === previousDate ? Number(bar.close)
        : bar?.traded_on === today ? Number(bar.prev_close) : null;
      const rawTicks = await psxJson(`/timeseries/int/${sym}`);
      const ticks = validatedTicks(rawTicks, today);
      if (!ticks.length) {
        const q = quoteFromSnapshot(sym,await companySnapshot(sym),today);
        if (q) {
          // Snapshot volume is cumulative, not a per-tick increment.
          await write('intraday_prices',[{symbol:sym,ts:q.refreshed_at,price:q.last,volume:null}],{onConflict:'symbol,ts'});
        }
        return q; // Null preserves stored quotes when neither source validates.
      }
      await write('intraday_prices', ticks.map(t => ({
        symbol:sym, ts:new Date(t[0] * 1000).toISOString(), price:t[1], volume:t[2],
      })), {onConflict:'symbol,ts'});
      return quoteFromTicks(sym, ticks, base);
    });

    const rows = freshQuoteRows(freshQuotes);
    if (!rows.length) throw new Error(`No current source quotes; stored data preserved. ${failures.slice(0, 3).join('; ')}`);
    await write('market_quotes', rows);
    console.log(`Validated ${rows.length}/${syms.length} current quotes; ${syms.length - rows.length} preserved/missing.`);

    // Validate index session and use the previous session's close.
    const ticks = validatedTicks(await psxJson('/timeseries/int/KSE100'), today);
    if (ticks.length) {
      const {data: history, error: indexReadError} = await SB.from('index_history')
        .select('close').eq('index_code','KSE100').eq('traded_on',previousDate).maybeSingle();
      if (indexReadError) throw indexReadError;
      const q = quoteFromTicks('KSE100', ticks, history?.close);
      await write('index_quotes', [{
        index_code:'KSE100', name:'KSE-100 Index', last_value:q.last,
        high:q.high, low:q.low, change:q.change, change_pct:q.change_pct,
        refreshed_at:q.refreshed_at,
        advancers:rows.filter(r => r.change_pct > 0).length,
        decliners:rows.filter(r => r.change_pct < 0).length,
        unchanged:rows.filter(r => r.change_pct === 0).length,
      }]);
    } else {
      failures.push('KSE100: no current index ticks; stored index preserved');
    }

    const detail = `Validated ${rows.length}/${syms.length} current quotes; index ${ticks.length ? 'current' : 'unavailable'}; failed requests ${failures.length}`;
    if (!dryRun) {
      const {error} = await SB.from('sync_log').insert({
        job:'psx-sync:quotes', status:rows.length === syms.length && ticks.length ? 'ok' : 'error', detail,
      });
      if (error) throw error;
    }
    if (rows.length !== syms.length || !ticks.length) throw new Error(detail);
  } catch (e) {
    const msg = String(e).slice(0, 500);
    console.error(`❌ Error: ${msg}`);
    if (!dryRun) {
      const {error} = await SB.from("sync_log").insert({job:`psx-sync:${action}`,status:"error",detail:msg});
      if (error) console.error("Could not persist failure log:", error.message);
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch(e => {console.error(String(e)); process.exitCode = 1;});
