# Activist CEF Tracker

Cloudflare Worker + React dashboard for tracking Saba Capital and Bulldog Investors activist closed-end fund / investment trust filings. It polls SEC submissions, stores raw filings in R2, keeps structured data in D1, uses KV cursors, queues parsing work, classifies campaign signals, scores events, and presents a ranked activist idea inbox rather than an EDGAR clone.

## Install

```bash
npm install
```

## Configure Cloudflare resources

Create resources and replace IDs/names in `wrangler.toml`:

```bash
wrangler d1 create activist-cef-tracker
wrangler r2 bucket create activist-cef-filings
wrangler kv namespace create CONFIG_KV
wrangler queues create filing-parse-queue
wrangler secret put ADMIN_PASSWORD
wrangler secret put SEC_USER_AGENT_EMAIL
wrangler secret put ALERT_WEBHOOK_URL # optional
```

`SEC_USER_AGENT_EMAIL` falls back to `ianyibohuxx@gmail.com` for local development, but production should set a real monitored contact.

## Migrations

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Migrations create activists, issuers, filings, positions, events, documents, watchlist, notes, alerts, job_runs, and errors tables and seed Saba/Bulldog.

## Run locally

```bash
npm run dev
```

Build the dashboard first when serving static UI assets:

```bash
cd ui && npm install && npm run build
cd .. && npm run dev
```

## Scheduled jobs

```bash
npm run dev:scheduled
```

Cron triggers are configured in UTC: intraday 15-minute weekday polling during US market/filing hours, a daily catch-up, and a daily digest slot.

## Tests and checks

```bash
npm run typecheck
npm test
npm run lint
```

Vitest is configured with the Cloudflare Workers pool for Worker-runtime behavior while pure parser/scoring tests remain fixture based.

## Deploy

```bash
npm run deploy
```

## SEC fair access

The SEC fetcher always sends a descriptive User-Agent and uses a conservative internal limiter around two requests per second with retry/backoff for 429 and 5xx responses. Do not increase polling frequency aggressively.

## Known limitations / TODOs

- MVP uses deterministic regex classification, not an AI analyst.
- Raw filing parsing is resilient but intentionally conservative.
- Alerts create rows; webhook delivery is a future extension.
- UI is a focused ranked inbox and can be expanded with richer issuer pages.
- Future features: NAV/discount data, UK RNS/TR-1 ingestion, email/Slack alerts, historical backtest.
