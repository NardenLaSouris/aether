/**
 * Domain types shared by the main process, the engine host and the renderer.
 * Everything here must stay JSON-serialisable (it crosses process boundaries).
 */
import { DEFAULT_LAYOUT, type PanelLayout } from './panelLayout'

export type PermissionModeOption = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/**
 * Permission modes the user can choose. `bypassPermissions` ("tout autoriser", like
 * `claude --dangerously-skip-permissions`) is only ever set by an explicit, confirmed choice of the user.
 */
/** How much Claude thinks before answering (Claude Code's /effort). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** Images pasted in the message box: what Claude accepts. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]
export const MAX_IMAGES_PER_MESSAGE = 5
/** Base64 length of a 5 MB image. */
export const MAX_IMAGE_BASE64_LENGTH = 7_000_000
export interface MessageImage {
  mediaType: ImageMediaType
  /** Base64, without the data: prefix. */
  data: string
}

export const SELECTABLE_PERMISSION_MODES: readonly PermissionModeOption[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

export interface Project {
  id: string
  name: string
  directoryPath: string
  createdAt: number
  lastOpenedAt: number
}

export type ConversationOrigin = 'aether' | 'imported'

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  /** Working directory the engine runs in. */
  workingDirectory: string
  /** Claude Code session id once known (from system/init or from discovery). */
  claudeSessionId: string | null
  model: string | null
  permissionMode: PermissionModeOption
  archived: boolean
  origin: ConversationOrigin
  createdAt: number
  updatedAt: number
}

export type RunnerState = 'idle' | 'starting' | 'ready' | 'running' | 'interrupting' | 'closed' | 'error'

export interface ToolUseBlock {
  kind: 'tool_use'
  toolUseId: string
  toolName: string
  input: unknown
}

export interface TextBlock {
  kind: 'text'
  text: string
}

export interface ThinkingBlock {
  kind: 'thinking'
  text: string
}

export type AssistantBlock = TextBlock | ThinkingBlock | ToolUseBlock

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; timestamp: number; images?: string[] }
  | { kind: 'assistant'; id: string; blocks: AssistantBlock[]; model: string | null; timestamp: number; streaming: boolean; parentToolUseId: string | null }
  | { kind: 'tool_result'; id: string; toolUseId: string; content: string; isError: boolean; timestamp: number }
  | { kind: 'system'; id: string; text: string; tone: 'info' | 'warning' | 'error'; timestamp: number }
  | { kind: 'turn_summary'; id: string; durationMs: number; costUsd: number | null; inputTokens: number; outputTokens: number; isError: boolean; timestamp: number }

export interface ModelOption {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
  supportsEffort?: boolean
  supportsFastMode?: boolean
}

export interface AccountSummary {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?: string
}

export interface ClaudeInstallation {
  found: boolean
  executablePath: string | null
  version: string | null
  detectionSource: 'preference' | 'path' | 'known-location' | 'none'
  error?: string
}

export interface AuthStatus {
  checked: boolean
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  email?: string
  subscriptionType?: string
  loginExpiresAt?: string
  error?: string
}

export type EngineHostState = 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'failed'

export interface EngineStatus {
  hostState: EngineHostState
  restartCount: number
  lastError?: string
  activeRunners: number
  busyRunners: number
}

export interface PermissionRequest {
  requestId: string
  conversationId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  title?: string
  description?: string
  decisionReason?: string
  blockedPath?: string
  displayName?: string
  createdAt: number
}

export interface PermissionDecision {
  requestId: string
  allow: boolean
  message?: string
}

/** A session discovered in Claude Code's local storage via the official SDK `listSessions()`. */
export interface DiscoveredSession {
  sessionId: string
  summary: string
  lastModified: number
  createdAt?: number
  cwd?: string
  gitBranch?: string
  firstPrompt?: string
  customTitle?: string
  fileSize?: number
  /** Aether conversation already bound to this session, if any. */
  linkedConversationId?: string
  /** Whether the working directory still exists; resuming needs it. */
  cwdExists: boolean
}

// ---------------------------------------------------------------------------
// Usage / quota. Three distinct families, never mixed:
//   1. tokens consumed by requests (from `result` messages)
//   2. Claude subscription limits (rate_limit_event, usage API utilisation)
//   3. API limits (HTTP 429 / api_retry for API-key users)
// ---------------------------------------------------------------------------

export type LimitKind =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_overage_included'
  | 'overage'
  | 'api_rate_limit'
  | 'unknown_usage_limit'

export type LimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface SubscriptionWindow {
  kind: LimitKind
  /** 0-100 percentage as reported by Claude Code, or null when not reported. */
  utilizationPercent: number | null
  resetsAt: number | null
  status: LimitStatus | null
  observedAt: number
  source: 'rate_limit_event' | 'usage_api' | 'error_message'
}

export interface TokenUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** Estimated cost reported by Claude Code (an estimate, not a bill). */
  estimatedCostUsd: number
  turns: number
}

export type BlockReason = 'subscription_limit' | 'api_rate_limit'

