import { useState, useEffect, useRef } from 'react'
import type { AppSettings } from '../lib/storage'
import { getCachedActivities } from '../lib/strava'
import {
  loadChatHistory,
  saveChatHistory,
  clearChatHistory,
  buildSystemPrompt,
  sendChatMessage,
  type ChatMessage,
} from '../lib/coachChat'

interface Props {
  settings: AppSettings
  online: boolean
}

export default function CoachChat({ settings, online }: Props) {
  // All hooks at the top — no early returns before hook calls
  const [messages, setMessages]     = useState<ChatMessage[]>(loadChatHistory)
  const [input, setInput]           = useState('')
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const bottomRef                   = useRef<HTMLDivElement>(null)

  // Auto-scroll when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text }
    const next = [...messages, userMsg]

    setMessages(next)
    saveChatHistory(next)
    setInput('')
    setError(null)
    setLoading(true)

    try {
      const activities  = getCachedActivities()
      const systemPrompt = buildSystemPrompt(settings, activities)
      const reply = await sendChatMessage(next, systemPrompt)

      const withReply = [...next, { role: 'assistant' as const, content: reply }]
      setMessages(withReply)
      saveChatHistory(withReply)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unbekannter Fehler'
      setError(`Fehler: ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Send on Enter (without Shift) — Shift+Enter inserts newline
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleClear() {
    clearChatHistory()
    setMessages([])
    setError(null)
  }

  return (
    <div className="tab-content coach-chat">
      <div className="coach-chat-header">
        <span className="section-title">Coach AI</span>
        {messages.length > 0 && (
          <button className="coach-clear-btn" onClick={handleClear} title="Verlauf löschen">
            Leeren
          </button>
        )}
      </div>

      {!online && (
        <div className="coach-offline-note" role="status">
          Coach nicht verfügbar ohne Internetverbindung
        </div>
      )}

      <div className="coach-messages">
        {messages.length === 0 && (
          <div className="coach-empty">
            <div className="coach-empty-icon">🤖</div>
            <div className="coach-empty-text">
              Stelle dem Coach eine Frage zu deinem Training.
            </div>
            <div className="coach-empty-sub">
              Kontext: VDOT {settings.vdot.toFixed(1)}, letzte Aktivitäten aus Strava
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`coach-msg coach-msg--${msg.role}`}>
            <div className="coach-msg-bubble">{msg.content}</div>
          </div>
        ))}

        {loading && (
          <div className="coach-msg coach-msg--assistant">
            <div className="coach-msg-bubble coach-msg-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}

        {error && (
          <div className="coach-error" role="alert">{error}</div>
        )}

        <div ref={bottomRef} />
      </div>

      <div className="coach-input-row">
        <textarea
          className="coach-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={online ? 'Frage an den Coach …' : 'Offline — kein Chat verfügbar'}
          disabled={!online || loading}
          rows={2}
          aria-label="Nachricht an Coach"
        />
        <button
          className="coach-send-btn"
          onClick={handleSend}
          disabled={!online || loading || !input.trim()}
          aria-label="Senden"
        >
          {loading ? '…' : '↑'}
        </button>
      </div>
    </div>
  )
}
