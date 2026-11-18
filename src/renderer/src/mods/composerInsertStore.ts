/**
 * Text a mod asks to put in the message box of a conversation (`composer.insert`).
 * The Composer of that conversation takes it into its draft; the user reads and sends it.
 */
import { create } from 'zustand'

export interface ComposerInsert {
  conversationId: string
  text: string
  /** Replace the draft instead of appending to it. */
  replace: boolean
  nonce: number
}

interface ComposerInsertState {
  pending: ComposerInsert | null
  insert(conversationId: string, text: string, replace: boolean): void
  take(nonce: number): void
}

let counter = 0

export const useComposerInsertStore = create<ComposerInsertState>((set, get) => ({
  pending: null,
  insert(conversationId, text, replace) {
    counter += 1
    set({ pending: { conversationId, text, replace, nonce: counter } })
  },
  take(nonce) {
    if (get().pending?.nonce === nonce) set({ pending: null })
  }
}))