export interface QuotaBlock {
  reason: BlockReason
  limitKind: LimitKind
  /** Reset time from a reliable source, or null when unknown. */
  resetsAt: number | null
  detectedAt: number
  message: string
  source: SubscriptionWindow['source']
}

export interface QuotaState {
  /** Present while new requests are suspended. */
  block: QuotaBlock | null
  windows: SubscriptionWindow[]
  /** True if the official usage API reported that plan rate limits apply to this account. */
  rateLimitsAvailable: boolean | null
  usageApiError?: string
  lastUsageCheckAt: number | null
  nextAutomaticCheckAt: number | null
}

export interface UsageEventRecord {
  id: number
  conversationId: string | null
  claudeSessionId: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  estimatedCostUsd: number | null
  durationMs: number
  isError: boolean
  createdAt: number
}

export interface QuotaEventRecord {
  id: number
  eventType: 'limit_detected' | 'warning' | 'reset_confirmed' | 'reset_time_reached' | 'check' | 'cleared_manually'
  limitKind: string | null
  status: string | null
  utilizationPercent: number | null
  resetsAt: number | null
  message: string | null
  createdAt: number
}

export interface LogRecord {
  id: number
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
  details: string | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// Extensions: Claude Code plugins, mods (local plugins in ~/.claude/dev-mods) and skills.
// Aether never edits Claude Code's own configuration: its choices only apply to the
// sessions Aether starts, through official SDK options (`settings.enabledPlugins`,
// `plugins`, `skills`).
// ---------------------------------------------------------------------------

/** Per-extension choices made in Aether. A missing key means "same as Claude Code" (mods: enabled). */
export interface ExtensionOverrides {
  plugins: Record<string, boolean>
  mods: Record<string, boolean>
  skills: Record<string, boolean>
}

export const EMPTY_EXTENSION_OVERRIDES: ExtensionOverrides = { plugins: {}, mods: {}, skills: {} }

export interface PluginEntry {
  /** `name@marketplace`, as Claude Code names it. */
  id: string
  name: string
  version: string | null
  description: string | null
  scope: string
  installPath: string | null
  enabledInClaudeCode: boolean
  enabled: boolean
  overridden: boolean
}

export interface ModEntry {
  name: string
  description: string | null
  version: string | null
  directoryPath: string
  enabled: boolean
  overridden: boolean
  /** Mods also draw UI in Claude Code's own interface; that part is not shown in Aether. */
  hasUiHooks: boolean
}

export interface SkillEntry {
  /** Name as Claude Code resolves it (`plugin:skill` for plugin skills). */
  name: string
  description: string
  /** Plugin or mod name for qualified names, null for your own skills and commands. */
  owner: string | null
  builtin: boolean
  enabled: boolean
  overridden: boolean
}

export interface ExtensionCatalog {
  plugins: PluginEntry[]
  mods: ModEntry[]
  skills: SkillEntry[]
  /** Directory the skill list was read for (project skills depend on it). */
  skillsDirectory: string | null
  skillsReadAt: number | null
  errors: string[]
}

/** What a runner receives to apply the Aether extension choices. */
export interface RunnerExtensions {
  pluginToggles: Record<string, boolean>
  modDirectories: string[]
  /** Allow-list passed to the SDK `skills` option, or null to keep Claude Code's defaults. */
  skills: string[] | null
}

export type TerminalShellId = 'powershell' | 'pwsh' | 'cmd' | 'git-bash'

export interface TerminalShellOption {
  id: TerminalShellId
  label: string
  executablePath: string
}

export interface TerminalInfo {
  terminalId: string
  shell: TerminalShellId
  label: string
  workingDirectory: string
  pid: number
  createdAt: number
  exited: boolean
  exitCode: number | null
}

export type ThemePreference = 'forest' | 'charcoal' | 'system'

export interface AppPreferences {
  defaultModel: string | null
  defaultPermissionMode: PermissionModeOption
  theme: ThemePreference
  notificationsEnabled: boolean
  notifyOnTurnComplete: boolean
  claudeExecutablePath: string | null
  lastDirectory: string | null
  autoRefreshSessions: boolean
  sendWithEnter: boolean
  extensionOverrides: ExtensionOverrides
  terminalShell: TerminalShellId
  /** Where the movable panels (terminal, mod panels) sit. */
  panelLayout: PanelLayout
  /** Aether mods switched on or off by the user (absent = the mod's default: built-in on, installed off). */
  aetherMods: Record<string, boolean>
  /** Effort of a new conversation; null = the model's default. */
  defaultEffort: EffortLevel | null
  /** Effort chosen for a conversation (absent = defaultEffort). */
  conversationEfforts: Record<string, EffortLevel>
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  defaultModel: null,
  defaultPermissionMode: 'default',
  theme: 'forest',
  notificationsEnabled: true,
  notifyOnTurnComplete: false,
  claudeExecutablePath: null,
  lastDirectory: null,
  autoRefreshSessions: true,
  sendWithEnter: true,
  extensionOverrides: EMPTY_EXTENSION_OVERRIDES,
  terminalShell: 'powershell',
  panelLayout: DEFAULT_LAYOUT,
  aetherMods: {},
  defaultEffort: null,
  conversationEfforts: {}
}
