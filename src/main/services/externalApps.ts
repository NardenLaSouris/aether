/**
 * Opens other AI apps next to Aether. ChatGPT runs in its own official app (or the browser),
 * signed in with the user's own OpenAI account: Aether never sees that account.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { CommandRunner } from '../engine/claudeLocator'

export const CHATGPT_WEB_URL = 'https://chatgpt.com/'
const CHATGPT_START_MENU_NAME = 'ChatGPT'

export interface StartApp {
  name: string
  appId: string
}

/** Microsoft Store app ids look like `Publisher.App_hash!EntryPoint`; only those are launched. */
export function isStoreAppId(appId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]*_[a-z0-9]{13}![A-Za-z0-9][A-Za-z0-9._-]*$/.test(appId)
}

/** Reads `Get-StartApps | ConvertTo-Json` (one object or an array). */
export function parseStartApps(stdout: string): StartApp[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list
      .filter((item): item is { Name: unknown; AppID: unknown } => typeof item === 'object' && item !== null)
      .map((item) => ({ name: String(item.Name ?? ''), appId: String(item.AppID ?? '') }))
      .filter((app) => app.name && app.appId)
  } catch {
    return []
  }
}

function powershellPath(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** The installed ChatGPT desktop app, if any (Windows Start menu). */
export async function findChatGptApp(run: CommandRunner): Promise<StartApp | null> {
  if (process.platform !== 'win32') return null
  const output = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `Get-StartApps -Name '${CHATGPT_START_MENU_NAME}' | ConvertTo-Json -Compress`], 15_000)
  if (output.exitCode !== 0) return null
  return parseStartApps(output.stdout).find((app) => app.name === CHATGPT_START_MENU_NAME && isStoreAppId(app.appId)) ?? null
}

export function launchStoreApp(appId: string): void {
  if (!isStoreAppId(appId)) throw new Error('Identifiant d’application refusé.')
  const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'), [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}
