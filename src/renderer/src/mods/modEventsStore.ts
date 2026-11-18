/**
 * Activity of the conversations as the mods holding `events.read` see it (no message content):
 * the last events in memory, and listeners for the live ones.
 */
import { toModEvents, type EngineEventLike, type ModEvent } from '../../../shared/aetherMods'

const MAX_EVENTS = 500
const recent: ModEvent[] = []
const seenTools = new Set<string>()
const listeners = new Set<(event: ModEvent) => void>()

export function recordEngineEventForMods(event: EngineEventLike, at = Date.now()): void {
  for (const modEvent of toModEvents(event, at, seenTools)) {
    recent.push(modEvent)
    if (recent.length > MAX_EVENTS) recent.splice(0, recent.length - MAX_EVENTS)
    for (const listener of listeners) {
      try {
        listener(modEvent)
      } catch {
        // a panel's listener never breaks the others
      }
    }
  }
}

/** The last events, oldest first, at most `limit`. */
export function recentModEvents(limit = MAX_EVENTS): ModEvent[] {
  return recent.slice(-Math.max(1, Math.min(limit, MAX_EVENTS)))
}

export function subscribeModEvents(listener: (event: ModEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
