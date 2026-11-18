/**
 * Renderer side of the Codex pilot: the snapshots the main process pushes, and the user's actions.
 * The loop itself runs in the main process; this store only shows it and forwards clicks.
 */
import { create } from 'zustand'
import type { CodexStatus, PilotBranchInfo, PilotConfig, PilotSnapshot } from '../../../shared/pilot'
import { api, errorMessage } from '../lib/api'
import { useAppStore } from '../stores/appStore'

interface PilotStore {
  snapshots: Record<string, PilotSnapshot>
  codex: CodexStatus | null
  checkingCodex: boolean
  busy: Record<string, boolean>
  load(): Promise<void>
  fetch(conversationId: string): Promise<void>
  branches(conversationId: string): Promise<PilotBranchInfo | null>
  refreshCodex(): Promise<CodexStatus | null>
  link(conversationId: string): Promise<boolean>
  unlink(conversationId: string): Promise<void>
  start(conversationId: string, config: PilotConfig): Promise<boolean>
  pause(conversationId: string): Promise<void>
  resume(conversationId: string): Promise<void>
  stop(conversationId: string): Promise<void>
  answer(conversationId: string, text: string): Promise<boolean>
}

let subscribed = false

export const usePilotStore = create<PilotStore>((set, get) => {
  const store = (snapshot: PilotSnapshot): void => set((state) => ({ snapshots: { ...state.snapshots, [snapshot.conversationId]: snapshot } }))
  const fail = (title: string, error: unknown): void => useAppStore.getState().toast({ tone: 'error', title, body: errorMessage(error) })
  const withBusy = async <Value>(conversationId: string, action: () => Promise<Value>): Promise<Value> => {
    set((state) => ({ busy: { ...state.busy, [conversationId]: true } }))
    try {
      return await action()
    } finally {
      set((state) => ({ busy: { ...state.busy, [conversationId]: false } }))
    }
  }
  return {
    snapshots: {},
    codex: null,
    checkingCodex: false,
    busy: {},
    async load() {
      if (!subscribed) {
        subscribed = true
        api.on('pilot:state', store)
      }
      try {
        const snapshots = await api.invoke('pilot:list')
        set((state) => ({ snapshots: { ...state.snapshots, ...Object.fromEntries(snapshots.map((snapshot) => [snapshot.conversationId, snapshot])) } }))
      } catch (error) {
        fail('Pilote Codex indisponible', error)
      }
    },
    async fetch(conversationId) {
      try {
        store(await api.invoke('pilot:get', { conversationId }))
      } catch {
        // shown as "not linked"
      }
    },
    async branches(conversationId) {
      try {
        return await api.invoke('pilot:branches', { conversationId })
      } catch (error) {
        fail('Branches git illisibles', error)
        return null
      }
    },
    async refreshCodex() {
      set({ checkingCodex: true })
      try {
        const codex = await api.invoke('pilot:codex-status')
        set({ codex })
        return codex
      } catch (error) {
        fail('Vérification de Codex impossible', error)
        return null
      } finally {
        set({ checkingCodex: false })
      }
    },
    link: (conversationId) =>
      withBusy(conversationId, async () => {
        try {
          store(await api.invoke('pilot:link', { conversationId }))
          void get().refreshCodex()
          return true
        } catch (error) {
          fail('Impossible de lier Codex', error)
          void get().refreshCodex()
          return false
        }
      }),
    unlink: (conversationId) =>
      withBusy(conversationId, async () => {
        try {
          store(await api.invoke('pilot:unlink', { conversationId }))
        } catch (error) {
          fail('Impossible de détacher Codex', error)
        }
      }),
    start: (conversationId, config) =>
      withBusy(conversationId, async () => {
        try {
          store(await api.invoke('pilot:start', { conversationId, config }))
          return true
        } catch (error) {
          fail('Le pilote n’a pas démarré', error)
          return false
        }
      }),
    async pause(conversationId) {
      try {
        store(await api.invoke('pilot:pause', { conversationId }))
      } catch (error) {
        fail('Pause impossible', error)
      }
    },
    async resume(conversationId) {
      try {
        store(await api.invoke('pilot:resume', { conversationId }))
      } catch (error) {
        fail('Reprise impossible', error)
      }
    },
    stop: (conversationId) =>
      withBusy(conversationId, async () => {
        try {
          store(await api.invoke('pilot:stop', { conversationId }))
        } catch (error) {
          fail('Arrêt impossible', error)
        }
      }),
    async answer(conversationId, text) {
      try {
        store(await api.invoke('pilot:answer', { conversationId, text }))
        return true
      } catch (error) {
        fail('Réponse non transmise', error)
        return false
      }
    }
  }
})
