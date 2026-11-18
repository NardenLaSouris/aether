/**
 * Aether mods: small extensions of Aether's own interface (panels, slash commands).
 *
 * A mod is a folder holding `aether-mod.json` and the files of its panels (HTML/CSS/JS).
 * Panels run in a sandboxed frame (opaque origin, no Node, no network) served by the
 * `aether-mod://<mod id>/` protocol, and talk to Aether only through the message bridge below,
 * limited to the permissions the manifest declares.
 */
import { z } from 'zod'
import type { PanelPosition } from './panelLayout'
import { ORION_OPERATIONS, type OrionOperation } from './orionConnect'

export const MOD_PROTOCOL = 'aether-mod'
/** Host serving the bridge script every panel can include: aether-mod://sdk/aether-mod.js */
export const MOD_SDK_HOST = 'sdk'
export const MOD_MANIFEST_FILE = 'aether-mod.json'

/**
 * What a panel may ask Aether for. Reading never includes the content of messages; the few actions
 * only prepare things for the user (a draft, a panel) or ask the user first (a command sent to Claude).
 */
export const MOD_PERMISSIONS = {
  'git.read': 'Lire l’historique git (commits, branches) du dossier de la conversation',
  'context.read': 'Connaître la conversation active et la liste des conversations (titres, dossiers)',
  'ui.toast': 'Afficher des notifications',
  'usage.read': 'Voir la consommation de tokens des conversations (des nombres seulement, jamais le contenu)',
  'quota.read': 'Voir où vous en êtes dans vos limites d’usage Claude (pourcentages et heures de remise à zéro)',
  'events.read': 'Suivre l’activité des conversations : tours, modèle, noms des outils appelés, erreurs (jamais le contenu des messages)',
  'composer.write': 'Préremplir la zone de saisie (vous relisez et envoyez vous-même)',
  'panels.open': 'Ouvrir ses panneaux et ceux d’Aether (terminal, ChatGPT, pilote)',
  'commands.run': 'Envoyer une commande « /… » à Claude, après votre confirmation à chaque fois',
  'orion.connect': 'Se connecter à ORION (ORION APPS) : applications, activité, comptes rendus et demandes d’actions, que décide ORION (le secret reste chiffré par Aether)'
} as const
export type ModPermission = keyof typeof MOD_PERMISSIONS

const modIdSchema = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'identifiant : minuscules, chiffres et tirets')
  .refine((value) => value !== MOD_SDK_HOST, 'identifiant réservé')
const relativeFileSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_\-/]+\.html$/, 'fichier .html relatif au dossier du mod')
  .refine((value) => !value.split('/').includes('..') && !value.startsWith('/'), 'chemin interdit')

export const MOD_EMBEDS = ['conversation-list', 'composer-top', 'page'] as const

export const modManifestSchema = z.object({
  id: modIdSchema,
  name: z.string().min(1).max(60),
  version: z.string().min(1).max(30),
  description: z.string().max(300).default(''),
  author: z.string().max(100).optional(),
  permissions: z.array(z.enum(Object.keys(MOD_PERMISSIONS) as [ModPermission, ...ModPermission[]])).max(10).default([]),
  panels: z
    .array(
      z.object({
        id: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
        title: z.string().min(1).max(60),
        entry: relativeFileSchema,
        defaultPosition: z.enum(['left', 'right', 'bottom', 'floating']).default('floating'),
        defaultSize: z.object({ width: z.number().int().min(200).max(2000), height: z.number().int().min(140).max(1600) }).optional(),
        /**
         * Drawn inside a part of Aether instead of the dock: `conversation-list` under the list of conversations,
         * `composer-top` above the message box, `page` as a page of its own in the left rail.
         */
        embed: z.enum(MOD_EMBEDS).optional(),
        /** Height in pixels of an embedded strip (not used by `page`). */
        embedHeight: z.number().int().min(20).max(400).optional()
      })
    )
    .max(10)
    .default([]),
  commands: z
    .array(
      z.object({
        name: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9-]*$/),
        description: z.string().max(200).default(''),
        opensPanel: z.string().min(1).max(40)
      })
    )
    .max(20)
    .default([])
})

export type ModManifest = z.infer<typeof modManifestSchema>

