/**
 * What changed in a conversation's folder (read only): `git status` and `git diff HEAD`,
 * plus reading a file for the viewer. Nothing here writes, stages or resets anything.
 */
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ChangedFile, ChangesSummary, FileContent } from '../../shared/changes'
import { parseNumstat, parseStatusPorcelain, syntheticAddedDiff } from '../../shared/changes'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_CHARS = 400_000

export type GitRun = (args: string[], directory: string) => Promise<string>

export const runReadOnlyGit: GitRun = (args, directory) =>
  new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: directory, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim().slice(0, 500)))
      else resolvePromise(stdout)
    })
  })

/** Absolute path of `path` (relative to `directory`, or absolute), refused when it leaves `directory`. */
export function resolveInside(directory: string, path: string): string {
  const root = resolve(directory)
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const inside = relative(root, target)
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Ce fichier est hors du dossier de la conversation.')
  return target
}

export function readTextFile(path: string): FileContent {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('Ce n’est pas un fichier.')
  const buffer = readFileSync(path).subarray(0, MAX_FILE_BYTES)
  const binary = buffer.subarray(0, 8000).includes(0)
  return { path, size: stat.size, truncated: stat.size > MAX_FILE_BYTES, binary, content: binary ? '' : buffer.toString('utf8') }
}

export class ChangesService {
  constructor(private readonly git: GitRun = runReadOnlyGit) {}

  async summary(directory: string): Promise<ChangesSummary> {
    let top: string
    try {
      top = (await this.git(['rev-parse', '--show-toplevel'], directory)).trim()
    } catch {
      return { isRepository: false, repositoryRoot: null, branch: null, files: [] }
    }
    const [status, numstat, branch] = await Promise.all([
      this.git(['status', '--porcelain=v1', '--untracked-files=all'], directory),
      this.git(['diff', 'HEAD', '--numstat', '--no-color', '--no-ext-diff'], directory).catch(() => ''),
      this.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], directory).catch(() => '')
    ])
    const counts = parseNumstat(numstat)
    const files: ChangedFile[] = parseStatusPorcelain(status).map((file) => ({ ...file, ...(counts.get(file.path) ?? { insertions: null, deletions: null }) }))
    // New files are not in `git diff HEAD`: count their lines.
    for (const file of files) {
      if (file.status !== 'untracked' || file.insertions !== null) continue
      try {
        const content = readTextFile(join(top, file.path))
        file.insertions = content.binary ? null : content.content.split('\n').length
        file.deletions = 0
      } catch {
        // unreadable: leave the counts unknown
      }
    }
    return { isRepository: true, repositoryRoot: top, branch: branch.trim() || null, files }
  }

  /** Unified diff of one file against HEAD (a new file: all lines added). */
  async fileDiff(directory: string, path: string): Promise<string> {
    const top = (await this.git(['rev-parse', '--show-toplevel'], directory)).trim()
    const absolute = resolveInside(top, path)
    const relativePath = relative(top, absolute).split('\\').join('/')
    const tracked = await this.git(['ls-files', '--error-unmatch', '--', relativePath], top).then(
      () => true,
      () => false
    )
    if (!tracked) {
      const content = readTextFile(absolute)
      return content.binary ? `Fichier binaire : ${relativePath}` : syntheticAddedDiff(relativePath, content.content).slice(0, MAX_DIFF_CHARS)
    }
    const diff = await this.git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', relativePath], top)
    return diff.slice(0, MAX_DIFF_CHARS)
  }
}
