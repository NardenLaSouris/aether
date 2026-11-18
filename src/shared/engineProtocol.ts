/**
 * Protocol between the Electron main process and the engine host
 * (an Electron utilityProcess that owns every Claude Agent SDK call).
 * Messages are plain JSON; the main process validates host output with zod.
 */
import { z } from 'zod'
import type { AccountSummary, AssistantBlock, DiscoveredSession, EffortLevel, MessageImage, ModelOption, PermissionModeOption, RunnerExtensions, RunnerState, TimelineItem } from './domain'

// ---------------------------------------------------------------------------
// Main -> host
// ---------------------------------------------------------------------------

export interface StartRunnerCommand {
  type: 'start_runner'
  conversationId: string
  executablePath: string
  workingDirectory: string
  model: string | null
  permissionMode: PermissionModeOption
  resumeSessionId: string | null
  /** Aether's plugin / mod / skill choices; absent = Claude Code defaults. */
  extensions?: RunnerExtensions
  /** Claude Code allow rules the user chose for a Codex pilot (this session only). */
  allowedTools?: string[]
  /** Thinking effort; absent = the model's default. */
  effort?: EffortLevel
}

export type HostCommand =
  | StartRunnerCommand
  | { type: 'send_message'; conversationId: string; text: string; clientMessageId: string; images?: MessageImage[] }
  | { type: 'set_effort'; conversationId: string; effort: EffortLevel | null }
  | { type: 'interrupt'; conversationId: string }
  | { type: 'set_model'; conversationId: string; model: string | null }
  | { type: 'set_permission_mode'; conversationId: string; permissionMode: PermissionModeOption }
  | { type: 'close_runner'; conversationId: string }
  /** `answers`: the user's answers to an AskUserQuestion (question text → chosen label(s)), merged into its input. */
  | { type: 'permission_decision'; requestId: string; allow: boolean; message?: string; answers?: Record<string, string> }
  | { type: 'rpc'; rpcId: string; request: HostRpcRequest }
  | { type: 'shutdown' }

export type HostRpcRequest =
  | { method: 'probe'; executablePath: string; workingDirectory: string; extensions?: RunnerExtensions }
  | { method: 'usage'; executablePath: string; workingDirectory: string; conversationId: string | null }
  | { method: 'list_sessions'; limit: number }
  | { method: 'session_history'; sessionId: string; directory: string | null; limit: number }
  | { method: 'rewind_files'; conversationId: string; userMessageId: string; dryRun: boolean }

export interface ProbeResult {
  models: ModelOption[]
  account: AccountSummary
  claudeCodeVersion: string | null
  commands: { name: string; description: string; builtin: boolean }[]
}

/** Applies Aether's extension choices to SDK options (shared by runners and probes). */
export function extensionSdkOptions(extensions: RunnerExtensions | undefined): {
  settings?: { enabledPlugins: Record<string, boolean> }
  plugins?: { type: 'local'; path: string }[]
  skills?: string[]
} {
  if (!extensions) return {}
  const options: ReturnType<typeof extensionSdkOptions> = {}
  if (Object.keys(extensions.pluginToggles).length > 0) options.settings = { enabledPlugins: { ...extensions.pluginToggles } }
  if (extensions.modDirectories.length > 0) options.plugins = extensions.modDirectories.map((path) => ({ type: 'local' as const, path }))
  if (extensions.skills) options.skills = [...extensions.skills]
  return options
}

export interface RawUsageWindow {
  utilization: number | null
  resets_at: string | null
}

export interface UsageApiResult {
  subscriptionType: string | null
  rateLimitsAvailable: boolean
  windows: Partial<Record<'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet', RawUsageWindow | null>>
  sessionCostUsd: number | null
}

export interface HostRpcResultMap {
  probe: ProbeResult
  usage: UsageApiResult
  list_sessions: Omit<DiscoveredSession, 'linkedConversationId' | 'cwdExists'>[]
  session_history: TimelineItem[]
  rewind_files: RewindResult
}