export interface AetherModEntry {
  manifest: ModManifest
  /** Shipped with Aether (on by default) or installed by the user in the mods folder (off until switched on). */
  source: 'builtin' | 'user'
  enabled: boolean
  directoryPath: string
}

export interface AetherModError {
  directoryPath: string
  error: string
}

export interface AetherModCatalog {
  mods: AetherModEntry[]
  errors: AetherModError[]
  userModsDirectory: string
}

/** Checks a manifest and its panel/command references. */
export function parseModManifest(raw: unknown): { ok: true; manifest: ModManifest } | { ok: false; error: string } {
  const parsed = modManifestSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifeste'} : ${issue.message}`).join(' ; ') }
  const manifest = parsed.data
  const panelIds = new Set(manifest.panels.map((panel) => panel.id))
  if (panelIds.size !== manifest.panels.length) return { ok: false, error: 'deux panneaux ont le même identifiant' }
  const missing = manifest.commands.find((command) => !panelIds.has(command.opensPanel))
  if (missing) return { ok: false, error: `la commande /${missing.name} ouvre un panneau inconnu (${missing.opensPanel})` }
  // A command may open a page (it navigates there); the embedded strips are always visible.
  const embedded = manifest.commands.find((command) => {
    const embed = manifest.panels.find((panel) => panel.id === command.opensPanel)?.embed
    return embed !== undefined && embed !== 'page'
  })
  if (embedded) return { ok: false, error: `la commande /${embedded.name} ouvre un panneau intégré (${embedded.opensPanel}), toujours visible` }
  return { ok: true, manifest }
}

export function isModEnabled(source: AetherModEntry['source'], modId: string, choices: Record<string, boolean>): boolean {
  return choices[modId] ?? source === 'builtin'
}

export type ModPanelEmbed = NonNullable<ModManifest['panels'][number]['embed']>
export const DEFAULT_EMBED_HEIGHT: Record<Exclude<ModPanelEmbed, 'page'>, number> = { 'conversation-list': 130, 'composer-top': 44 }

/** Page id of a mod panel shown as a page (`embed: "page"`). */
export function modPageId(modId: string, panelId: string): `mod:${string}` {
  return `mod:${modId}:${panelId}`
}

/** Panels drawn inside a part of Aether (not in the dock), from the enabled mods. */
export function embeddedPanels(mods: AetherModEntry[], embed: ModPanelEmbed): { mod: AetherModEntry; panel: ModManifest['panels'][number] }[] {
  return mods.flatMap((mod) => (mod.enabled ? mod.manifest.panels.filter((panel) => panel.embed === embed).map((panel) => ({ mod, panel })) : []))
}

export function modPanelId(modId: string, panelId: string): string {
  return `mod:${modId}:${panelId}`
}

export function parseModPanelId(panelId: string): { modId: string; panelId: string } | null {
  const match = /^mod:([a-z0-9-]+):([a-z0-9-]+)$/.exec(panelId)
  return match ? { modId: match[1] as string, panelId: match[2] as string } : null
}

export function modPanelDefaults(panel: ModManifest['panels'][number]): { position: PanelPosition; floating?: { width: number; height: number } } {
  return { position: panel.defaultPosition, ...(panel.defaultSize ? { floating: { width: panel.defaultSize.width, height: panel.defaultSize.height } } : {}) }
}

/** `/arbo extra words` → the mod command it names, if an enabled mod declares it. */
export function findModCommand(text: string, mods: AetherModEntry[]): { mod: AetherModEntry; command: ModManifest['commands'][number]; argumentsText: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!match) return null
  for (const mod of mods) {
    if (!mod.enabled) continue
    const command = mod.manifest.commands.find((item) => item.name === match[1])
    if (command) return { mod, command, argumentsText: (match[2] ?? '').trim() }
  }
  return null
}

// ---------------------------------------------------------------------------
// Git data given to panels holding `git.read`.

export interface GitCommit {
  hash: string
  parents: string[]
  /** Decorations: `HEAD -> main`, `origin/main`, `tag: v1.0`… */
  refs: string[]
  author: string
  timestamp: number
  subject: string
}

