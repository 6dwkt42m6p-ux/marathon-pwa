/**
 * Marathon Coach Token Proxy — Cloudflare Worker
 *
 * Keeps STRAVA_CLIENT_SECRET server-side. The PWA never sends or receives the secret.
 *
 * Routes
 *   POST /strava/token    — exchange authorization code for tokens
 *   POST /strava/refresh  — exchange refresh_token for fresh tokens
 *   OPTIONS *             — CORS preflight
 *
 * Extensibility: add new endpoints in the route map below (e.g. /claude for T-004).
 */

interface Env {
  STRAVA_CLIENT_SECRET: string
  STRAVA_CLIENT_ID: string     // also available as [vars] in wrangler.toml
  ALLOWED_ORIGIN?: string      // GitHub Pages origin, e.g. https://foo.github.io
  ANTHROPIC_API_KEY?: string   // set via: wrangler secret put ANTHROPIC_API_KEY
  HUB_DATA_TOKEN?: string      // set via: wrangler secret put HUB_DATA_TOKEN
  HUB_ACCESS_KEY?: string      // set via: wrangler secret put HUB_ACCESS_KEY
}

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'

// WHY: Strava API Policy (1.6.2026) prohibits forwarding Strava data to third-party AI services.
// The /claude route must not be live as long as the system prompt / context includes Strava activity data.
// Code is preserved for future use — re-enable ONLY if Strava data is excluded from the Claude context.
// Reaktivierung: Flag auf true setzen + wrangler deploy.
const CLAUDE_ENDPOINT_ENABLED = false

// --- CORS helpers -----------------------------------------------------------

function corsHeaders(origin: string, allowedOrigin: string): Record<string, string> {
  // Only reflect the exact allowed origin — never wildcard with credentials.
  const allowOrigin = origin === allowedOrigin ? origin : allowedOrigin
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // X-Hub-Key is needed for the /hub-snapshot shared-secret gate (T-115)
    'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Key',
    'Access-Control-Max-Age': '86400',
  }
}

function preflight(origin: string, allowedOrigin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigin) })
}

function json(body: unknown, status: number, extraHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}

// --- Strava proxy handlers --------------------------------------------------

async function handleStravaToken(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: Record<string, string>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }

  const { code, redirect_uri } = body
  if (!code || !redirect_uri) {
    return json({ error: 'missing_fields', required: ['code', 'redirect_uri'] }, 400, cors)
  }

  const upstream = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,   // never returned to caller
      code,
      grant_type: 'authorization_code',
      redirect_uri,
    }),
  })

  const data: Record<string, unknown> = await upstream.json()

  // Strip client_secret from response body in case Strava ever echoes it back
  delete data['client_secret']

  return json(data, upstream.status, cors)
}

async function handleStravaRefresh(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: Record<string, string>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }

  const { refresh_token } = body
  if (!refresh_token) {
    return json({ error: 'missing_fields', required: ['refresh_token'] }, 400, cors)
  }

  const upstream = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,   // never returned to caller
      refresh_token,
      grant_type: 'refresh_token',
    }),
  })

  const data: Record<string, unknown> = await upstream.json()
  delete data['client_secret']

  return json(data, upstream.status, cors)
}

// --- Claude proxy handler ---------------------------------------------------

interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string
}

interface ClaudeRequestBody {
  system?: string
  messages: ClaudeMessage[]
}

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-haiku-4-5'

async function handleClaude(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'anthropic_not_configured' }, 503, cors)
  }

  let body: ClaudeRequestBody
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400, cors)
  }

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return json({ error: 'missing_fields', required: ['messages'] }, 400, cors)
  }

  const upstream = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,   // server-side only — never returned to caller
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: body.system,
      messages: body.messages,
    }),
  })

  const data: Record<string, unknown> = await upstream.json()

  // Strip the API key from response in case it ever appears (defensive)
  delete data['x-api-key']

  return json(data, upstream.status, cors)
}

// --- Timing-safe string comparison -----------------------------------------
// WHY: === short-circuits on first mismatch → timing oracle for key length/prefix.
// We always iterate the full length of the expected value to avoid leaking info.
function timingSafeEqual(a: string, b: string): boolean {
  // Different lengths: iterate `a` length anyway so timing is uniform w.r.t. secret length.
  let diff = a.length ^ b.length  // non-zero if lengths differ
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length)
  }
  return diff === 0
}

// --- Hub snapshot proxy handler ---------------------------------------------

const GITHUB_HUB_SNAPSHOT_URL =
  'https://api.github.com/repos/6dwkt42m6p-ux/hub-data/contents/hub_snapshot.json'

async function handleHubSnapshot(req: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  // Shared-key gate (T-115): only active when HUB_ACCESS_KEY secret is set.
  // Soft-rollout: if secret is NOT set, pass through as before (origin-only).
  // WHY: prevents the secret from breaking prod before the User sets the wrangler secret.
  if (env.HUB_ACCESS_KEY) {
    const provided = req.headers.get('X-Hub-Key') ?? ''
    if (!timingSafeEqual(env.HUB_ACCESS_KEY, provided)) {
      // Return 403 with no hint whether the key exists or not
      return json({ error: 'forbidden' }, 403, cors)
    }
  }

  if (!env.HUB_DATA_TOKEN) {
    return json({ error: 'hub_data_not_configured' }, 503, cors)
  }

  const upstream = await fetch(GITHUB_HUB_SNAPSHOT_URL, {
    headers: {
      Authorization: `Bearer ${env.HUB_DATA_TOKEN}`,
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'hub-snapshot-proxy',
    },
  })

  if (!upstream.ok) {
    // WHY: never leak the token or upstream response body in error replies
    return json({ error: 'upstream_error', status: upstream.status }, upstream.status, cors)
  }

  const rawJson = await upstream.text()
  return new Response(rawJson, {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

// --- Route map --------------------------------------------------------------
// Add new endpoints here without touching existing handlers.

type RouteHandler = (req: Request, env: Env, cors: Record<string, string>) => Promise<Response>

const ROUTES: Record<string, RouteHandler> = {
  'POST /strava/token':   handleStravaToken,
  'POST /strava/refresh': handleStravaRefresh,
  // /claude intentionally omitted when CLAUDE_ENDPOINT_ENABLED = false (Strava-AI-Policy 1.6.2026)
  ...(CLAUDE_ENDPOINT_ENABLED ? { 'POST /claude': handleClaude } : {}),
  'GET /hub-snapshot':    handleHubSnapshot,
}

// --- Main entry point -------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''

    // Resolve allowed origin: secret takes priority over wrangler.toml var
    const allowedOrigin =
      env.ALLOWED_ORIGIN ??
      'https://6dwkt42m6p-ux.github.io'   // fallback — überschrieben von ALLOWED_ORIGIN ([vars]/secret)

    const cors = corsHeaders(origin, allowedOrigin)

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return preflight(origin, allowedOrigin)
    }

    // Route dispatch
    const routeKey = `${request.method} ${url.pathname}`
    const handler = ROUTES[routeKey]
    if (!handler) {
      return json({ error: 'not_found', path: url.pathname }, 404, cors)
    }

    // Enforce origin check for non-preflight requests
    if (origin !== allowedOrigin) {
      return json({ error: 'forbidden_origin' }, 403, cors)
    }

    return handler(request, env, cors)
  },
}
