/**
 * Claude Code plugins, mods and skills as seen by Aether.
 *
 * - Plugins come from the official `claude plugin list --json`.
 * - Mods are the local plugins in ~/.claude/dev-mods/<folder>/<mod> (read only).
 * - Skills and commands come from Claude Code itself (SDK initialisation of a probe session).
 *
 * Aether's choices are stored in its own preferences and applied only to the sessions it starts,
 * through official SDK options. Claude Code's configuration files are never written.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ExtensionCatalog, ExtensionOverrides, ModEntry, PluginEntry, RunnerExtensions, SkillEntry } from '../../shared/domain'
import type { ProbeResult } from '../../shared/engineProtocol'
import type { CommandRunner } from '../engine/claudeLocator'
import type { ScopedLogger } from './logger'

export type ExtensionKind = 'plugin' | 'mod' | 'skill'

export interface ExtensionChange {
  kind: ExtensionKind
  key: string
  /** null = back to the Claude Code default. */
  enabled: boolean | null
}

export interface ExtensionServiceDependencies {
  runCommand: CommandRunner
  probeCommands: (workingDirectory: string, extensions: RunnerExtensions) => Promise<ProbeResult['commands']>
  getExecutablePath: () => string | null
  getOverrides: () => ExtensionOverrides
  saveOverrides: (overrides: ExtensionOverrides) => void
  modsRoot: string
  log: ScopedLogger
  now?: () => number
}

const SKILL_CACHE_TTL_MS = 10 * 60_000
const PLUGIN_CACHE_TTL_MS = 30_000

const pluginListSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      version: z.string().optional().nullable(),
      scope: z.string().optional().nullable(),
      enabled: z.boolean(),
      installPath: z.string().optional().nullable()
    })
    .passthrough()
)

const manifestSchema = z.object({ name: z.string().min(1), description: z.string().optional(), version: z.string().optional() }).passthrough()

