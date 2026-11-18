/**
 * Finds the Aether mods: built-in ones shipped in resources/mods, and the user's in <userData>/mods.
 * Read only: Aether never writes in a mod folder.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { isModEnabled, MOD_MANIFEST_FILE, parseModManifest, type AetherModCatalog, type AetherModEntry, type AetherModError } from '../../shared/aetherMods'

export interface ModRegistryOptions {
  builtinDirectory: string
  userDirectory: string
  getChoices: () => Record<string, boolean>
}

function subdirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
  } catch {
    return []
  }
}

export class ModRegistry {
  constructor(private readonly options: ModRegistryOptions) {}

  get userDirectory(): string {
    return this.options.userDirectory
  }

  catalog(): AetherModCatalog {
    const choices = this.options.getChoices()
    const mods: AetherModEntry[] = []
    const errors: AetherModError[] = []
    const seen = new Set<string>()
    const sources: { source: AetherModEntry['source']; directory: string }[] = [
      { source: 'builtin', directory: this.options.builtinDirectory },
      { source: 'user', directory: this.options.userDirectory }
    ]
    for (const { source, directory } of sources) {
      for (const directoryPath of subdirectories(directory)) {
        const manifestPath = join(directoryPath, MOD_MANIFEST_FILE)
        if (!existsSync(manifestPath)) continue
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
        } catch (error) {
          errors.push({ directoryPath, error: `${MOD_MANIFEST_FILE} illisible : ${error instanceof Error ? error.message : String(error)}` })
          continue
        }
        const parsed = parseModManifest(raw)
        if (!parsed.ok) {
          errors.push({ directoryPath, error: parsed.error })
          continue
        }
        const missingEntry = parsed.manifest.panels.find((panel) => !existsSync(join(directoryPath, ...panel.entry.split('/'))))
        if (missingEntry) {
          errors.push({ directoryPath, error: `fichier du panneau « ${missingEntry.title} » introuvable : ${missingEntry.entry}` })
          continue
        }
        if (seen.has(parsed.manifest.id)) {
          errors.push({ directoryPath, error: `un autre mod porte déjà l’identifiant « ${parsed.manifest.id} »` })
          continue
        }
        seen.add(parsed.manifest.id)
        mods.push({ manifest: parsed.manifest, source, directoryPath, enabled: isModEnabled(source, parsed.manifest.id, choices) })
      }
    }
    mods.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
    return { mods, errors, userModsDirectory: this.options.userDirectory }
  }

  find(modId: string): AetherModEntry | null {
    return this.catalog().mods.find((mod) => mod.manifest.id === modId) ?? null
  }
}

/**
 * Resolves a file requested by a panel inside its mod folder; null for anything outside it
 * (`..`, absolute paths, links pointing elsewhere) or that is not a regular file.
 */
export function resolveModFile(modDirectory: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const segments = decoded.split('/').filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\') || segment.includes(':'))) return null
  const root = resolve(modDirectory)
  const candidate = resolve(root, ...segments)
  const inside = relative(root, candidate)
  if (!inside || inside.startsWith('..') || inside.includes(`..${sep}`)) return null
  try {
    if (!statSync(candidate).isFile()) return null
    // Links must not lead out of the mod folder either (skipped inside the app archive, which has none).
    if (!root.includes('.asar')) {
      const realRoot = realpathSync(root)
      const realCandidate = realpathSync(candidate)
      const realInside = relative(realRoot, realCandidate)
      if (!realInside || realInside.startsWith('..')) return null
    }
  } catch {
    return null
  }
  return candidate
}
