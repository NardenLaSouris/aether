/**
 * Files of a conversation's folder for the `@file` mentions of the message box: the files git knows
 * (tracked and untracked, without the ignored ones), else a bounded walk skipping the usual heavy folders.
 * Read only; paths are relative to the folder, with forward slashes.
 */
import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const CACHE_MS = 20_000
const MAX_FILES = 50_000
const SKIPPED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', '.venv', 'venv', 'target', '.worktrees', '.cache', 'coverage'])

export type FileLister = (directory: string) => Promise<string[]>

function gitFiles(directory: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: directory, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) resolve(null)
      else resolve(stdout.split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES))
    })
  })
}

function walkFiles(directory: string): string[] {
  const files: string[] = []
  const visit = (relative: string, depth: number): void => {
    if (depth > 8 || files.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(join(directory, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && !entry.name.startsWith('.')) visit(path, depth + 1)
      } else if (entry.isFile()) files.push(path)
    }
  }
  visit('', 0)
  return files
}

export const listProjectFiles: FileLister = async (directory) => (await gitFiles(directory)) ?? walkFiles(directory)

/**
 * Ranks paths for a query: exact file name, then name prefix, name substring, path substring,
 * and finally the letters in order (fuzzy). Shorter paths first on ties.
 */
export function rankFiles(files: string[], query: string, limit = 30): string[] {
  const needle = query.trim().toLowerCase().replace(/\\/g, '/')
  if (!needle) return [...files].sort((left, right) => left.split('/').length - right.split('/').length || left.length - right.length).slice(0, limit)
  const scored: { path: string; score: number }[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const name = lower.slice(lower.lastIndexOf('/') + 1)
    let score: number
    if (name === needle) score = 0
    else if (name.startsWith(needle)) score = 1
    else if (name.includes(needle)) score = 2
    else if (lower.includes(needle)) score = 3
    else {
      let position = 0
      for (const character of lower) if (character === needle[position]) position += 1
      if (position < needle.length) continue
      score = 4
    }
    scored.push({ path, score })
  }
  return scored
    .sort((left, right) => left.score - right.score || left.path.length - right.path.length || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map((item) => item.path)
}

export class FileSearch {
  private readonly cache = new Map<string, { readAt: number; files: Promise<string[]> }>()

  constructor(
    private readonly lister: FileLister = listProjectFiles,
    private readonly now: () => number = Date.now
  ) {}

  async search(directory: string, query: string): Promise<string[]> {
    const key = directory.toLowerCase()
    let cached = this.cache.get(key)
    if (!cached || this.now() - cached.readAt > CACHE_MS) {
      cached = { readAt: this.now(), files: this.lister(directory).catch(() => []) }
      this.cache.set(key, cached)
    }
    return rankFiles(await cached.files, query)
  }
}