function readManifest(directory: string): z.infer<typeof manifestSchema> | null {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(join(directory, '.claude-plugin', 'plugin.json'), 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function modUsesInterfaceHooks(directory: string): boolean {
  const hooksDirectory = join(directory, 'hooks')
  try {
    return readdirSync(hooksDirectory).some((fileName) => {
      if (fileName.endsWith('.tsx')) return true
      if (!/\.(ts|js|mjs)$/.test(fileName)) return false
      return /\$\.ui\b|\.ui\.(status|band|toast)/.test(readFileSync(join(hooksDirectory, fileName), 'utf8'))
    })
  } catch {
    return false
  }
}

/** Mods are copied per desktop session; the most recently modified copy of each name wins. */
export function discoverMods(modsRoot: string): Omit<ModEntry, 'enabled' | 'overridden'>[] {
  const newest = new Map<string, { entry: Omit<ModEntry, 'enabled' | 'overridden'>; modifiedAt: number }>()
  for (const folder of safeReaddir(modsRoot)) {
    const folderPath = join(modsRoot, folder)
    for (const modFolder of safeReaddir(folderPath)) {
      const directoryPath = join(folderPath, modFolder)
      const manifest = readManifest(directoryPath)
      if (!manifest) continue
      let modifiedAt = 0
      try {
        modifiedAt = statSync(join(directoryPath, '.claude-plugin', 'plugin.json')).mtimeMs
        const hooksDirectory = join(directoryPath, 'hooks')
        if (existsSync(hooksDirectory)) for (const fileName of readdirSync(hooksDirectory)) modifiedAt = Math.max(modifiedAt, statSync(join(hooksDirectory, fileName)).mtimeMs)
      } catch {
        // keep 0
      }
      const previous = newest.get(manifest.name)
      if (previous && previous.modifiedAt >= modifiedAt) continue
      newest.set(manifest.name, {
        modifiedAt,
        entry: { name: manifest.name, description: manifest.description ?? null, version: manifest.version ?? null, directoryPath, hasUiHooks: modUsesInterfaceHooks(directoryPath) }
      })
    }
  }
  return [...newest.values()].map((item) => item.entry).sort((left, right) => left.name.localeCompare(right.name))
}

export function parsePluginList(stdout: string): Omit<PluginEntry, 'enabled' | 'overridden' | 'description'>[] {
  const start = stdout.indexOf('[')
  if (start < 0) throw new Error('Réponse de « claude plugin list » illisible.')
  const parsed = pluginListSchema.parse(JSON.parse(stdout.slice(start)))
  return parsed.map((plugin) => ({
    id: plugin.id,
    name: plugin.id.split('@')[0] ?? plugin.id,
    version: plugin.version ?? null,
    scope: plugin.scope ?? 'user',
    installPath: plugin.installPath ?? null,
    enabledInClaudeCode: plugin.enabled
  }))
}

export function skillOwner(name: string): string | null {
  const separator = name.indexOf(':')
  return separator > 0 ? name.slice(0, separator) : null
}

export function normaliseOverrides(value: ExtensionOverrides | undefined | null): ExtensionOverrides {
  return { plugins: { ...(value?.plugins ?? {}) }, mods: { ...(value?.mods ?? {}) }, skills: { ...(value?.skills ?? {}) } }
}

/** Applies changes; a value equal to the default is stored as "no override". */
export function applyExtensionChanges(current: ExtensionOverrides, changes: ExtensionChange[], pluginDefaults: Record<string, boolean>): ExtensionOverrides {
  const next = normaliseOverrides(current)
  for (const change of changes) {
    const bucket = change.kind === 'plugin' ? next.plugins : change.kind === 'mod' ? next.mods : next.skills
    const defaultValue = change.kind === 'plugin' ? pluginDefaults[change.key] : true
    if (change.enabled === null || change.enabled === defaultValue) delete bucket[change.key]
    else bucket[change.key] = change.enabled
  }
  return next
}

interface SkillCacheEntry {
  readAt: number
  commands: ProbeResult['commands']
}

export class ExtensionService {
  private readonly skillCache = new Map<string, SkillCacheEntry>()
  private pluginCache: { readAt: number; plugins: Omit<PluginEntry, 'enabled' | 'overridden' | 'description'>[] } | null = null
  private lastSkillsDirectory: string | null = null

  constructor(private readonly dependencies: ExtensionServiceDependencies) {}

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }

  private overrides(): ExtensionOverrides {
    return normaliseOverrides(this.dependencies.getOverrides())
  }

  private async listPlugins(force: boolean): Promise<Omit<PluginEntry, 'enabled' | 'overridden' | 'description'>[]> {
    if (!force && this.pluginCache && this.now() - this.pluginCache.readAt < PLUGIN_CACHE_TTL_MS) return this.pluginCache.plugins
    const executablePath = this.dependencies.getExecutablePath()
    if (!executablePath) throw new Error('Claude Code introuvable.')
    const output = await this.dependencies.runCommand(executablePath, ['plugin', 'list', '--json'], 30_000)
    if (output.exitCode !== 0) throw new Error(`« claude plugin list » a échoué : ${(output.stderr || output.stdout).trim().slice(0, 300)}`)
    const plugins = parsePluginList(output.stdout)
    this.pluginCache = { readAt: this.now(), plugins }
    return plugins
  }

  /** Plugin toggles and mod folders, without any skill filter. */
  private baseExtensions(overrides: ExtensionOverrides): RunnerExtensions {
    const modDirectories = discoverMods(this.dependencies.modsRoot)
      .filter((mod) => overrides.mods[mod.name] !== false)
      .map((mod) => mod.directoryPath)
    return { pluginToggles: { ...overrides.plugins }, modDirectories, skills: null }
  }

  private async commandsFor(workingDirectory: string, force: boolean): Promise<ProbeResult['commands']> {
    const key = workingDirectory.toLowerCase()
    const cached = this.skillCache.get(key)
    if (!force && cached && this.now() - cached.readAt < SKILL_CACHE_TTL_MS) return cached.commands
    const commands = await this.dependencies.probeCommands(workingDirectory, this.baseExtensions(this.overrides()))
    this.skillCache.set(key, { readAt: this.now(), commands })
    return commands
  }

  async catalog(workingDirectory: string, options: { refreshPlugins?: boolean; refreshSkills?: boolean } = {}): Promise<ExtensionCatalog> {
    const overrides = this.overrides()
    const errors: string[] = []

    let plugins: PluginEntry[] = []
    try {
      plugins = (await this.listPlugins(options.refreshPlugins === true)).map((plugin) => {
        const override = overrides.plugins[plugin.id]
        const manifest = plugin.installPath ? readManifest(plugin.installPath) : null
        return { ...plugin, description: manifest?.description ?? null, enabled: override ?? plugin.enabledInClaudeCode, overridden: override !== undefined && override !== plugin.enabledInClaudeCode }
      })
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }

    const mods: ModEntry[] = discoverMods(this.dependencies.modsRoot).map((mod) => ({ ...mod, enabled: overrides.mods[mod.name] !== false, overridden: overrides.mods[mod.name] === false }))

    let skills: SkillEntry[] = []
    let skillsReadAt: number | null = null
    try {
      const commands = await this.commandsFor(workingDirectory, options.refreshSkills === true)
      skillsReadAt = this.skillCache.get(workingDirectory.toLowerCase())?.readAt ?? null
      this.lastSkillsDirectory = workingDirectory
      const seen = new Set<string>()
      skills = commands
        .filter((command) => {
          if (seen.has(command.name)) return false
          seen.add(command.name)
          return true
        })
        .map((command) => ({
          name: command.name,
          description: command.description,
          owner: skillOwner(command.name),
          builtin: command.builtin,
          enabled: overrides.skills[command.name] !== false,
          overridden: overrides.skills[command.name] === false
        }))
        .sort((left, right) => Number(left.builtin) - Number(right.builtin) || (left.owner ?? '').localeCompare(right.owner ?? '') || left.name.localeCompare(right.name))
    } catch (error) {
      errors.push(`Liste des skills indisponible : ${error instanceof Error ? error.message : String(error)}`)
    }

    return { plugins, mods, skills, skillsDirectory: skills.length > 0 ? workingDirectory : this.lastSkillsDirectory, skillsReadAt, errors }
  }

  /** Stores the changes; returns true when the set of loaded plugins/mods changed (skill lists must be re-read). */
  async update(changes: ExtensionChange[]): Promise<boolean> {
    const pluginDefaults: Record<string, boolean> = {}
    if (changes.some((change) => change.kind === 'plugin')) {
      for (const plugin of await this.listPlugins(false)) pluginDefaults[plugin.id] = plugin.enabledInClaudeCode
    }
    const next = applyExtensionChanges(this.overrides(), changes, pluginDefaults)
    this.dependencies.saveOverrides(next)
    const structural = changes.some((change) => change.kind !== 'skill')
    if (structural) this.skillCache.clear()
    return structural
  }

  /**
   * Options for a new session. When some skills are switched off, the SDK needs the allow-list of
   * every other skill/command Claude Code offers in that folder, read from Claude Code itself.
   */
  async launchExtensions(workingDirectory: string): Promise<{ extensions: RunnerExtensions; warning?: string }> {
    const overrides = this.overrides()
    const extensions = this.baseExtensions(overrides)
    const disabledSkills = new Set(Object.entries(overrides.skills).filter(([, enabled]) => !enabled).map(([name]) => name))
    if (disabledSkills.size === 0) return { extensions }
    try {
      const commands = await this.commandsFor(workingDirectory, false)
      const allowed = [...new Set(commands.map((command) => command.name))].filter((name) => !disabledSkills.has(name))
      return { extensions: { ...extensions, skills: allowed } }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.dependencies.log.warn('Filtre de skills non appliqué', reason)
      return { extensions, warning: `Les skills désactivés n’ont pas pu être filtrés pour cette session (${reason}). Ils restent disponibles.` }
    }
  }
}
