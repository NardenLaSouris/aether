/**
 * Whitelisted IPC surface between renderer and main.
 * Every invoke channel has a zod schema; the main process rejects anything else.
 */
import { z } from 'zod'
import type {
  AppPreferences,
  AuthStatus,
  ClaudeInstallation,
  Conversation,
  DiscoveredSession,
  EngineStatus,
  ExtensionCatalog,
  LogRecord,
  TerminalInfo,
  TerminalShellOption,
  ModelOption,
  AccountSummary,
  PermissionRequest,
  Project,
  QuotaEventRecord,
  QuotaState,
  TimelineItem,
  TokenUsageTotals,
  UsageEventRecord
} from './domain'
import type { AetherModCatalog, GitGraphData } from './aetherMods'
import { ORION_OPERATIONS } from './orionConnect'
import type { EngineEvent, RewindResult } from './engineProtocol'
import type { ChangesSummary, FileContent } from './changes'
import type { BranchInfo, PullRequestInfo } from './branch'
import type { CodexStatus, PilotBranchInfo, PilotSnapshot } from './pilot'
import { panelLayoutSchema } from './panelLayout'
import { EFFORT_LEVELS, IMAGE_MEDIA_TYPES, MAX_IMAGE_BASE64_LENGTH, MAX_IMAGES_PER_MESSAGE } from './domain'

const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const permissionMode = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
const modelValue = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:\-[\]/]+$/)
const absolutePath = z.string().min(1).max(4096)
const terminalShell = z.enum(['powershell', 'pwsh', 'cmd', 'git-bash'])
const terminalColumns = z.number().int().min(2).max(1000)
const terminalRows = z.number().int().min(2).max(500)
/** Plugin ids (`name@marketplace`), mod names and skill names (`plugin:skill`). */
const extensionKey = z.string().min(1).max(300).regex(/^[\p{L}\p{N}_.:@/ -]+$/u)
const modId = z.string().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*$/)

