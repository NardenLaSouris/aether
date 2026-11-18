/**
 * Live token usage of every conversation, as the engine streams it (one sample per API response step).
 * Kept in memory for the last 30 minutes; given to mod panels holding `usage.read`.
 */
import { create } from 'zustand'
import type { TokenSample, TokenUsageSnapshot } from '../../../shared/aetherMods'
import type { EngineEvent } from '../../../shared/engineProtocol'

export const TOKEN_HISTORY_MS = 30 * 60_000
const MAX_SAMPLES = 6000

type Listener = (sample: TokenSample) => void

interface TokenUsageState {
  samples: TokenSample[]
  add(event: Extract<EngineEvent, { type: 'token_usage' }>, at?: number): void
  snapshot(now?: number): TokenUsageSnapshot
  /** Called with each new sample; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void
}

const listeners = new Set<Listener>()

export function pruneSamples(samples: TokenSample[], now: number): TokenSample[] {
  const since = now - TOKEN_HISTORY_MS
  let start = 0
  while (start < samples.length && (samples[start] as TokenSample).at < since) start += 1
  if (samples.length - start > MAX_SAMPLES) start = samples.length - MAX_SAMPLES
  return start === 0 ? samples : samples.slice(start)
}

export const useTokenUsageStore = create<TokenUsageState>((set, get) => ({
  samples: [],
  add(event, at = Date.now()) {
    const sample: TokenSample = {
      at,
      conversationId: event.conversationId,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadInputTokens: event.cacheReadInputTokens,
      cacheCreationInputTokens: event.cacheCreationInputTokens,
      subagent: event.subagent
    }
    set({ samples: pruneSamples([...get().samples, sample], at) })
    for (const listener of listeners) {
      try {
        listener(sample)
      } catch {
        // a panel's listener never breaks the others
      }
    }
  },
  snapshot(now = Date.now()) {
    return { now, samples: pruneSamples(get().samples, now) }
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
}))
