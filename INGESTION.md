# Market ingestion

Live quotes still use Node 22 + Puppeteer and native PSX requests. Supabase cron dispatches `live-quotes.yml`; no cron was added or replaced.

The browser stays open for same-session retries. Requests include the page-issued AJAX header used by PSX's own script. If current time-series rows are unavailable, the scraper reads the official company page's REG quote, OHLCV, LDCP and displayed PKT timestamp. Old sessions, invalid ranges, missing timestamps and malformed values are rejected. Missing sources leave existing database rows unchanged.

`refreshed_at` means source observation time, not fetch attempt time. Snapshot observations are saved to `intraday_prices` using their source timestamp; their volume is null because the page's volume is cumulative. Real time-series rows retain their original timestamps and are deduplicated by `(symbol, ts)`. Charts assembled from snapshots can be sparse; they are not a reconstructed trade tape.

The daily workflow uses the same browser-backed Node scraper. It replays up to 60 validated OHLCV bars from the EOD source and can append today's dated, post-close official company snapshot. It will not synthesize historical high/low from close/open-only arrays. PSX's website client maps the EOD endpoint to timestamp, close, volume and open; if high/low are absent, historical backfill requires a separate authoritative OHLCV source. Those missing sessions remain explicitly incomplete.

The live probe on October 5 returned HTTP 404 for the time-series endpoints, while the HBL company page supplied a dated valid quote. Endpoint results can differ by runner/network; use the workflow's `dry_run=true` input to check GitHub without modifying Supabase. Dry run does not insert sync logs or prices. Missing symbols and index data cause a failed/degraded job instead of a green false-success report.

EOD and live runs have separate concurrency groups. Existing five-minute cron dispatch and daily EOD triggers are retained. The downstream indicators workflow remains unchanged, and the research stale-data guard remains enabled.

Corporate-events requests now fail on non-2xx HTTP responses and retain stored events; restoring a blocked corporate source still requires upstream availability.

## Validation

## Manual historical backfill

`PSX Live Quotes Sync` now has `mode=history` with start/end dates and an optional ticker list. It opens the official `/historical` page with Puppeteer and uses PSX's own AJAX client to request each symbol/month. It validates table headers, source dates, OHLC ranges and volumes, and inserts only missing `(symbol,traded_on)` rows. Existing candles are preserved. A successful writing run then recomputes indicators. The normal five-minute cron continues to use the default `quotes` mode.

First run `mode=history`, `history_from=2026-09-25`, `history_to=2026-10-02`, `history_symbols=HBL`, `dry_run=true`. Inspect the runner response and validated bar count before a writing run for all symbols. Dry run does not write bars/logs or recompute indicators. Non-2xx sources, malformed rows and incomplete coverage fail visibly. This browser history path is implemented and tested with fixtures; the official site's history button still returned HTTP 404 on the local probe.

### Tests

Run `node --test quote_validation.test.js scraper.test.js history_validation.test.js`. Tests do not need Supabase credentials and cover blocked sources, current sessions, duplicate/out-of-order ticks, false-fresh fallbacks, unknown values, browser retry, official snapshots, EOD and historical-table range validation, dry runs and database errors.

Dependencies are pinned and `package-lock.json` is committed so `npm ci` reproduces the tested install. Puppeteer 23 is retained to minimize changes to the browser behavior; its upgrade/security audit is separate from this data-integrity fix.