export const ipcSchemas = {
  'app:get-bootstrap': z.undefined(),
  'window:minimize': z.undefined(),
  'window:toggle-maximize': z.undefined(),
  'window:close': z.undefined(),

  'engine:get-status': z.undefined(),
  'engine:restart': z.undefined(),
  'engine:detect-claude': z.undefined(),
  'engine:check-auth': z.undefined(),
  'engine:open-login': z.object({ method: z.enum(['claudeai', 'console']) }),
  'engine:refresh-models': z.undefined(),

  'projects:list': z.undefined(),
  'projects:add': z.object({ directoryPath: absolutePath.optional() }),
  'projects:remove': z.object({ projectId: identifier }),
  'projects:touch': z.object({ projectId: identifier }),

  'conversations:list': z.object({ includeArchived: z.boolean() }),
  'conversations:create': z.object({ projectId: identifier.nullable(), workingDirectory: absolutePath.optional(), title: z.string().max(200).optional(), model: modelValue.nullable().optional() }),
  'conversations:rename': z.object({ conversationId: identifier, title: z.string().trim().min(1).max(200) }),
  'conversations:archive': z.object({ conversationId: identifier, archived: z.boolean() }),
  'conversations:delete': z.object({ conversationId: identifier }),
  'conversations:search': z.object({ query: z.string().max(200) }),
  'conversations:history': z.object({ conversationId: identifier }),
  'conversations:set-model': z.object({ conversationId: identifier, model: modelValue.nullable() }),
  'conversations:set-permission-mode': z.object({ conversationId: identifier, permissionMode }),
  'conversations:set-project': z.object({ conversationId: identifier, projectId: identifier.nullable() }),

  'chat:send': z.object({
    conversationId: identifier,
    text: z.string().min(1).max(200_000),
    clientMessageId: identifier,
    images: z
      .array(z.object({ mediaType: z.enum(IMAGE_MEDIA_TYPES), data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH).regex(/^[A-Za-z0-9+/=]+$/) }))
      .max(MAX_IMAGES_PER_MESSAGE)
      .optional()
  }),
  'chat:set-effort': z.object({ conversationId: identifier, effort: z.enum(EFFORT_LEVELS).nullable() }),
  'files:search': z.object({ conversationId: identifier, query: z.string().max(300) }),
  'files:read': z.object({ conversationId: identifier, path: z.string().min(1).max(4096) }),
  'chat:rewind-files': z.object({ conversationId: identifier, userMessageId: z.string().uuid(), dryRun: z.boolean() }),
  'changes:list': z.object({ conversationId: identifier }),
  'branch:info': z.object({ conversationId: identifier }),
  'branch:create-isolated': z.object({ conversationId: identifier, name: z.string().trim().min(1).max(120) }),
  'branch:push': z.object({ conversationId: identifier }),
  'branch:pull-request': z.object({ conversationId: identifier }),
  'branch:create-pr': z.object({ conversationId: identifier, title: z.string().trim().min(1).max(250), body: z.string().max(60_000), draft: z.boolean() }),
  'branch:remove-worktree': z.object({ conversationId: identifier }),
  'changes:file-diff': z.object({ conversationId: identifier, path: z.string().min(1).max(4096) }),
  'chat:interrupt': z.object({ conversationId: identifier }),
  'chat:permission-decision': z.object({ requestId: identifier, allow: z.boolean(), message: z.string().max(2000).optional(), answers: z.record(z.string().max(1000), z.string().max(4000)).optional() }),
  'chat:pending-permissions': z.undefined(),

  'sessions:list': z.object({ forceRefresh: z.boolean() }),
  'sessions:open': z.object({ sessionId: z.string().uuid() }),

  'usage:get-summary': z.undefined(),
  'usage:check-now': z.undefined(),
  'usage:clear-block': z.undefined(),

  'preferences:get': z.undefined(),
  'preferences:update': z.object({
    defaultModel: modelValue.nullable().optional(),
    defaultPermissionMode: permissionMode.optional(),
    theme: z.enum(['forest', 'charcoal', 'system']).optional(),
    notificationsEnabled: z.boolean().optional(),
    notifyOnTurnComplete: z.boolean().optional(),
    claudeExecutablePath: absolutePath.nullable().optional(),
    autoRefreshSessions: z.boolean().optional(),
    sendWithEnter: z.boolean().optional(),
    terminalShell: terminalShell.optional(),
    panelLayout: panelLayoutSchema.optional(),
    defaultEffort: z.enum(EFFORT_LEVELS).nullable().optional()
  }),

  'apps:open-chatgpt': z.undefined(),

  'pilot:codex-status': z.undefined(),
  'pilot:list': z.undefined(),
  'pilot:get': z.object({ conversationId: identifier }),
  'pilot:branches': z.object({ conversationId: identifier }),
  'pilot:link': z.object({ conversationId: identifier }),
  'pilot:unlink': z.object({ conversationId: identifier }),
  'pilot:start': z.object({
    conversationId: identifier,
    // Checked in depth by pilotConfigSchema in the main process.
    config: z.object({
      objective: z.string().max(8000),
      doneCriteria: z.string().max(4000),
      checks: z.array(z.string().max(500)).max(8),
      allowFileEdits: z.boolean(),
      allowedTools: z.array(z.string().max(320)).max(20),
      allowAllCommands: z.boolean().optional(),
      branch: z
        .discriminatedUnion('mode', [
          z.object({ mode: z.literal('current') }),
          z.object({ mode: z.literal('new') }),
          z.object({ mode: z.literal('existing'), name: z.string().max(200) }),
          z.object({ mode: z.literal('create'), name: z.string().max(200) })
        ])
        .optional(),
      allowProtectedBranch: z.boolean().optional(),
      autoCommit: z.boolean(),
      codexReadsProject: z.boolean()
    })
  }),
  'pilot:pause': z.object({ conversationId: identifier }),
  'pilot:resume': z.object({ conversationId: identifier }),
  'pilot:stop': z.object({ conversationId: identifier }),
  'pilot:answer': z.object({ conversationId: identifier, text: z.string().trim().min(1).max(8000) }),

  'mods:catalog': z.undefined(),
  'mods:set-enabled': z.object({ modId, enabled: z.boolean() }),
  'mods:open-folder': z.undefined(),
  'mods:git-log': z.object({ modId, workingDirectory: absolutePath, limit: z.number().int().min(1).max(1000) }),
  'mods:orion': z.object({ modId, operation: z.enum(ORION_OPERATIONS), params: z.record(z.string(), z.unknown()).default({}) }),

  'extensions:catalog': z.object({ workingDirectory: absolutePath.optional(), refreshPlugins: z.boolean().optional(), refreshSkills: z.boolean().optional() }),
  'extensions:update': z.object({
    changes: z
      .array(z.object({ kind: z.enum(['plugin', 'mod', 'skill']), key: extensionKey, enabled: z.boolean().nullable() }))
      .min(1)
      .max(2000)
  }),

  'terminal:shells': z.undefined(),
  'terminal:list': z.undefined(),
  'terminal:create': z.object({ shell: terminalShell.optional(), workingDirectory: absolutePath.optional(), columns: terminalColumns, rows: terminalRows }),
  'terminal:write': z.object({ terminalId: z.string().uuid(), data: z.string().max(1_000_000) }),
  'terminal:resize': z.object({ terminalId: z.string().uuid(), columns: terminalColumns, rows: terminalRows }),
  'terminal:close': z.object({ terminalId: z.string().uuid() }),
  'terminal:scrollback': z.object({ terminalId: z.string().uuid() }),
  'preferences:pick-executable': z.undefined(),

  'diagnostics:logs': z.object({ limit: z.number().int().min(1).max(2000) }),
  'diagnostics:backup': z.undefined(),
  'diagnostics:open-data-folder': z.undefined(),
  'shell:open-external': z.object({ url: z.string().url().max(2000).refine((value) => value.startsWith('https://'), 'Seuls les liens https sont acceptés.') })
} as const

