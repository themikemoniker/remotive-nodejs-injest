# Repository Guidelines

## Project Structure & Module Organization
- `remotive-ingest/` is the main workspace. Key subfolders:
  - `scripts/` – ingestion logic (`ingest-remotive.mjs`) that fetches and upserts job feeds.
  - `supabase/` – database assets such as `schema.sql` with tables and RPC helpers.
  - `.github/workflows/` – automation (`ingest.yml`) that schedules the ingestion job.
  - `init-context.json` – snapshot of current sources, schedules, and env defaults.
- Node dependencies live under `remotive-ingest/package.json`. No tests directory yet; add future specs beside the script (e.g., `scripts/__tests__/`).

## Build, Test, and Development Commands
- `npm install` – installs dependencies and produces `package-lock.json`.
- `npm run ingest` – executes the ingestion script locally; requires `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
- `node -c scripts/ingest-remotive.mjs` – fast syntax check used in CI-style validation.

## Coding Style & Naming Conventions
- ESM syntax with `type: module`. Prefer `const/let`, async/await, and descriptive helper names (`normalizeRemoteOkJob`).
- Use two-space indentation in JavaScript and SQL files to match existing style.
- Environment variable names are uppercase snake case (`REMOTE_OK_RSS_URL`). Paths in docs/examples should be workspace-relative.
- No automated formatter yet; keep imports sorted logically (env/config, libs, helpers).

## Testing Guidelines
- There is no formal test harness today. Before merging, run `npm run ingest` with dummy envs or staging Supabase to verify network access and summary output.
- When adding tests, colocate them near the script and mirror the naming pattern `*.test.mjs`. Keep mocks lightweight (e.g., intercept fetch with `node:test` or `viem` once adopted).

## Commit & Pull Request Guidelines
- Follow concise, prefix-based commit messages as seen in history (`feat: add Remotive ingest pipeline`, `docs: update README sources`). Scope optional but encouraged.
- PRs should include:
  1. Summary of changes plus any new feeds/sources.
  2. Verification steps (`npm run ingest`, Supabase screenshot if schema changes).
  3. Linked issue or task reference if available.
- For schema or workflow edits, mention downstream actions (run SQL in Supabase, add secrets) to guide reviewers.

## Security & Configuration Tips
- Never commit `.env` files or Supabase credentials. Document new env vars in README and `init-context.json`.
- If a source requires API keys or whitelisting (e.g., Remote.co), capture blockers and proposed solutions in `init-context.json` and README’s Sources table.
