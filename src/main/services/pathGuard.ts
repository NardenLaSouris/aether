/**
 * File-system path validation for anything that comes from the renderer.
 */
import { statSync } from 'node:fs'
import { extname, isAbsolute, normalize, resolve } from 'node:path'

export class PathValidationError extends Error {}

function hasForbiddenCharacters(candidate: string): boolean {
  // NUL bytes and Windows device namespace prefixes are rejected outright.
  return candidate.includes('\0') || /^\\\\[?.]\\/.test(candidate)
}

/** Returns a normalised absolute path to an existing directory, or throws. */
export function requireExistingDirectory(candidate: string): string {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) throw new PathValidationError('Chemin vide.')
  if (hasForbiddenCharacters(candidate)) throw new PathValidationError('Chemin invalide.')
  if (!isAbsolute(candidate)) throw new PathValidationError('Le chemin doit être absolu.')
  const normalised = resolve(normalize(candidate))
  let isDirectory: boolean
  try {
    isDirectory = statSync(normalised).isDirectory()
  } catch {
    throw new PathValidationError(`Dossier introuvable : ${normalised}`)
  }
  if (!isDirectory) throw new PathValidationError(`Ce chemin n’est pas un dossier : ${normalised}`)
  return normalised
}

export function directoryExists(candidate: string | undefined | null): boolean {
  if (!candidate) return false
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

const ALLOWED_EXECUTABLE_EXTENSIONS = new Set(['.exe', '.js', '.mjs', '.cjs', ''])

/** Validates a Claude Code executable path chosen by the user. */
export function requireExecutableFile(candidate: string): string {
  if (hasForbiddenCharacters(candidate) || !isAbsolute(candidate)) throw new PathValidationError('Chemin d’exécutable invalide.')
  const normalised = resolve(normalize(candidate))
  const extension = extname(normalised).toLowerCase()
  if (!ALLOWED_EXECUTABLE_EXTENSIONS.has(extension)) throw new PathValidationError('Seuls les exécutables natifs (.exe) ou les scripts Node (.js) de Claude Code sont acceptés.')
  try {
    if (!statSync(normalised).isFile()) throw new PathValidationError('Ce chemin n’est pas un fichier.')
  } catch (error) {
    if (error instanceof PathValidationError) throw error
    throw new PathValidationError(`Fichier introuvable : ${normalised}`)
  }
  return normalised
}

const ALLOWED_EXTERNAL_HOSTS = new Set(['claude.ai', 'www.claude.ai', 'code.claude.com', 'docs.claude.com', 'docs.anthropic.com', 'www.anthropic.com', 'anthropic.com', 'console.anthropic.com', 'support.claude.com', 'status.claude.com', 'github.com', 'nodejs.org', 'chatgpt.com'])

/** Only https links to a short list of documentation/official hosts can be opened externally. */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}
