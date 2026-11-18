/**
 * Global renderer state (zustand). All data comes from the main process over IPC;
 * nothing here invents engine output.
 */
import { create } from 'zustand'
import type {
  AccountSummary,
  AppPreferences,
  AuthStatus,
  ClaudeInstallation,
  Conversation,
  DiscoveredSession,
  EffortLevel,
  EngineStatus,
  MessageImage,
  ModelOption,
  PermissionRequest,
  Project,
  QuotaState,
  RunnerState,
  TimelineItem
} from '../../../shared/domain'
import type { EngineEvent, ModPane } from '../../../shared/engineProtocol'
import { applyEngineEvent } from '../../../shared/timeline'
import { emptyQuotaState } from '../../../shared/quota'
import { api, errorMessage, newClientId } from '../lib/api'
import { useTokenUsageStore } from '../mods/tokenUsageStore'
import { recordEngineEventForMods } from '../mods/modEventsStore'
import { handleQueueEvent } from './messageQueue'
import type { EngineEventLike } from '../../../shared/aetherMods'

/** Aether's pages, and `mod:<mod id>:<panel id>` for a mod panel shown as a page. */
export type PageId = 'home' | 'conversations' | 'projects' | 'sessions' | 'usage' | 'extensions' | 'settings' | `mod:${string}`

export interface Toast {
  id: string
  tone: 'info' | 'success' | 'warning' | 'error'
  title: string
  body?: string
}

export interface ConversationRuntime {
  runnerState: RunnerState
  activeModel: string | null
  historyLoaded: boolean
  historyError?: string
  loadingHistory: boolean
  /** Status line entries of the mods, by mod name. */
  modStatus: Record<string, string>
  /** Panes the mods opened (shown as a notice: Aether cannot draw them). */
  modPanes: ModPane[]
}

interface AppState {
  ready: boolean
  appName: string
  appVersion: string
  dataDirectory: string
  page: PageId
  preferences: AppPreferences | null
  installation: ClaudeInstallation | null
  auth: AuthStatus | null
  engine: EngineStatus
  models: ModelOption[]
  modelsError?: string
  account: AccountSummary | null
  quota: QuotaState
  projects: Project[]
  conversations: Conversation[]
  showArchived: boolean
  activeConversationId: string | null
  timelines: Record<string, TimelineItem[]>
  runtimes: Record<string, ConversationRuntime>
  pendingPermissions: PermissionRequest[]
  sessions: DiscoveredSession[]
  sessionsRefreshedAt: number
  sessionsError?: string
  sessionsLoading: boolean
  toasts: Toast[]
  windowMaximized: boolean
}

interface AppActions {
  initialise(): Promise<void>
  navigate(page: PageId): void
  toast(toast: Omit<Toast, 'id'>): void
  dismissToast(toastId: string): void
  refreshEnvironment(): Promise<void>
  refreshModels(): Promise<void>
  loadProjects(): Promise<void>
  addProject(): Promise<Project | null>
  removeProject(projectId: string): Promise<void>
  loadConversations(): Promise<void>
  setShowArchived(showArchived: boolean): Promise<void>
  createConversation(projectId: string | null): Promise<Conversation | null>
  openConversation(conversationId: string): Promise<void>
  renameConversation(conversationId: string, title: string): Promise<void>
  archiveConversation(conversationId: string, archived: boolean): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  setConversationModel(conversationId: string, model: string | null): Promise<void>
  setConversationPermissionMode(conversationId: string, mode: Conversation['permissionMode']): Promise<void>
  /** `images`: pasted images (base64 + a data URL shown in the timeline). */
  sendMessage(conversationId: string, text: string, images?: (MessageImage & { preview: string })[]): Promise<boolean>
  /** A new conversation in its own git worktree and branch, from the repository of `fromConversationId`. */
  createIsolatedConversation(fromConversationId: string, name: string): Promise<Conversation | null>
  /** Removes an isolated conversation's worktree (git refuses if it has uncommitted work) and archives it. */
  removeConversationWorktree(conversationId: string): Promise<boolean>
  /** Thinking effort of a conversation; null = back to the default effort. */
  setConversationEffort(conversationId: string, effort: EffortLevel | null): Promise<void>
  interrupt(conversationId: string): Promise<void>
  decidePermission(requestId: string, allow: boolean, message?: string, answers?: Record<string, string>): Promise<void>
  loadSessions(forceRefresh: boolean): Promise<void>
  openSession(sessionId: string): Promise<void>
  updatePreferences(changes: Partial<AppPreferences>): Promise<void>
  handleEngineEvent(event: EngineEvent): void
}

