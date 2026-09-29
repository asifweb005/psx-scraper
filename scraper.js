const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const SB = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const action = process.argv[2] || 'quotes';
  console.log(`Starting PSX Sync Job (Lightning Fast Hybrid): ${action}...`);

  // Step 1: Open browser briefly just to harvest Cloudflare clearance cookies
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
  } finally {
    await browser.close(); // Close browser immediately to save memory and CPU!
  }

  if (!cookieHeader) {
    console.error('❌ Error: Could not acquire Cloudflare clearance cookies.');
    process.exit(1);
  }

  console.log('✅ Cloudflare cookies acquired. Fetching market data via fast native requests...');

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
          "Cookie": cookieHeader
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!r.ok) return [];
      const raw = await r.json();
      return Array.isArray(raw) ? raw : (raw?.data ?? []);
    } catch (err) {
      return [];
    }
  }

  try {
    const { data: stocks, error: stockErr } = await SB.from("stocks").select("symbol").eq("is_active", true).order("symbol");
    if (stockErr) throw stockErr;
    const syms = (stocks ?? []).map(r => r.symbol);

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

    const freshQuotes = await pmap(syms, 10, async (sym) => {
      try {
        let intraday = await psxJson(`/timeseries/int/${sym}`);
        if (intraday.length) {
          const tickDate = new Date(Number(intraday[0][0]) * 1000);
          tickDate.setUTCHours(tickDate.getUTCHours() + 5);
          if (tickDate.toISOString().slice(0, 10) !== today) intraday = [];
        }

        const bar = barsMap.get(sym);
        const ldcpFromBar = bar ? (bar.traded_on === today ? (bar.prev_close ?? bar.close) : bar.close) : 0;

        if (!intraday.length) {
          const currentUtc = new Date().getUTCHours();
          const isMarketOpen = currentUtc >= 4 && currentUtc < 11;
          if (!isMarketOpen) {
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
                return {
                  symbol: sym, last: close, open, high, low, volume, ldcp: base,
                  change: Math.round((close - base) * 100) / 100,
                  change_pct: base ? Math.round(((close - base) / base) * 100 * 100) / 100 : 0,
                  fresh: true
                };
              }
            }
          }
          if (bar) {
            const base = bar.prev_close ?? bar.close;
            return {
              symbol: sym, last: bar.close, open: bar.close, high: bar.close, low: bar.close, volume: 0,
              ldcp: base, change: 0, change_pct: 0, fresh: false
            };
          }
          return null;
        }

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
          return {
            symbol: sym, last, open, high, low, volume, ldcp: base,
            change: Math.round((last - base) * 100) / 100,
            change_pct: base ? Math.round(((last - base) / base) * 100 * 100) / 100 : 0,
            fresh: true
          };
        }
      } catch (err) {
        return null;
      }
      return null;
    });

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

    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "ok", detail: `Synced ${freshQuotes.length} quotes` });
  } catch (e) {
    const msg = String(e).slice(0, 500);
    console.error(`❌ Error: ${msg}`);
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "error", detail: msg });
  }
}

main();
