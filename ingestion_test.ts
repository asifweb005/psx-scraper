import {parseDaily,parseTicks,expectedSession} from "./ingestion_lib.ts";
import {computeIndicators,rsi14} from "./indicators_lib.ts";
const check=(ok:boolean)=>{if(!ok)throw new Error("Assertion failed")};
Deno.test("Flat market is neutral",()=>{check(rsi14(Array(220).fill(100))===50);const bars=Array.from({length:220},(_,i)=>({traded_on:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),open:100,high:100,low:100,close:100,volume:500000}));const r=computeIndicators(bars)!;check(r.signal==="hold" && r.signal_score===0)});
Deno.test("Daily parsing preserves source day and missing OHLC",()=>{const r=parseDaily({data:[[Date.UTC(2026,8,24)/1000,105,100,100]]})[0];check(r.traded_on==="2026-09-24" && r.high===null && r.low===null)});
Deno.test("Ticks sorted and deduplicated",()=>{const t=Date.UTC(2026,8,24,10)/1000;const r=parseTicks({data:[[t,105],[t-60,100],[t,106]]});check(r.length===2 && r[0].price===100 && r[1].price===106)});
Deno.test("Malformed source cannot become a zero price",()=>{let rejected=false;try{parseTicks({data:[[1,0]]})}catch{rejected=true}check(rejected)});
Deno.test("Weekend expects Friday",()=>check(expectedSession(Date.UTC(2026,9,3,12),new Set())==="2026-10-02"));
Deno.test("Missing ranges disable range indicators",()=>{const bars=Array.from({length:30},(_,i)=>({traded_on:new Date(Date.UTC(2026,8,i+1)).toISOString().slice(0,10),open:100,high:0,low:0,close:100+i,volume:500000}));const r=computeIndicators(bars)!;check(r.atr_14===null && r.support===null && r.resistance===null && r.vwap===null)});
