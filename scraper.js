const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const action = process.argv[2] || 'quotes';
  console.log(`Starting PSX Sync Job (Headless Browser): ${action}...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  
  try {
    // 1. Visit PSX homepage to solve Cloudflare JS challenge & get clearance cookies
    console.log('Establishing Cloudflare clearance session...');
    await page.goto('https://dps.psx.com.pk/', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // Allow challenge to settle

    // Helper to fetch JSON safely inside the browser context
    async function psxJson(path) {
      const sep = path.includes('?') ? '&' : '?';
      const url = `https://dps.psx.com.pk${path}${sep}_t=${Math.floor(Date.now() / 60000)}`;
      
      return await page.evaluate(async (fetchUrl) => {
        const r = await fetch(fetchUrl, {
          headers: {
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": "https://dps.psx.com.pk/"
          }
        });
        if (!r.ok) throw new Error(`HTTP Error: ${r.status}`);
        const raw = await r.json();
        return Array.isArray(raw) ? raw : (raw?.data ?? []);
      }, url);
    }

    // Fetch tracked symbols from Supabase
    const { data: stocks, error: stockErr } = await SB.from("stocks").select("symbol").eq("is_active", true).order("symbol");
    if (stockErr) throw stockErr;
    const syms = (stocks ?? []).map(r => r.symbol);

    // Fetch latest bars
    const { data: latestBarsData } = await SB.from("v_latest_bars").select("symbol, traded_on, open, high, low, close, volume, prev_close");
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

    let freshQuotes = [];
    console.log(`Scraping ${syms.length} symbols via browser context...`);

    for (const sym of syms) {
      try {
        let intraday = await psxJson(`/timeseries/int/${sym}`);
        if (intraday.length) {
          const tickDate = new Date(Number(intraday[0][0]) * 1000);
          tickDate.setUTCHours(tickDate.getUTCHours() + 5);
          if (tickDate.toISOString().slice(0, 10) !== today) intraday = [];
        }

        let quoteData = null;
        const bar = barsMap.get(sym);
        const ldcpFromBar = bar ? (bar.traded_on === today ? (bar.prev_close ?? bar.close) : bar.close) : 0;

        if (!intraday.length) {
          const currentUtc = new Date().getUTCHours();
          const isMarketOpen = currentUtc >= 4 && currentUtc < 11;
          if (!isMarketOpen) {
            try {
              const eod = await psxJson(`/timeseries/eod/${sym}`);
              if (eod.length) {
                const rec = eod[0];
                const eodDate = new Date(Number(rec[0]) * 1000);
                eodDate.setUTCHours(eodDate.getUTCHours() + 5);
                if (eodDate.toISOString().slice(0, 10) === today) {
                  const close = Number(rec[1]);
                  const volume = Number(rec[2]);
                  const open = Number(rec[3]) || close;
                  const high = Number(rec[4]) || Math.max(open, close);
                  const low = Number(rec[5]) || Math.min(open, close);
                  const base = ldcpFromBar || open;
                  quoteData = {
                    symbol: sym, last: close, open, high, low, volume, ldcp: base,
                    change: Math.round((close - base) * 100) / 100,
                    change_pct: base ? Math.round(((close - base) / base) * 100 * 100) / 100 : 0,
                    fresh: true
                  };
                }
              }
            } catch (e) {}
          }
          if (!quoteData && bar) {
            const base = bar.prev_close ?? bar.close;
            quoteData = {
              symbol: sym, last: bar.close, open: bar.close, high: bar.close, low: bar.close, volume: 0,
              ldcp: base, change: 0, change_pct: 0, fresh: false
            };
          }
        } else {
          let high = -Infinity, low = Infinity, volume = 0;
          for (const t of intraday) {
            const p = Number(t[1]);
            if (p <= 0) continue;
            if (p > high) high = p;
            if (p < low) low = p;
            volume += Number(t[2]);
          }
          const last = Number(intraday[0][1]);
          const open = Number(intraday[intraday.length - 1][1]);
          if (last > 0) {
            const base = ldcpFromBar || open;
            quoteData = {
              symbol: sym, last, open, high, low, volume, ldcp: base,
              change: Math.round((last - base) * 100) / 100,
              change_pct: base ? Math.round(((last - base) / base) * 100 * 100) / 100 : 0,
              fresh: true
            };
          }
        }

        if (quoteData && quoteData.fresh) {
          freshQuotes.push(quoteData);
        }
        await new Promise(r => setTimeout(r, 300)); // Polite delay
      } catch (err) {
        console.error(`Error fetching ${sym}:`, err.message);
      }
    }

    if (freshQuotes.length > 0) {
      const rows = freshQuotes.map(q => ({
        symbol: q.symbol, last_price: q.last, change: q.change, change_pct: q.change_pct,
        open: q.open, high: q.high, low: q.low, volume: q.volume, ldcp: q.ldcp,
        refreshed_at: new Date().toISOString()
      }));
      const { error: upsertErr } = await SB.from("market_quotes").upsert(rows);
      if (upsertErr) throw upsertErr;
      console.log(`✅ Success: Upserted ${rows.length} fresh quotes.`);
    }

    // Sync Index KSE100
    try {
      const ticks = await psxJson('/timeseries/int/KSE100');
      if (ticks.length) {
        let high = -Infinity, low = Infinity;
        for (const t of ticks) {
          const p = Number(t[1]);
          if (p > high) high = p;
          if (p > 0 && p < low) low = p;
        }
        const last = Number(ticks[0][1]);
        const open = Number(ticks[ticks.length - 1][1]);
        const { data: q } = await SB.from("market_quotes").select("change_pct");
        const adv = (q || []).filter(r => Number(r.change_pct) > 0).length;
        const dec = (q || []).filter(r => Number(r.change_pct) < 0).length;

        const indexRow = {
          index_code: "KSE100", name: "KSE-100 Index", last_value: last, high, low,
          change: Math.round((last - open) * 100) / 100,
          change_pct: open ? Math.round(((last - open) / open) * 100 * 100) / 100 : 0,
          advancers: adv, decliners: dec, unchanged: (q || []).length - adv - dec,
          refreshed_at: new Date().toISOString()
        };
        await SB.from("index_quotes").upsert(indexRow);
        console.log("✅ Success: Index KSE100 updated.");
      }
    } catch (e) {
      console.error("Index sync error:", e.message);
    }

    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "ok", detail: `Synced ${freshQuotes.length} quotes` });
  } catch (e) {
    const msg = String(e).slice(0, 500);
    console.error(`❌ Error: ${msg}`);
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "error", detail: msg });
  } finally {
    await browser.close();
  }
}

main();
