/**
 * Detects the Claude Code CLI installed on the machine, its version and its auth status.
 * Authentication itself is always performed by Claude Code (`claude auth login`), never by Aether.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AuthStatus, ClaudeInstallation } from '../../shared/domain'

interface CommandOutput {
  stdout: string
  stderr: string
  exitCode: number | null
}

export type CommandRunner = (file: string, args: string[], timeoutMs: number) => Promise<CommandOutput>

export const runCommand: CommandRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    const useNode = /\.(c|m)?js$/i.test(file)
    const command = useNode ? 'node' : file
    const commandArgs = useNode ? [file, ...args] : args
    execFile(command, commandArgs, { timeout: timeoutMs, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (error, stdout, stderr) => {
      const exitCode = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((error as unknown as { code: number }).code) : error ? null : 0
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? (error?.message ?? '')), exitCode })
    })
  })

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** An npm `.cmd` shim cannot be spawned without a shell; map it to the real binary or script it wraps. */
export function resolveNpmShim(shimPath: string): string | null {
  const packageDirectory = join(dirname(shimPath), 'node_modules', '@anthropic-ai', 'claude-code')
  const candidates = [join(packageDirectory, 'bin', 'claude.exe'), join(packageDirectory, 'claude.exe'), join(packageDirectory, 'cli.js')]
  return candidates.find(isFile) ?? null
}

export function knownInstallLocations(environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = homedir()): string[] {
  const locations = [join(homeDirectory, '.local', 'bin', 'claude.exe'), join(homeDirectory, '.claude', 'local', 'claude.exe')]
  if (environment.LOCALAPPDATA) locations.push(join(environment.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'), join(environment.LOCALAPPDATA, 'claude', 'claude.exe'))
  if (environment.APPDATA) {
    const npmPackage = join(environment.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code')
    locations.push(join(npmPackage, 'bin', 'claude.exe'), join(npmPackage, 'cli.js'))
  }
  return locations
}

/** Parses `where claude` output, preferring native executables. */
export function pickFromWhereOutput(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const executable = lines.find((line) => extname(line).toLowerCase() === '.exe')
  if (executable) return executable
  const shim = lines.find((line) => extname(line).toLowerCase() === '.cmd')
  if (shim) return resolveNpmShim(shim)
  return null
}

export function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
  return match?.[1] ?? null
}

export async function detectClaudeInstallation(preferredPath: string | null, runner: CommandRunner = runCommand): Promise<ClaudeInstallation> {
  const tryCandidate = async (candidate: string, source: ClaudeInstallation['detectionSource']): Promise<ClaudeInstallation | null> => {
    if (!isFile(candidate)) return null
    const versionOutput = await runner(candidate, ['--version'], 15_000)
    const version = parseVersion(versionOutput.stdout) ?? parseVersion(versionOutput.stderr)
    if (!version) return { found: false, executablePath: candidate, version: null, detectionSource: source, error: `Impossible d’exécuter ${candidate} : ${versionOutput.stderr.trim() || 'aucune version renvoyée'}` }
    return { found: true, executablePath: candidate, version, detectionSource: source }
  }

  if (preferredPath) {
    const preferred = await tryCandidate(preferredPath, 'preference')
    if (preferred?.found) return preferred
  }

  if (process.platform === 'win32') {
    const whereOutput = await runner('where.exe', ['claude'], 10_000)
    const fromPath = pickFromWhereOutput(whereOutput.stdout)
    if (fromPath) {
      const detected = await tryCandidate(fromPath, 'path')
      if (detected?.found) return detected
    }
  } else {
    const whichOutput = await runner('which', ['claude'], 10_000)
    const fromPath = whichOutput.stdout.trim().split('\n')[0]
    if (fromPath) {
      const detected = await tryCandidate(fromPath, 'path')
      if (detected?.found) return detected
    }
  }

  for (const location of knownInstallLocations()) {
    if (!existsSync(location)) continue
    const detected = await tryCandidate(location, 'known-location')
    if (detected?.found) return detected
  }

  return { found: false, executablePath: null, version: null, detectionSource: 'none', error: 'Claude Code est introuvable sur cette machine.' }
}

export function parseAuthStatus(output: string): AuthStatus {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start === -1 || end <= start) return { checked: true, loggedIn: false, error: output.trim().slice(0, 500) || 'Réponse vide de « claude auth status ».' }
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
    const text = (key: string): string | undefined => (typeof parsed[key] === 'string' ? (parsed[key] as string) : undefined)
    return {
      checked: true,
      loggedIn: parsed.loggedIn === true,
      authMethod: text('authMethod'),
      apiProvider: text('apiProvider'),
      email: text('email'),
      subscriptionType: text('subscriptionType') ?? text('planTier'),
      loginExpiresAt: text('loginExpiresAt')
    }
  } catch (error) {
    return { checked: true, loggedIn: false, error: `Réponse illisible : ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function readAuthStatus(executablePath: string, runner: CommandRunner = runCommand): Promise<AuthStatus> {
  const output = await runner(executablePath, ['auth', 'status', '--json'], 20_000)
  return parseAuthStatus(output.stdout || output.stderr)
}

/**
 * Opens Claude Code's own interactive login (`claude auth login`) in a new console window.
 * The user completes the official OAuth flow in their browser; Aether never sees credentials.
 */
export function launchOfficialLogin(executablePath: string, method: 'claudeai' | 'console'): { launched: boolean; error?: string } {
  try {
    const useNode = /\.(c|m)?js$/i.test(executablePath)
    const args = ['auth', 'login', method === 'console' ? '--console' : '--claudeai']
    const child = spawn(useNode ? 'node' : executablePath, useNode ? [executablePath, ...args] : args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
    return { launched: true }
  } catch (error) {
    return { launched: false, error: error instanceof Error ? error.message : String(error) }
  }
}
