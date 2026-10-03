import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { expectedSession, pktDate, parseDaily, parseTicks } from "./ingestion_lib.ts";
const SB=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const source=Deno.env.get("PSX_SOURCE_BASE") ?? "https://dps.psx.com.pk";
async function fetchSource(path:string) {
  const response=await fetch(source+path,{headers:{"X-Requested-With":"XMLHttpRequest",Referer:source+"/"},signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error("Source HTTP "+response.status+" for "+path);
  const type=response.headers.get("content-type") ?? "";
  if(!type.includes("json")) throw new Error("Source returned non-JSON for "+path);
  return await response.json();
}
async function checked(query:PromiseLike<{error:unknown}>) {const r=await query;if(r.error)throw r.error;}
async function run(action:string) {
  if(!["quotes","eod","index"].includes(action))throw new Error("Unknown ingestion action");
  const {data:stocks,error}=await SB.from("stocks").select("symbol").eq("is_active",true);
  if(error)throw error;
  const symbols=action==="index"?["KSE100"]:(stocks??[]).map(r=>r.symbol);
  if(!symbols.length)throw new Error("No expected symbols configured");
  const cal=await SB.from("market_holidays").select("traded_on");
  if(cal.error)throw cal.error;
  const holidays=new Set<string>((cal.data??[]).map(r=>r.traded_on));
  if (!pktDate().startsWith("2026-")) throw new Error("Update and verify the annual PSX holiday calendar before ingestion");
  const expected=expectedSession(Date.now(),holidays);
  const failures:string[]=[],missing:string[]=[];
  let updated=0,bars=0,ticks=0;
  for(const symbol of symbols) {
    try {
      const daily=parseDaily(await fetchSource("/timeseries/eod/"+symbol));
      if(!daily.length)throw new Error("No daily records");
      const completed=daily.filter(r=>r.traded_on<=expected);
      if(action==="eod") {
        const recent=completed.slice(-60);
        if(!recent.some(r=>r.traded_on===expected))throw new Error("Missing expected session "+expected);
        // Preserve verified OHLC already in the database when the chart feed only has close/open.
        const old=await SB.from("historical_prices").select("traded_on,high,low,range_quality").eq("symbol",symbol).gte("traded_on",recent[0].traded_on);
        if(old.error)throw old.error;
        const byDate=new Map((old.data??[]).map(r=>[r.traded_on,r]));
        const values=recent.map(r=>{const previous=byDate.get(r.traded_on);return {...r,symbol,...(previous?.high && previous?.low ? {high:previous.high,low:previous.low,range_quality:previous.range_quality}: {})};});
        await checked(SB.from("historical_prices").upsert(values,{onConflict:"symbol,traded_on"}));
        bars+=values.length;
      } else {
        const allTicks=parseTicks(await fetchSource("/timeseries/int/"+symbol));
        if(!allTicks.length)throw new Error("No ticks available");
        const session=pktDate(Date.parse(allTicks.at(-1)!.ts));
        if(session!==pktDate())throw new Error("No ticks for today's session; prior quotes retained");
        const sessionTicks=allTicks.filter(t=>pktDate(Date.parse(t.ts))===session);
        const last=sessionTicks.at(-1)!;
        const previous=daily.filter(r=>r.traded_on<session).at(-1);
        if(!previous)throw new Error("Previous close unavailable");
        const change=last.price-previous.close;
        const common={change,change_pct:change/previous.close*100,high:Math.max(...sessionTicks.map(t=>t.price)),low:Math.min(...sessionTicks.map(t=>t.price)),refreshed_at:last.ts};
        if(symbol==="KSE100") {
          await checked(SB.from("index_quotes").upsert({index_code:symbol,name:"KSE-100 Index",last_value:last.price,...common}));
        } else {
          await checked(SB.from("intraday_prices").upsert(sessionTicks.map(t=>({...t,symbol,volume:null})),{onConflict:"symbol,ts"}));
          await checked(SB.from("market_quotes").upsert({symbol,last_price:last.price,open:sessionTicks[0].price,ldcp:previous.close,volume:null,turnover:null,...common}));
          ticks+=sessionTicks.length;
        }
      }
      updated++;
    }catch(e){failures.push(symbol+": "+String(e).slice(0,160));missing.push(symbol);}
  }
  const health=await SB.from("ingestion_health").select("*");
  if(health.error)throw health.error;
  const detail=JSON.stringify({expected_symbols:symbols.length,updated_symbols:updated,expected_session:expected,bars_upserted:bars,ticks_upserted:ticks,missing_symbols:missing,source_failures:failures,health:health.data});
  await checked(SB.from("sync_log").insert({job:"psx-sync:"+action,status:missing.length?"error":"ok",detail}));
  console.log(detail);
  if(missing.length)throw new Error("Ingestion coverage incomplete: "+updated+"/"+symbols.length);
}
if(import.meta.main) run(Deno.args[0]??"quotes").catch(e=>{console.error(e);Deno.exit(1)});