export interface GitGraphData {
  workingDirectory: string
  repositoryRoot: string
  currentBranch: string | null
  remoteUrl: string | null
  commits: GitCommit[]
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Bridge between a panel frame and Aether (window.postMessage).

export const BRIDGE_TAG = 'aether-mod-bridge'

/** ORION CONNECT (`orion.connect`): `orion.<operation>`, answered by the main process (src/main/mods/orionConnect.ts). */
export const ORION_BRIDGE_METHODS = ORION_OPERATIONS.map((operation) => `orion.${operation}` as const) as unknown as readonly [`orion.${OrionOperation}`, ...`orion.${OrionOperation}`[]]

export interface PanelContext {
  modId: string
  panelId: string
  conversation: { id: string; title: string; workingDirectory: string } | null
  workingDirectory: string | null
  theme: 'forest' | 'charcoal'
}

export const bridgeRequestSchema = z.object({
  tag: z.literal(BRIDGE_TAG),
  requestId: z.number().int().nonnegative(),
  method: z.enum(['context.get', 'git.log', 'ui.toast', 'usage.get', 'events.recent', 'conversations.list', 'composer.insert', 'panel.open', 'command.run', 'quota.get', 'quota.refresh', ...ORION_BRIDGE_METHODS]),
  params: z.record(z.string(), z.unknown()).default({})
})
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>

export const BRIDGE_METHOD_PERMISSION: Record<BridgeRequest['method'], ModPermission | null> = {
  'context.get': null,
  'git.log': 'git.read',
  'ui.toast': 'ui.toast',
  'usage.get': 'usage.read',
  'events.recent': 'events.read',
  'conversations.list': 'context.read',
  'composer.insert': 'composer.write',
  'panel.open': 'panels.open',
  'command.run': 'commands.run',
  'quota.get': 'quota.read',
  'quota.refresh': 'quota.read',
  ...(Object.fromEntries(ORION_BRIDGE_METHODS.map((method) => [method, 'orion.connect'])) as Record<(typeof ORION_BRIDGE_METHODS)[number], ModPermission>)
}

/** What `quota.get` / `quota.refresh` answer, and the `quota` event carries: Claude Code's own figures, never estimates. */
export interface ModQuota {
  now: number
  windows: { kind: string; label: string; utilizationPercent: number | null; resetsAt: number | null; status: string | null; observedAt: number; source: string }[]
  /** Present while Aether holds the sends because a limit is reached. */
  block: { kind: string; label: string; resetsAt: number | null } | null
  /** False when the account has no plan limits (API key); null when unknown yet. */
  rateLimitsAvailable: boolean | null
  lastCheckAt: number | null
  error: string | null
}

/** Aether's own panels a mod holding `panels.open` may open, besides its own. */
export const OPENABLE_BUILTIN_PANELS = ['terminal', 'chatgpt', 'pilot', 'changes', 'file', 'branch'] as const

/** `/name args`: what `command.run` accepts (a slash command, one line, bounded). */
export function slashCommandProblem(text: string): string | null {
  const trimmed = text.trim()
  if (!/^\/[A-Za-z0-9][\w:.-]*(\s.*)?$/.test(trimmed)) return 'une commande commence par « / » suivi de son nom'
  if (trimmed.includes('\n')) return 'une commande tient sur une ligne'
  if (trimmed.length > 500) return 'commande trop longue (500 caractères au plus)'
  return null
}

// ---------------------------------------------------------------------------
// Activity given to panels holding `events.read` (`events` event, and `events.recent`).
// Never the content of messages or tool inputs/outputs: names, states and numbers only.

type At = { at: number; conversationId: string }
export type ModEvent =
  | (At & { type: 'runner_state'; state: string })
  | (At & { type: 'model'; model: string })
  | (At & { type: 'tool_use'; toolUseId: string; toolName: string; subagent: boolean })
  | (At & { type: 'tool_result'; toolUseId: string; isError: boolean })
  | (At & { type: 'turn_end'; isError: boolean; durationMs: number; model: string | null; costUsd: number | null; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number })
  | (At & { type: 'token_usage'; model: string | null; inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; subagent: boolean })
  | (At & { type: 'permission_request'; toolName: string })
  | (At & { type: 'rate_limit'; status: string; resetsAt: number | null })
  | (At & { type: 'notice'; tone: 'info' | 'warning' | 'error'; text: string })
  | (At & { type: 'mod_status'; plugin: string; text: string | null })

/** Minimal view of an engine event, enough to build mod events (keeps this file free of engine imports). */
export type EngineEventLike = { type: string; conversationId?: string } & Record<string, unknown>

/**
 * Converts one engine event into what mods may see. `seenTools` remembers the tool calls already
 * reported (an assistant message is re-sent as its blocks accumulate).
 */
export function toModEvents(event: EngineEventLike, at: number, seenTools: Set<string>): ModEvent[] {
  const conversationId = typeof event.conversationId === 'string' ? event.conversationId : null
  if (!conversationId) return []
  const base = { at, conversationId }
  const text = (value: unknown, max = 300): string => String(value ?? '').slice(0, max)
  const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  switch (event.type) {
    case 'runner_state':
      return [{ ...base, type: 'runner_state', state: text(event.state, 40) }]
    case 'session_init':
      return typeof event.model === 'string' && event.model ? [{ ...base, type: 'model', model: text(event.model, 100) }] : []
    case 'assistant_message': {
      const events: ModEvent[] = []
      const blocks = Array.isArray(event.blocks) ? (event.blocks as { kind?: unknown; toolUseId?: unknown; toolName?: unknown }[]) : []
      for (const block of blocks) {
        if (block.kind !== 'tool_use' || typeof block.toolUseId !== 'string' || seenTools.has(block.toolUseId)) continue
        seenTools.add(block.toolUseId)
        if (seenTools.size > 5000) seenTools.delete(seenTools.values().next().value as string)
        events.push({ ...base, type: 'tool_use', toolUseId: block.toolUseId, toolName: text(block.toolName, 120), subagent: event.parentToolUseId !== null && event.parentToolUseId !== undefined })
      }
      return events
    }
    case 'tool_result':
      return [{ ...base, type: 'tool_result', toolUseId: text(event.toolUseId, 120), isError: event.isError === true }]
    case 'turn_result': {
      const result = (event.result ?? {}) as Record<string, unknown>
      return [
        {
          ...base,
          type: 'turn_end',
          isError: result.isError === true,
          durationMs: number(result.durationMs),
          model: typeof result.model === 'string' ? result.model : null,
          costUsd: typeof result.totalCostUsd === 'number' ? result.totalCostUsd : null,
          inputTokens: number(result.inputTokens),
          outputTokens: number(result.outputTokens),
          cacheReadInputTokens: number(result.cacheReadInputTokens),
          cacheCreationInputTokens: number(result.cacheCreationInputTokens)
        }
      ]
    }
    case 'token_usage':
      return [
        {
          ...base,
          type: 'token_usage',
          model: typeof event.model === 'string' ? event.model : null,
          inputTokens: number(event.inputTokens),
          outputTokens: number(event.outputTokens),
          cacheReadInputTokens: number(event.cacheReadInputTokens),
          cacheCreationInputTokens: number(event.cacheCreationInputTokens),
          subagent: event.subagent === true
        }
      ]
    case 'permission_request':
      return [{ ...base, type: 'permission_request', toolName: text(event.displayName ?? event.toolName, 120) }]
    case 'rate_limit': {
      const info = (event.info ?? {}) as Record<string, unknown>
      return [{ ...base, type: 'rate_limit', status: text(info.status, 40), resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null }]
    }
    case 'engine_notice':
      return [{ ...base, type: 'notice', tone: event.tone === 'warning' || event.tone === 'error' ? event.tone : 'info', text: text(event.text) }]
    case 'mod_status':
      return [{ ...base, type: 'mod_status', plugin: text(event.plugin, 100), text: event.text === null ? null : text(event.text) }]
    default:
      return []
  }
}

/** A conversation as `conversations.list` gives it. */
export interface ModConversation {
  id: string
  title: string
  workingDirectory: string
  busy: boolean
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Token usage given to panels holding `usage.read`: one sample per API response, as it streams.

export interface TokenSample {
  /** Milliseconds since epoch. */
  at: number
  conversationId: string
  model: string | null
  /** Tokens added by this sample (increments, not totals). */
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  /** From a subagent's request. */
  subagent: boolean
}

/** What `usage.get` answers; then each new sample arrives as a `usage` event. */
export interface TokenUsageSnapshot {
  now: number
  /** Oldest first, at most the last 30 minutes. */
  samples: TokenSample[]
}
