# Remotive Ingest

This project ingests the public Remotive job feed (API + RSS), the Remote OK RSS feed, and the We Work Remotely programming RSS feed into a Supabase Postgres database and keeps every job's lifecycle history.

## Prerequisites

- Node.js 20+
- A Supabase project (free tier is fine)
- Supabase service role key and project URL

## Database setup

1. Create a new Supabase project.
2. In the SQL editor, run [`supabase/schema.sql`](supabase/schema.sql) to create the table, indexes, triggers, and RPC helpers.
3. Note the project URL and the service role key (Settings → API).

## GitHub Actions configuration

1. Fork or clone this repository into GitHub.
2. In the repository settings add the following secrets:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. The workflow in [`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) runs every day at 00:10, 06:10, 12:10, and 18:10 UTC and can also be triggered via **Run workflow**.
4. Trigger `workflow_dispatch` once to ensure the GitHub Action has run successfully at least one time.

The Remotive public feed can lag behind real-time openings, so avoid polling it more frequently than necessary.

## Local development

```bash
cd remotive-ingest
npm install
# Update .env with your Supabase credentials (never commit the file)
# Optional: override REMOTIVE_RSS_FEEDS, REMOTE_OK_RSS_URL, or WWR_RSS_URL if you need custom feeds
npm run ingest
```

The script automatically loads `.env`, fetches the latest Remotive API snapshot, folds in one or more Remotive RSS feeds (defaulting to `https://remotive.com/remote-jobs/feed`), fetches the Remote OK RSS feed, pulls the We Work Remotely programming feed, batch upserts each data source through Supabase RPCs, and logs a summary JSON payload. Environment variables are required and the script fails fast when they are absent.

## Sources

| Source | Status | Priority | Blockers / Notes | Proposed Solution |
| --- | --- | --- | --- | --- |
| Remotive (API + RSS) | Active | High | N/A | Keep 4× daily ingestion via main script |
| Remote OK RSS | Active | High | N/A | Already runs 4× daily |
| We Work Remotely (Programming RSS) | Active | High | N/A | Already runs 4× daily |
| Jobspresso (Developer RSS) | Planned | Medium | Feed available at `...?feed=rss2`, but needs dedupe rules and monitoring for occasional outages | Add RSS fetch/normalization similar to WWR, keyed on GUID/link |
| Remote.co (Developer feed) | Blocked | High | Cloudflare managed challenge blocks headless fetches | Request whitelisting or private API credentials, otherwise use browser-based scraper |
| NoDesk | Blocked | Low | RSS endpoints removed (404) | Build HTML scraper or seek direct API/export |
| Working Nomads | Blocked | Medium | RSS feed removed; only paid/API options left | Contact for API access or switch to another curated board |
| Himalayas | Blocked | Medium | API requires bypassing Cloudflare challenge | Request official API token/whitelist before integrating |

## Data notes

- `description_html` contains HTML straight from Remotive; sanitize it before rendering in any UI.
- Every row stores the full raw Remotive JSON payload (`raw_json`) along with a deterministic `content_hash` over the normalized columns.
- `first_seen_at` is preserved on conflict, `verified_at` is touched every run when the job still exists, and `removed_at` is set when a job disappears from the latest snapshot instead of deleting the row.