/** What restoring the files to their state before a message did (or would do, on a dry run). */
export interface RewindResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type HostRpcMethod = keyof HostRpcResultMap

export type HostRpcResponse =
  | { method: 'probe'; result: ProbeResult }
  | { method: 'usage'; result: UsageApiResult }
  | { method: 'list_sessions'; result: Omit<DiscoveredSession, 'linkedConversationId' | 'cwdExists'>[] }
  | { method: 'session_history'; result: TimelineItem[] }
  | { method: 'rewind_files'; result: RewindResult }

// ---------------------------------------------------------------------------
// Host -> main
// ---------------------------------------------------------------------------

export interface RateLimitPayload {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
  overageStatus?: string
  overageResetsAt?: number
  isUsingOverage?: boolean
}

export interface TurnResultPayload {
  subtype: string
  isError: boolean
  durationMs: number
  totalCostUsd: number | null
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  errors: string[]
  resultText: string | null
  apiErrorStatus: number | null
  model: string | null
  /** The turn ended because Aether asked Claude Code to stop it. */
  interrupted?: boolean
}

export interface ModPane {
  id: string
  title: string
  plugin: string
}

export type EngineEvent =
  | { type: 'runner_state'; conversationId: string; state: RunnerState; message?: string }
  | { type: 'session_init'; conversationId: string; sessionId: string; model: string; workingDirectory: string; tools: string[]; permissionMode: string; claudeCodeVersion: string }
  | { type: 'text_delta'; conversationId: string; streamKey: string; blockIndex: number; text: string; thinking: boolean }
  | { type: 'assistant_message'; conversationId: string; messageId: string; blocks: AssistantBlock[]; model: string | null; error: string | null; parentToolUseId: string | null }
  | { type: 'tool_result'; conversationId: string; toolUseId: string; content: string; isError: boolean }
  | { type: 'turn_result'; conversationId: string; sessionId: string; result: TurnResultPayload }
  | { type: 'rate_limit'; conversationId: string; info: RateLimitPayload }
  /** Tokens of one API response as it streams (increments: message_start, then each message_delta). */
  | { type: 'token_usage'; conversationId: string; model: string | null; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; subagent: boolean }
  | { type: 'api_retry'; conversationId: string; attempt: number; maxRetries: number; retryDelayMs: number; errorStatus: number | null; error: string }
  | { type: 'permission_request'; conversationId: string; requestId: string; toolName: string; toolUseId: string; input: Record<string, unknown>; title?: string; description?: string; decisionReason?: string; blockedPath?: string; displayName?: string }
  | { type: 'permission_cancelled'; conversationId: string; requestId: string }
  | { type: 'auth_status'; conversationId: string; isAuthenticating: boolean; output: string[]; error?: string }
  | { type: 'engine_notice'; conversationId: string; tone: 'info' | 'warning' | 'error'; text: string }
  | { type: 'child_process'; conversationId: string; pid: number; alive: boolean }
  /** A mod's status line entry ($.ui.status); text null clears it. */
  | { type: 'mod_status'; conversationId: string; plugin: string; text: string | null }
  /** A mod's toast ($.ui.toast). */
  | { type: 'mod_toast'; conversationId: string; plugin: string; text: string }
  /** Panes the mods have opened ($.ui.open). Aether cannot draw them: they need Claude Code's own drawing surface. */
  | { type: 'mod_panes'; conversationId: string; panes: ModPane[] }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string; details?: string }

export type HostMessage =
  | { type: 'ready' }
  | { type: 'event'; event: EngineEvent }
  | { type: 'rpc_result'; rpcId: string; ok: true; response: HostRpcResponse }
  | { type: 'rpc_result'; rpcId: string; ok: false; error: string }

/** Light structural validation of what comes back from the host (defence in depth). */
export const hostMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('event'), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ type: z.literal('rpc_result'), rpcId: z.string(), ok: z.boolean(), response: z.unknown().optional(), error: z.string().optional() })
])
