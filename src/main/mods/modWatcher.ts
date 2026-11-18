/**
 * Watches the user's mods folder: when a mod's files change, Aether re-reads the catalogue and reloads
 * that mod's open panels, so a mod is edited without restarting or rebuilding anything.
 */
import { mkdirSync, watch, type FSWatcher } from 'node:fs'

export interface ModWatcherOptions {
  directory: string
  /** Called once per burst of changes, per mod folder (null when the folder itself changed). */
  onChange: (folder: string | null) => void
  debounceMs?: number
  /** For tests. */
  watchImpl?: (directory: string, listener: (eventType: string, fileName: string | null) => void) => { close(): void }
}

/** `arbo\panel.js` → `arbo`; the mods folder itself → null. */
export function changedModFolder(fileName: string | null): string | null {
  if (!fileName) return null
  const first = fileName.split(/[\\/]/).find((segment) => segment.length > 0)
  return first ?? null
}

export function watchModsFolder(options: ModWatcherOptions): { close(): void } {
  const debounceMs = options.debounceMs ?? 250
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const fire = (folder: string | null): void => {
    const key = folder ?? ''
    const previous = timers.get(key)
    if (previous) clearTimeout(previous)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        options.onChange(folder)
      }, debounceMs)
    )
  }
  let watcher: { close(): void } | null = null
  try {
    mkdirSync(options.directory, { recursive: true })
    const listener = (_eventType: string, fileName: string | null): void => fire(changedModFolder(fileName ? String(fileName) : null))
    watcher = options.watchImpl ? options.watchImpl(options.directory, listener) : (watch(options.directory, { recursive: true }, listener) as FSWatcher)
    ;(watcher as Partial<FSWatcher>).on?.('error', () => undefined)
  } catch {
    watcher = null
  }
  return {
    close() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      watcher?.close()
    }
  }
}