export type IpcChannel = keyof typeof ipcSchemas
export type IpcInput<Channel extends IpcChannel> = z.input<(typeof ipcSchemas)[Channel]>

export interface BootstrapData {
  appName: string
  appVersion: string
  platform: string
  dataDirectory: string
  preferences: AppPreferences
  /** null until the first detection has completed. */
  installation: ClaudeInstallation | null
  auth: AuthStatus
  engine: EngineStatus
  models: ModelOption[]
  account: AccountSummary | null
  quota: QuotaState
}

export interface UsageSummary {
  quota: QuotaState
  totals: { today: TokenUsageTotals; sevenDays: TokenUsageTotals; allTime: TokenUsageTotals }
  recentUsage: UsageEventRecord[]
  quotaEvents: QuotaEventRecord[]
  subscriptionType: string | null
}

export interface ConversationHistory {
  conversation: Conversation
  items: TimelineItem[]
  source: 'claude-transcript' | 'empty'
  error?: string
}

export interface IpcOutputs {
  'app:get-bootstrap': BootstrapData
  'window:minimize': void
  'window:toggle-maximize': void
  'window:close': void
  'engine:get-status': EngineStatus
  'engine:restart': EngineStatus
  'engine:detect-claude': ClaudeInstallation
  'engine:check-auth': AuthStatus
  'engine:open-login': { launched: boolean; error?: string }
  'engine:refresh-models': { models: ModelOption[]; account: AccountSummary | null; error?: string }
  'projects:list': Project[]
  'projects:add': Project | null
  'projects:remove': void
  'projects:touch': Project | null
  'conversations:list': Conversation[]
  'conversations:create': Conversation
  'conversations:rename': Conversation
  'conversations:archive': Conversation
  'conversations:delete': void
  'conversations:search': Conversation[]
  'conversations:history': ConversationHistory
  'conversations:set-model': Conversation
  'conversations:set-permission-mode': Conversation
  'conversations:set-project': Conversation
  'chat:send': { accepted: boolean; reason?: string }
  'chat:set-effort': AppPreferences
  /** Paths relative to the conversation's folder, best matches first. */
  'files:search': string[]
  'files:read': FileContent
  'chat:rewind-files': RewindResult
  'changes:list': ChangesSummary
  'branch:info': BranchInfo
  'branch:create-isolated': Conversation
  'branch:push': { branch: string }
  'branch:pull-request': PullRequestInfo | null
  /** created: false = the GitHub CLI is not ready, `url` is GitHub's page to open the PR by hand. */
  'branch:create-pr': { url: string; created: boolean }
  'branch:remove-worktree': Conversation
  'changes:file-diff': string
  'chat:interrupt': void
  'chat:permission-decision': void
  'chat:pending-permissions': PermissionRequest[]
  'sessions:list': { sessions: DiscoveredSession[]; refreshedAt: number; error?: string }
  'sessions:open': Conversation
  'usage:get-summary': UsageSummary
  'usage:check-now': QuotaState
  'usage:clear-block': QuotaState
  'preferences:get': AppPreferences
  'preferences:update': AppPreferences
  'preferences:pick-executable': string | null
  'apps:open-chatgpt': { openedIn: 'app' | 'browser' }
  'pilot:codex-status': CodexStatus
  'pilot:list': PilotSnapshot[]
  'pilot:get': PilotSnapshot
  'pilot:branches': PilotBranchInfo
  'pilot:link': PilotSnapshot
  'pilot:unlink': PilotSnapshot
  'pilot:start': PilotSnapshot
  'pilot:pause': PilotSnapshot
  'pilot:resume': PilotSnapshot
  'pilot:stop': PilotSnapshot
  'pilot:answer': PilotSnapshot
  'mods:catalog': AetherModCatalog
  'mods:set-enabled': AetherModCatalog
  'mods:open-folder': void
  'mods:git-log': GitGraphData
  'mods:orion': unknown
  'extensions:catalog': ExtensionCatalog
  'extensions:update': { reloadedConversations: number; busyConversations: number }
  'terminal:shells': TerminalShellOption[]
  'terminal:list': TerminalInfo[]
  'terminal:create': TerminalInfo
  'terminal:write': void
  'terminal:resize': void
  'terminal:close': void
  'terminal:scrollback': string
  'diagnostics:logs': LogRecord[]
  'diagnostics:backup': { filePath: string }
  'diagnostics:open-data-folder': void
  'shell:open-external': void
}

