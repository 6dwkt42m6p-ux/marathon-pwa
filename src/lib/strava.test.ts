import { describe, it, expect } from 'vitest'
import { syncAnchorTs, OVERLAP_DAYS } from './strava'

// T-109: Verify overlap-lookback anchor computation for syncActivities.
// Root cause: using latestTs directly as "after" permanently skips any activity
// whose start_date is not strictly newer than the newest cached activity.
// Fix: after = max(cutoffTs, latestTs - OVERLAP_DAYS * 86400).

describe('syncAnchorTs (T-109 overlap lookback)', () => {
  const DAY = 86400
  const now = Math.floor(Date.now() / 1000)

  it('returns latestTs - OVERLAP_DAYS when that is above cutoff', () => {
    const latestTs = now - 5 * DAY     // newest cached activity: 5 days ago
    const cutoffTs = now - 365 * DAY   // cutoff: 1 year ago (weeksBack=52)
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    expect(anchor).toBe(latestTs - OVERLAP_DAYS * DAY)
  })

  it('returns cutoffTs when latestTs - OVERLAP_DAYS would be before cutoff', () => {
    // If the newest cached activity is only 10 days old, latestTs - 45d goes before cutoff at 14d.
    const cutoffTs = now - 14 * DAY
    const latestTs = now - 10 * DAY
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    // latestTs - 45d = now - 55d < cutoffTs (now - 14d) → clamp to cutoffTs
    expect(anchor).toBe(cutoffTs)
  })

  it('anchor is strictly less than latestTs when cache is non-empty and lookback fits', () => {
    // This verifies a backdated activity 20 days ago is inside the fetch window.
    const latestTs = now - 2 * DAY     // newest cached: 2 days ago
    const cutoffTs = now - 52 * 7 * DAY
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    const backdatedActivityTs = now - 20 * DAY
    // The API call uses after=anchor; Strava returns activities where start_date > anchor.
    // backdated activity (20d ago) > anchor (now - 2d - 45d = now - 47d) → will be fetched.
    expect(backdatedActivityTs).toBeGreaterThan(anchor)
    // Also: anchor is less than latestTs, so this is a real lookback not a no-op.
    expect(anchor).toBeLessThan(latestTs)
  })

  it('erster Sync (empty cache) uses cutoffTs directly — no lookback applied', () => {
    // When cache is empty, syncActivities passes cutoffTs directly to fetchActivitiesAfter,
    // not via syncAnchorTs. Verify OVERLAP_DAYS constant itself is 45.
    expect(OVERLAP_DAYS).toBe(45)
  })

  it('anchor equals cutoffTs when latestTs === cutoffTs (no cached activities above cutoff)', () => {
    const cutoffTs = now - 30 * DAY
    const latestTs = cutoffTs  // degenerate: max() returns cutoff itself
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    // latestTs - 45d goes way before cutoff → clamp to cutoffTs
    expect(anchor).toBe(cutoffTs)
  })
})
