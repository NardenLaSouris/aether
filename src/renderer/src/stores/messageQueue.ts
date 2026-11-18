/**
 * Messages written while Claude works, as in Claude Code:
 * - queued: they wait in the message box (editable, removable) and are handed to Claude at its next
 *   pause — the end of a tool call or of the turn. Claude Code reads a message received mid-turn at
 *   its next step, in the same turn.
 * - "interrupt and send": the turn is stopped and the message goes as soon as Claude has stopped.
 */
import { create } from 'zustand'
import { MAX_IMAGES_PER_MESSAGE, type MessageImage } from '../../../shared/domain'
import type { EngineEvent } from '../../../shared/engineProtocol'

export interface QueuedMessage {
  id: string
  text: string
  images: (MessageImage & { preview: string })[]
}

type Sender = (conversationId: string, text: string, images: QueuedMessage['images']) => Promise<boolean>

interface MessageQueueState {
  queues: Record<string, QueuedMessage[]>
  /** Conversations whose turn is being stopped so the queue goes right after. */
  interrupting: Record<string, boolean>
  enqueue(conversationId: string, message: Omit<QueuedMessage, 'id'>, first?: boolean): void
  remove(conversationId: string, id: string): void
  /** Takes a queued message out (to edit it in the message box). */
  take(conversationId: string, id: string): QueuedMessage | null
  setInterrupting(conversationId: string, value: boolean): void
  clear(conversationId: string): void
}

export const useMessageQueue = create<MessageQueueState>((set, get) => ({
  queues: {},
  interrupting: {},
  enqueue(conversationId, message, first = false) {
    const item: QueuedMessage = { ...message, id: crypto.randomUUID() }
    set((state) => {
      const queue = state.queues[conversationId] ?? []
      return { queues: { ...state.queues, [conversationId]: first ? [item, ...queue] : [...queue, item] } }
    })
  },
  remove(conversationId, id) {
    set((state) => ({ queues: { ...state.queues, [conversationId]: (state.queues[conversationId] ?? []).filter((item) => item.id !== id) } }))
  },
  take(conversationId, id) {
    const item = (get().queues[conversationId] ?? []).find((entry) => entry.id === id) ?? null
    if (item) get().remove(conversationId, id)
    return item
  },
  setInterrupting(conversationId, value) {
    set((state) => ({ interrupting: { ...state.interrupting, [conversationId]: value } }))
  },
  clear(conversationId) {
    set((state) => ({ queues: { ...state.queues, [conversationId]: [] }, interrupting: { ...state.interrupting, [conversationId]: false } }))
  }
}))

/** All queued messages as one message, the way Claude Code sends several queued prompts together. */
export function combineQueued(items: QueuedMessage[]): { text: string; images: QueuedMessage['images'] } {
  return {
    text: items
      .map((item) => item.text.trim())
      .filter(Boolean)
      .join('\n\n'),
    images: items.flatMap((item) => item.images).slice(0, MAX_IMAGES_PER_MESSAGE)
  }
}

/** When the queue of a conversation is handed to Claude: at a tool result (mid-turn), or once the turn has ended. */
export function queueFlushPoint(event: EngineEvent): string | null {
  if (event.type === 'tool_result') return event.conversationId
  if (event.type === 'runner_state' && (event.state === 'idle' || event.state === 'ready')) return event.conversationId
  return null
}

const flushing = new Set<string>()

/** Sends the queue of a conversation as one message; puts it back if the send is refused. */
export async function flushQueue(conversationId: string, send: Sender): Promise<void> {
  const store = useMessageQueue.getState()
  const items = store.queues[conversationId] ?? []
  if (items.length === 0 || flushing.has(conversationId)) return
  flushing.add(conversationId)
  store.clear(conversationId)
  try {
    const message = combineQueued(items)
    const sent = message.text ? await send(conversationId, message.text, message.images) : true
    if (!sent) for (const item of [...items].reverse()) useMessageQueue.getState().enqueue(conversationId, { text: item.text, images: item.images }, true)
  } finally {
    flushing.delete(conversationId)
  }
}

/** Called for each engine event: hands the queue over at Claude's next pause. */
export function handleQueueEvent(event: EngineEvent, send: Sender): void {
  const conversationId = queueFlushPoint(event)
  if (!conversationId) return
  const state = useMessageQueue.getState()
  if (event.type === 'tool_result' && state.interrupting[conversationId]) return // wait for the stop
  if (event.type === 'runner_state' && state.interrupting[conversationId]) state.setInterrupting(conversationId, false)
  if ((state.queues[conversationId] ?? []).length > 0) void flushQueue(conversationId, send)
}