/** Push events main -> renderer. */
export interface PushEvents {
  'engine:event': EngineEvent
  'engine:status': EngineStatus
  'quota:state': QuotaState
  'sessions:updated': { sessions: DiscoveredSession[]; refreshedAt: number }
  'conversations:updated': Conversation
  'permissions:pending': PermissionRequest[]
  'app:toast': { tone: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string }
  'window:maximized': boolean
  'terminal:data': { terminalId: string; data: string }
  'terminal:exit': { terminalId: string; exitCode: number }
  'pilot:state': PilotSnapshot
  /** A user mod's files changed on disk (folder name, or null for the mods folder). */
  'mods:changed': { folder: string | null }
}

export type PushChannel = keyof PushEvents

export const PUSH_CHANNELS: readonly PushChannel[] = ['engine:event', 'engine:status', 'quota:state', 'sessions:updated', 'conversations:updated', 'permissions:pending', 'app:toast', 'window:maximized', 'terminal:data', 'terminal:exit', 'pilot:state', 'mods:changed']

export const INVOKE_CHANNELS = Object.keys(ipcSchemas) as IpcChannel[]

export interface AetherApi {
  invoke<Channel extends IpcChannel>(channel: Channel, ...payload: IpcInput<Channel> extends undefined ? [] : [IpcInput<Channel>]): Promise<IpcOutputs[Channel]>
  on<Channel extends PushChannel>(channel: Channel, listener: (payload: PushEvents[Channel]) => void): () => void
}
