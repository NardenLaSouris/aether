/**
 * Read-only git history for mod panels holding `git.read`. Only fixed read commands
 * (`rev-parse`, `log`, `remote get-url`) run, never anything that changes the repository.
 */
import { execFile } from 'node:child_process'
import type { GitCommit, GitGraphData } from '../../shared/aetherMods'

const FIELD = '\x1f'
const RECORD = '\x1e'
const LOG_FORMAT = ['%H', '%P', '%D', '%an', '%at', '%s'].join('%x1f') + '%x1e'
export const MAX_COMMITS = 400

export type GitRunner = (args: string[], workingDirectory: string) => Promise<string>

export const runGit: GitRunner = (args, workingDirectory) =>
  new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', '-c', 'log.showSignature=false', ...args], { cwd: workingDirectory, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') reject(new Error('git est introuvable sur cette machine (installez Git pour Windows).'))
        else reject(new Error((stderr || error.message).trim().slice(0, 500)))
        return
      }
      resolvePromise(stdout)
    })
  })

export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of output.split(RECORD)) {
    const trimmed = record.replace(/^\s+/, '')
    if (!trimmed) continue
    const [hash, parents, decorations, author, timestamp, ...subjectParts] = trimmed.split(FIELD)
    if (!hash || !/^[0-9a-f]{7,64}$/.test(hash)) continue
    commits.push({
      hash,
      parents: (parents ?? '').split(' ').filter(Boolean),
      refs: (decorations ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean),
      author: author ?? '',
      timestamp: Number(timestamp ?? 0) * 1000,
      subject: subjectParts.join(FIELD).trim()
    })
  }
  return commits
}

export async function readGitGraph(workingDirectory: string, limit: number, run: GitRunner = runGit): Promise<GitGraphData> {
  const count = Math.min(Math.max(1, Math.floor(limit)), MAX_COMMITS)
  let repositoryRoot: string
  try {
    repositoryRoot = (await run(['rev-parse', '--show-toplevel'], workingDirectory)).trim()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not a git repository/i.test(message)) throw new Error('Ce dossier n’est pas un dépôt git.', { cause: error })
    throw error
  }
  const [branchOutput, logOutput, remoteOutput] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD'], workingDirectory).catch(() => ''),
    run(['log', '--all', '--date-order', `--max-count=${count + 1}`, '--decorate=short', `--format=${LOG_FORMAT}`], workingDirectory).catch((error: unknown) => {
      // A repository without any commit yet.
      if (error instanceof Error && /does not have any commits|bad default revision/i.test(error.message)) return ''
      throw error
    }),
    run(['remote', 'get-url', 'origin'], workingDirectory).catch(() => '')
  ])
  const commits = parseGitLog(logOutput)
  const branch = branchOutput.trim()
  return {
    workingDirectory,
    repositoryRoot,
    currentBranch: branch && branch !== 'HEAD' ? branch : null,
    remoteUrl: sanitiseRemoteUrl(remoteOutput.trim()),
    commits: commits.slice(0, count),
    truncated: commits.length > count
  }
}

/** Drops any credentials embedded in a remote URL (https://user:token@host/...). */
export function sanitiseRemoteUrl(url: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    // scp-like syntax: git@github.com:owner/repo.git (no secret in it)
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(url) ? url : null
  }
}