let initialiseStarted = false

const EMPTY_ENGINE: EngineStatus = { hostState: 'stopped', restartCount: 0, activeRunners: 0, busyRunners: 0 }

function defaultRuntime(): ConversationRuntime {
  return { runnerState: 'idle', activeModel: null, historyLoaded: false, loadingHistory: false, modStatus: {}, modPanes: [] }
}

function upsertConversation(list: Conversation[], conversation: Conversation, showArchived: boolean): Conversation[] {
  const without = list.filter((item) => item.id !== conversation.id)
  if (conversation.archived && !showArchived) return without
  return [conversation, ...without].sort((left, right) => right.updatedAt - left.updatedAt)
}

export const useAppStore = create<AppState & AppActions>((set, get) => ({
  ready: false,
  appName: 'Aether',
  appVersion: '',
  dataDirectory: '',
  page: 'home',
  preferences: null,
  installation: null,
  auth: null,
  engine: EMPTY_ENGINE,
  models: [],
  account: null,
  quota: emptyQuotaState(),
  projects: [],
  conversations: [],
  showArchived: false,
  activeConversationId: null,
  timelines: {},
  runtimes: {},
  pendingPermissions: [],
  sessions: [],
  sessionsRefreshedAt: 0,
  sessionsLoading: false,
  toasts: [],
  windowMaximized: false,

  async initialise() {
    // React StrictMode runs effects twice in development: subscribe only once.
    if (initialiseStarted) return
    initialiseStarted = true
    const bootstrap = await api.invoke('app:get-bootstrap')
    document.title = bootstrap.appName
    set({
      ready: true,
      appName: bootstrap.appName,
      appVersion: bootstrap.appVersion,
      dataDirectory: bootstrap.dataDirectory,
      preferences: bootstrap.preferences,
      installation: bootstrap.installation,
      auth: bootstrap.auth,
      engine: bootstrap.engine,
      models: bootstrap.models,
      account: bootstrap.account,
      quota: bootstrap.quota
    })
    api.on('engine:event', (event) => get().handleEngineEvent(event))
    api.on('engine:status', (engine) => set({ engine }))
    api.on('quota:state', (quota) => set({ quota }))
    api.on('permissions:pending', (pendingPermissions) => set({ pendingPermissions }))
    api.on('sessions:updated', ({ sessions, refreshedAt }) => set({ sessions, sessionsRefreshedAt: refreshedAt, sessionsError: undefined }))
    api.on('conversations:updated', (conversation) => set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) })))
    api.on('app:toast', (toast) => get().toast(toast))
    api.on('window:maximized', (windowMaximized) => set({ windowMaximized }))
    await Promise.all([get().loadProjects(), get().loadConversations(), api.invoke('chat:pending-permissions').then((pendingPermissions) => set({ pendingPermissions }))])
    void get().refreshEnvironment()
  },

  navigate(page) {
    set({ page })
  },

  toast(toast) {
    const id = newClientId()
    set((state) => ({ toasts: [...state.toasts.slice(-4), { ...toast, id }] }))
    setTimeout(() => get().dismissToast(id), toast.tone === 'error' ? 9000 : 5000)
  },

  dismissToast(toastId) {
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== toastId) }))
  },

  async refreshEnvironment() {
    try {
      const installation = await api.invoke('engine:detect-claude')
      set({ installation })
      if (!installation.found) return
      const [auth] = await Promise.all([api.invoke('engine:check-auth'), get().loadSessions(false)])
      set({ auth })
      if (auth.loggedIn) await get().refreshModels()
    } catch (error) {
      get().toast({ tone: 'error', title: 'Vérification du moteur impossible', body: errorMessage(error) })
    }
  },

  async refreshModels() {
    const result = await api.invoke('engine:refresh-models')
    set({ models: result.models, account: result.account, modelsError: result.error })
  },

  async loadProjects() {
    set({ projects: await api.invoke('projects:list') })
  },

  async addProject() {
    try {
      const project = await api.invoke('projects:add', {})
      if (project) {
        await get().loadProjects()
        get().toast({ tone: 'success', title: 'Projet ajouté', body: project.directoryPath })
      }
      return project
    } catch (error) {
      get().toast({ tone: 'error', title: 'Ajout du projet impossible', body: errorMessage(error) })
      return null
    }
  },

  async removeProject(projectId) {
    await api.invoke('projects:remove', { projectId })
    await Promise.all([get().loadProjects(), get().loadConversations()])
  },

  async loadConversations() {
    set({ conversations: await api.invoke('conversations:list', { includeArchived: get().showArchived }) })
  },

  async setShowArchived(showArchived) {
    set({ showArchived })
    await get().loadConversations()
  },

  async createConversation(projectId) {
    try {
      const conversation = await api.invoke('conversations:create', { projectId })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived), timelines: { ...state.timelines, [conversation.id]: [] }, runtimes: { ...state.runtimes, [conversation.id]: { ...defaultRuntime(), historyLoaded: true } }, activeConversationId: conversation.id, page: 'conversations' }))
      return conversation
    } catch (error) {
      get().toast({ tone: 'error', title: 'Création impossible', body: errorMessage(error) })
      return null
    }
  },

  async createIsolatedConversation(fromConversationId, name) {
    try {
      const conversation = await api.invoke('branch:create-isolated', { conversationId: fromConversationId, name })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived), timelines: { ...state.timelines, [conversation.id]: [] }, runtimes: { ...state.runtimes, [conversation.id]: { ...defaultRuntime(), historyLoaded: true } }, activeConversationId: conversation.id, page: 'conversations' }))
      get().toast({ tone: 'success', title: 'Conversation isolée', body: `Branche et dossier à part : ${conversation.workingDirectory}` })
      return conversation
    } catch (error) {
      get().toast({ tone: 'error', title: 'Conversation isolée impossible', body: errorMessage(error) })
      return null
    }
  },

  async removeConversationWorktree(conversationId) {
    try {
      const conversation = await api.invoke('branch:remove-worktree', { conversationId })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) }))
      get().toast({ tone: 'success', title: 'Worktree supprimé', body: 'La conversation est archivée ; sa branche est conservée.' })
      return true
    } catch (error) {
      get().toast({ tone: 'error', title: 'Worktree non supprimé', body: errorMessage(error) })
      return false
    }
  },

  async openConversation(conversationId) {
    set({ activeConversationId: conversationId, page: 'conversations' })
    const runtime = get().runtimes[conversationId]
    if (runtime?.historyLoaded || runtime?.loadingHistory) return
    set((state) => ({ runtimes: { ...state.runtimes, [conversationId]: { ...(state.runtimes[conversationId] ?? defaultRuntime()), loadingHistory: true } } }))
    try {
      const history = await api.invoke('conversations:history', { conversationId })
      set((state) => ({
        timelines: { ...state.timelines, [conversationId]: [...history.items, ...(state.timelines[conversationId] ?? [])] },
        runtimes: { ...state.runtimes, [conversationId]: { ...(state.runtimes[conversationId] ?? defaultRuntime()), historyLoaded: true, loadingHistory: false, historyError: history.error } }
      }))
    } catch (error) {
      set((state) => ({ runtimes: { ...state.runtimes, [conversationId]: { ...(state.runtimes[conversationId] ?? defaultRuntime()), historyLoaded: true, loadingHistory: false, historyError: errorMessage(error) } } }))
    }
  },

  async renameConversation(conversationId, title) {
    const conversation = await api.invoke('conversations:rename', { conversationId, title })
    set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) }))
  },

  async archiveConversation(conversationId, archived) {
    const conversation = await api.invoke('conversations:archive', { conversationId, archived })
    set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived), activeConversationId: archived && state.activeConversationId === conversationId ? null : state.activeConversationId }))
    get().toast({ tone: 'info', title: archived ? 'Conversation archivée' : 'Conversation restaurée' })
  },

  async deleteConversation(conversationId) {
    await api.invoke('conversations:delete', { conversationId })
    set((state) => {
      const timelines = { ...state.timelines }
      delete timelines[conversationId]
      return { conversations: state.conversations.filter((item) => item.id !== conversationId), timelines, activeConversationId: state.activeConversationId === conversationId ? null : state.activeConversationId }
    })
  },

  async setConversationModel(conversationId, model) {
    try {
      const conversation = await api.invoke('conversations:set-model', { conversationId, model })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) }))
    } catch (error) {
      get().toast({ tone: 'error', title: 'Changement de modèle impossible', body: errorMessage(error) })
    }
  },

  async setConversationPermissionMode(conversationId, permissionMode) {
    try {
      const conversation = await api.invoke('conversations:set-permission-mode', { conversationId, permissionMode })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) }))
    } catch (error) {
      get().toast({ tone: 'error', title: 'Changement de mode impossible', body: errorMessage(error) })
    }
  },

  async sendMessage(conversationId, text, images = []) {
    const clientMessageId = newClientId()
    try {
      const result = await api.invoke('chat:send', { conversationId, text, clientMessageId, ...(images.length > 0 ? { images: images.map(({ mediaType, data }) => ({ mediaType, data })) } : {}) })
      if (!result.accepted) {
        get().toast({ tone: 'warning', title: 'Message non envoyé', body: result.reason })
        return false
      }
      set((state) => ({
        timelines: { ...state.timelines, [conversationId]: [...(state.timelines[conversationId] ?? []), { kind: 'user', id: clientMessageId, text, timestamp: Date.now(), ...(images.length > 0 ? { images: images.map((image) => image.preview) } : {}) }] },
        runtimes: { ...state.runtimes, [conversationId]: { ...(state.runtimes[conversationId] ?? defaultRuntime()), runnerState: 'running', historyLoaded: true } }
      }))
      return true
    } catch (error) {
      get().toast({ tone: 'error', title: 'Envoi impossible', body: errorMessage(error) })
      return false
    }
  },

  async setConversationEffort(conversationId, effort) {
    try {
      const preferences = await api.invoke('chat:set-effort', { conversationId, effort })
      set({ preferences })
    } catch (error) {
      get().toast({ tone: 'error', title: 'Effort non modifié', body: errorMessage(error) })
    }
  },

  async interrupt(conversationId) {
    await api.invoke('chat:interrupt', { conversationId })
  },

  async decidePermission(requestId, allow, message, answers) {
    set((state) => ({ pendingPermissions: state.pendingPermissions.filter((request) => request.requestId !== requestId) }))
    await api.invoke('chat:permission-decision', { requestId, allow, message, ...(answers ? { answers } : {}) })
  },

  async loadSessions(forceRefresh) {
    set({ sessionsLoading: true })
    try {
      const result = await api.invoke('sessions:list', { forceRefresh })
      set({ sessions: result.sessions, sessionsRefreshedAt: result.refreshedAt, sessionsError: result.error, sessionsLoading: false })
    } catch (error) {
      set({ sessionsError: errorMessage(error), sessionsLoading: false })
    }
  },

  async openSession(sessionId) {
    try {
      const conversation = await api.invoke('sessions:open', { sessionId })
      set((state) => ({ conversations: upsertConversation(state.conversations, conversation, state.showArchived) }))
      await get().openConversation(conversation.id)
      void get().loadSessions(false)
    } catch (error) {
      get().toast({ tone: 'error', title: 'Reprise impossible', body: errorMessage(error) })
    }
  },

  async updatePreferences(changes) {
    try {
      const preferences = await api.invoke('preferences:update', changes)
      set({ preferences })
      if ('claudeExecutablePath' in changes) await get().refreshEnvironment()
    } catch (error) {
      get().toast({ tone: 'error', title: 'Préférence non enregistrée', body: errorMessage(error) })
    }
  },

  handleEngineEvent(event) {
    if (event.type === 'log' || event.type === 'child_process') return
    recordEngineEventForMods(event as unknown as EngineEventLike)
    if (event.type === 'token_usage') {
      useTokenUsageStore.getState().add(event)
      return
    }
    if (event.type === 'mod_toast') {
      get().toast({ tone: 'info', title: event.plugin, body: event.text })
      return
    }
    const conversationId = event.conversationId
    set((state) => {
      const runtime = state.runtimes[conversationId] ?? defaultRuntime()
      let nextRuntime = runtime
      if (event.type === 'runner_state') nextRuntime = { ...runtime, runnerState: event.state === 'ready' ? (runtime.runnerState === 'running' ? 'running' : 'ready') : event.state }
      else if (event.type === 'session_init') nextRuntime = { ...runtime, activeModel: event.model }
      else if (event.type === 'assistant_message' && event.model) nextRuntime = { ...runtime, activeModel: event.model }
      else if (event.type === 'mod_status') {
        const modStatus = { ...runtime.modStatus }
        if (event.text === null) delete modStatus[event.plugin]
        else modStatus[event.plugin] = event.text
        nextRuntime = { ...runtime, modStatus }
      } else if (event.type === 'mod_panes') nextRuntime = { ...runtime, modPanes: event.panes }
      const timeline = state.timelines[conversationId] ?? []
      const nextTimeline = applyEngineEvent(timeline, event, Date.now())
      return {
        runtimes: nextRuntime === runtime ? state.runtimes : { ...state.runtimes, [conversationId]: nextRuntime },
        timelines: nextTimeline === timeline ? state.timelines : { ...state.timelines, [conversationId]: nextTimeline }
      }
    })
    // Messages queued while Claude worked go at its next pause (a tool result, or the end of the turn).
    handleQueueEvent(event, (target, text, images) => get().sendMessage(target, text, images))
  }
}))
