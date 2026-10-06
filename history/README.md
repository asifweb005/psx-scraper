# Independent historical backfill

New manual GitHub Actions workflow: **PSX Historical Backfill**.
Source adapter: pypsx-toolkit 3.1.2 with Python 3.12.
Storage: existing Supabase historical_prices; calculations: existing indicators.ts.

All historical code and dependencies are contained in history/. No existing
scraper, root package file, workflow or cron schedule is changed.

First select dates 2026-09-25 through 2026-10-02, symbols HBL,OGDC,LUCK,
and dry_run=true. Dry runs never write bars, logs or indicators.
For restoration use dry_run=false; blank symbols selects all active stocks.
The job preserves existing candles, validates OHLCV and source dates, filters
whole-month toolkit responses, and verifies weekday coverage against holidays.
Writing runs reread stored sessions and fail on incomplete coverage.
Only successful writing runs recompute indicators through the current script.
No recurring schedule is installed. Run the workflow whenever gap repair is needed.

The toolkit has returned all six missing sessions for three locally tested stocks;
all 82 symbols and GitHub runner source access still require a workflow run.
