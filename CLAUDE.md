# Marathon Coach PWA — Claude Instructions

React + TypeScript + Vite PWA. GitHub Pages: `https://6dwkt42m6p-ux.github.io/marathon-pwa/`

## Architecture

```
src/
  components/       UI only — no business logic
    Analysis.tsx    Strava data, charts, coach analysis
    TodayWorkout.tsx  Today tab + race countdown
    TrainingPlan.tsx  Plan tab
    VdotPaces.tsx   Paces tab
    Settings.tsx    Settings + Strava OAuth + GitHub Sync
  lib/
    strava.ts       Strava API, OAuth, parsing, localStorage cache
    vdot.ts         Jack Daniels VDOT logic, pace zones, analysis
    plan.ts         Training plan generation
    storage.ts      AppSettings interface + localStorage helpers (incl. notes)
    githubSync.ts   GitHub-based device sync
```

## Coding Rules

- **Logic in lib/, never inline in components** — new calculations → `vdot.ts` or `strava.ts`
- **No Plotly** — mobile-first, CSS bar charts only (`div` with percentage `width`)
- **No `any` without a comment explaining why**
- **localStorage keys** — define as constants near usage or in `storage.ts`
- **Action buttons persist immediately** — `saveSettings({...s, field: val})` + `onUpdate(next)` in the same handler. Never rely on a separate "Save" button to persist single actions. (Learned T-002)
- **Declaration order matters** — declare variables before referencing them (TS2448)

## Common Gotchas

- **GitHub Actions uses Secrets, not .env** — `VITE_STRAVA_CLIENT_SECRET` etc. must be set in repo Settings → Secrets → Actions
- **REDIRECT_URI on GitHub Pages** — always `window.location.origin + import.meta.env.BASE_URL`, never hardcode `'/'`
- **CSS scale segments** — calculate width as `(segmentEnd - scaleMin) / (scaleMax - scaleMin) * 100%`, never use boundary values directly as percentages (Learned T-003)
- **Re-render after child localStorage write** — use a version counter `noteVersion` in parent, increment via callback after save (Learned T-005)

## Build

```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
npm run build
```
Build must be clean before any commit. TypeScript errors are blockers.

## Strava OAuth

- Client ID: `246396` (in `.env` + GitHub Secrets)
- Callback domain registered: `6dwkt42m6p-ux.github.io`
- Auto-switch to Settings tab on `?code=` param, auto-sync after exchange
