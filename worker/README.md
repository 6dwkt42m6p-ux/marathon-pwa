# Marathon Coach Token Proxy

Cloudflare Worker that keeps `STRAVA_CLIENT_SECRET` server-side.
The PWA talks to this worker instead of Strava directly for token exchange and refresh.

## Setup

### 1. Install Wrangler (once)
```bash
npm install -g wrangler
wrangler login
```

### 2. Set secrets (never committed)
```bash
cd worker/
wrangler secret put STRAVA_CLIENT_SECRET   # paste secret when prompted
wrangler secret put ALLOWED_ORIGIN         # e.g. https://philippknoedler.github.io
```

### 3. Deploy
```bash
cd worker/
wrangler deploy
```

Wrangler prints the worker URL, e.g. `https://marathon-coach-proxy.<account>.workers.dev`.

### 4. Set the PWA env var
In `.env` (local dev) and the GitHub Actions secret `VITE_STRAVA_TOKEN_PROXY`:
```
VITE_STRAVA_TOKEN_PROXY=https://marathon-coach-proxy.<account>.workers.dev
```

## Local dev
Create `worker/.dev.vars` (gitignored):
```
STRAVA_CLIENT_SECRET=<secret>
ALLOWED_ORIGIN=http://localhost:5173
```
Then run `wrangler dev` from `worker/`.

## Extending (T-004 Claude endpoint)
Add a handler function in `src/index.ts` and register it in the `ROUTES` map:
```typescript
// in ROUTES:
'POST /claude': handleClaude,
```
No other code changes needed.
