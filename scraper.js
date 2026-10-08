const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

const {validatedTicks,quoteFromTicks,quoteFromSnapshot,freshQuoteRows}=require('./live_quote_validation');
const {indexFromSnapshot}=require('./index_validation');
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
  }

  if (!cookieHeader) {
    console.error('❌ Error: Could not acquire Cloudflare clearance cookies.');
    await browser.close();
    throw Error('Could not acquire browser cookies');
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

  async function companySnapshot(symbol) {
    return page.evaluate(async symbol => {
      const r=await fetch('/company/'+encodeURIComponent(symbol),{credentials:'include',signal:AbortSignal.timeout(15000)});
      if(!r.ok)throw Error('Company page HTTP '+r.status);
      const doc=new DOMParser().parseFromString(await r.text(),'text/html');
      const root=doc.querySelector('#quote');
      if(!root)throw Error('Missing company quote');
      const stats={};
      for(const item of root.querySelectorAll('.tabs__panel[data-name="REG"] .stats_item')){
        const label=item.querySelector('.stats_label')?.textContent.trim();
        if(label)stats[label]=item.querySelector('.stats_value')?.textContent.trim();
      }
      return {date:root.querySelector('.quote__date')?.textContent.trim(),close:root.querySelector('.quote__close')?.textContent.trim(),stats};
    },symbol);
  }

  try {

    // Index is independent of stock coverage. Read the official summary panel,
    // including previous close and source time; never stamp stale data as new.
    let indexOk=false;
    try {
      const snapshot=await page.evaluate(async()=>{
        const r=await fetch('/?_t='+Date.now(),{credentials:'include',signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw Error('Index page HTTP '+r.status);
        const doc=new DOMParser().parseFromString(await r.text(),'text/html');
        const root=doc.querySelector('.marketIndices__details[data-name="KSE100"]');
        if(!root)throw Error('Missing KSE100 panel');
        const stats={};
        for(const item of root.querySelectorAll('.stats_item')){
          const label=item.querySelector('.stats_label')?.textContent.trim();
          if(label)stats[label]=item.querySelector('.stats_value')?.textContent.trim();
        }
        return {date:root.dataset.date,close:root.dataset.close,stats};
      });
      const row=indexFromSnapshot(snapshot);
      const {data:previous,error:readErr}=await SB.from('index_quotes').select('refreshed_at').eq('index_code','KSE100').maybeSingle();
      if(readErr)throw readErr;
      if(previous && Date.parse(previous.refreshed_at)>Date.parse(row.refreshed_at))throw Error('Index source would regress');
      const {error}=await SB.from('index_quotes').upsert(row);
      if(error)throw error;
      indexOk=true;
      console.log('KSE100: '+row.last_value+' change '+row.change+' ('+row.change_pct+'%), source '+row.refreshed_at);
    }catch(err){
      console.error('KSE100 unavailable: '+String(err));
      const {error}=await SB.from('sync_log').insert({job:'psx-index',status:'error',detail:String(err).slice(0,500)});
      if(error)console.error('Index error log failed: '+error.message);
    }

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
        await new Promise(r=>setTimeout(r,1500));
      }
      return out;
    }

    console.log(`Scraping ${syms.length} symbols in high-speed parallel batches...`);

const freshQuotes = await pmap(syms, 1, async sym => {
      try {
        // Prefer official REG snapshot: actual session high/low, cumulative
        // volume, LDCP and source timestamp, including Friday session hours.
        const snapshot=quoteFromSnapshot(sym,await companySnapshot(sym),today);
        if(snapshot)return snapshot;
      }catch(err){console.error(sym+': snapshot unavailable '+String(err));}
      const bar=barsMap.get(sym);
      const base=bar?(bar.traded_on===today?bar.prev_close:bar.close):null;
      const ticks=validatedTicks(await psxJson('/timeseries/int/'+sym),today);
      return quoteFromTicks(sym,ticks,base);
    });

    if (freshQuotes.length > 0) {
      const rows = freshQuoteRows(freshQuotes);
      const { error: upsertErr } = await SB.from("market_quotes").upsert(rows);
      if (upsertErr) throw upsertErr;
      console.log(`✅ Success: Upserted ${rows.length} fresh quotes.`);
      // Sample validated quotes at the source time, not the workflow run time.
      // Snapshot volume is cumulative, so it cannot represent interval volume.
      const points = rows.map(q => ({symbol:q.symbol, ts:q.refreshed_at, price:q.last_price, volume:null}));
      const { error: intradayErr } = await SB.from("intraday_prices").upsert(points, {onConflict:"symbol,ts", ignoreDuplicates:true});
      if (intradayErr) throw Error('Intraday storage: '+intradayErr.message);
      console.log(`✅ Stored ${points.length} intraday quote samples (source timestamps; duplicates ignored).`);
    }

    if(!freshQuotes.length)throw Error("No validated current quotes; stored quotes preserved");

    const missing=syms.length-freshQuotes.length;
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: missing||!indexOk?"partial":"ok", detail: `Validated ${freshQuotes.length}/${syms.length} quotes; ${missing} unavailable symbols preserved; KSE100 ${indexOk?"updated":"unavailable (stored value preserved)"}` });
  } catch (e) {
    const msg = String(e).slice(0, 500);
    console.error(`❌ Error: ${msg}`);
    await SB.from("sync_log").insert({ job: `psx-sync:${action}`, status: "error", detail: msg });
    process.exitCode=1;
  } finally {
    await browser.close();
  }
}

main().catch(e=>{console.error(String(e));process.exitCode=1;});



