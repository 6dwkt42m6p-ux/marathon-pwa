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
wrangler secret put HUB_DATA_TOKEN         # read-only fine-grained PAT for 6dwkt42m6p-ux/hub-data
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

## Routes

| Method | Path | Secret required | Description |
|--------|------|-----------------|-------------|
| POST | `/strava/token` | `STRAVA_CLIENT_SECRET` | Exchange authorization code for tokens |
| POST | `/strava/refresh` | `STRAVA_CLIENT_SECRET` | Exchange refresh token for fresh tokens |
| GET | `/hub-snapshot` | `HUB_DATA_TOKEN` | Fetch `hub_snapshot.json` from private repo `6dwkt42m6p-ux/hub-data` |
| POST | `/claude` | `ANTHROPIC_API_KEY` | Claude proxy (dormant — `CLAUDE_ENDPOINT_ENABLED=false`, Strava-AI-Policy) |

### `/hub-snapshot` — private Hub data

Fetches `hub_snapshot.json` from the private GitHub repo `6dwkt42m6p-ux/hub-data` using a
server-side read-only fine-grained PAT (`HUB_DATA_TOKEN`). The token is never sent to the client.

Returns the raw JSON content with `Content-Type: application/json`. CORS is enforced against
`ALLOWED_ORIGIN` (same as other routes).

> **⚠️ Security model (v1):** This route is protected ONLY by the Origin check, which is a
> *browser* same-origin guard — it is trivially spoofable by a direct HTTP client
> (`curl -H "Origin: https://6dwkt42m6p-ux.github.io" …`). So the ticket data IS reachable by
> anyone who knows the worker URL and sends the right Origin header. What IS protected: the
> `hub-data` repo stays private and `HUB_DATA_TOKEN` never leaves the server. For real endpoint
> access control (interactive auth), put **Cloudflare Access** in front of the worker/PWA — tracked
> as the follow-up ticket T-115. Do NOT add a PWA-held static secret: the Pages bundle is public,
> so any embedded key is extractable.

Error responses:
- `503 { "error": "hub_data_not_configured" }` — `HUB_DATA_TOKEN` secret not set
- `upstream.status { "error": "upstream_error", "status": N }` — GitHub API returned non-2xx

```bash
# Smoke test (with correct Origin header):
curl -H "Origin: https://6dwkt42m6p-ux.github.io" \
  https://marathon-coach-proxy.pk-run.workers.dev/hub-snapshot

# Should be blocked (no/wrong Origin):
curl https://marathon-coach-proxy.pk-run.workers.dev/hub-snapshot
```

## Extending (T-004 Claude endpoint)
Add a handler function in `src/index.ts` and register it in the `ROUTES` map:
```typescript
// in ROUTES:
'POST /claude': handleClaude,
```
No other code changes needed.
