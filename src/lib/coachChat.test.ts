// T-170: saveChatHistory quota hardening — safeSetItem never throws, sets STORAGE_WARNING_KEY
// on unhealable quota failure (App-Banner aus T-163 greift automatisch, kein dediziertes UI nötig).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { saveChatHistory, loadChatHistory, COACH_HISTORY_KEY, type ChatMessage } from './coachChat'
import { registerEvictCallback, STORAGE_WARNING_KEY } from './storage'

describe('saveChatHistory — T-170 quota hardening', () => {
  beforeEach(() => { localStorage.clear(); registerEvictCallback(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  const msgs: ChatMessage[] = [{ role: 'user', content: 'Hallo' }]

  it('successful save → persisted', () => {
    saveChatHistory(msgs)
    expect(loadChatHistory()).toEqual(msgs)
  })

  it('quota exhausted → does not throw, sets STORAGE_WARNING_KEY', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === COACH_HISTORY_KEY) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    let threw = false
    try { saveChatHistory(msgs) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })
})
