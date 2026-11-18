/**
 * Git operations of the Codex pilot. Only these happen: list branches, switch to or create the branch
 * the user chose, stage, commit, push that branch to `origin`. Never a force-push, a branch deletion or a
 * reset of the user's work; a main branch only when the user explicitly accepted it.
 */
import { createHash } from 'node:crypto'
import { branchNameProblem, isProtectedBranch, scanForSecrets, type CommitRecord, type SecretFinding } from '../../shared/pilot'
import { execFile } from 'node:child_process'
import type { GitRunner } from '../mods/gitReader'

/** Like the mods' git reader, with room for commit hooks and pushes; never waits on a terminal prompt. */
export const runPilotGit: GitRunner = (args, workingDirectory) =>
  new Promise((resolvePromise, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: workingDirectory, windowsHide: true, timeout: 180_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(new Error('git est introuvable sur cette machine (installez Git pour Windows).'))
        else reject(new Error((stderr || error.message).trim().slice(0, 800)))
        return
      }
      resolvePromise(stdout)
    })
  })

export interface PilotGit {
  isRepository(directory: string): Promise<boolean>
  currentBranch(directory: string): Promise<string | null>
  isClean(directory: string): Promise<boolean>
  defaultBranch(directory: string): Promise<string | null>
  remoteUrl(directory: string): Promise<string | null>
  createBranch(directory: string, branch: string): Promise<void>
  /** Local and origin branches, deduplicated and sorted. */
  listBranches(directory: string): Promise<string[]>
  /** Branch → folder of every worktree of the repository (the current one included). */
  listWorktrees(directory: string): Promise<Record<string, string>>
  /** Top folder of the working tree containing `directory`. */
  topLevel(directory: string): Promise<string | null>
  /** `git switch <branch>`: an origin-only branch gets its local tracking branch. Uncommitted work is carried or git refuses. */
  switchBranch(directory: string, branch: string): Promise<void>
  fingerprint(directory: string): Promise<string | null>
  commitAll(directory: string, branch: string, message: string, allowProtected?: boolean): Promise<{ sha: string | null; secrets: SecretFinding[]; nothingToCommit: boolean }>
  push(directory: string, branch: string, allowProtected?: boolean): Promise<void>
}

/** Removes credentials from a remote URL before it is shown. */
export function displayRemote(url: string | null): string | null {
  if (!url) return null
  return url.replace(/\/\/[^/@]*@/, '//')
}

export function createPilotGit(run: GitRunner = runPilotGit): PilotGit {
  const tryRun = async (args: string[], directory: string): Promise<string | null> => {
    try {
      return await run(args, directory)
    } catch {
      return null
    }
  }
  return {
    async isRepository(directory) {
      return (await tryRun(['rev-parse', '--is-inside-work-tree'], directory))?.trim() === 'true'
    },
    async currentBranch(directory) {
      const branch = (await tryRun(['symbolic-ref', '--quiet', '--short', 'HEAD'], directory))?.trim()
      return branch || null
    },
    async isClean(directory) {
      const status = await run(['status', '--porcelain', '--untracked-files=normal'], directory)
      return status.trim().length === 0
    },
    async defaultBranch(directory) {
      const remoteHead = (await tryRun(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], directory))?.trim()
      if (remoteHead) return remoteHead.replace(/^origin\//, '')
      return null
    },
    async remoteUrl(directory) {
      return displayRemote((await tryRun(['remote', 'get-url', 'origin'], directory))?.trim() || null)
    },
    async createBranch(directory, branch) {
      const problem = branchNameProblem(branch)
      if (problem) throw new Error(problem)
      await run(['switch', '-c', branch], directory)
    },
    async listBranches(directory) {
      const output = (await tryRun(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin'], directory)) ?? ''
      const names = new Set<string>()
      for (const line of output.split(/\r?\n/)) {
        const ref = line.trim()
        if (ref.startsWith('refs/heads/')) names.add(ref.slice('refs/heads/'.length))
        else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') names.add(ref.slice('refs/remotes/origin/'.length))
      }
      return [...names].filter((name) => branchNameProblem(name) === null).sort((left, right) => left.localeCompare(right))
    },
    async listWorktrees(directory) {
      const output = (await tryRun(['worktree', 'list', '--porcelain'], directory)) ?? ''
      const worktrees: Record<string, string> = {}
      let path: string | null = null
      for (const line of output.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch refs/heads/') && path) worktrees[line.slice('branch refs/heads/'.length).trim()] = path
        else if (!line.trim()) path = null
      }
      return worktrees
    },
    async topLevel(directory) {
      return (await tryRun(['rev-parse', '--show-toplevel'], directory))?.trim() || null
    },
    async switchBranch(directory, branch) {
      const problem = branchNameProblem(branch)
      if (problem) throw new Error(problem)
      await run(['switch', branch], directory)
    },
    async fingerprint(directory) {
      const head = await tryRun(['rev-parse', 'HEAD'], directory)
      const status = await tryRun(['status', '--porcelain', '--untracked-files=all'], directory)
      if (status === null) return null
      const diff = (await tryRun(['diff', 'HEAD', '--no-color', '--no-ext-diff'], directory)) ?? ''
      return createHash('sha256')
        .update(head ?? '')
        .update('\0')
        .update(status)
        .update('\0')
        .update(diff)
        .digest('hex')
        .slice(0, 24)
    },
    async commitAll(directory, branch, message, allowProtected = false) {
      const current = await this.currentBranch(directory)
      if (current !== branch) throw new Error(`La branche active est « ${current ?? 'détachée'} » au lieu de « ${branch} » : rien n’est commité.`)
      if (!allowProtected && isProtectedBranch(branch, await this.defaultBranch(directory))) throw new Error(`Branche principale « ${branch} » : commit refusé (non autorisé au lancement du pilote).`)
      await run(['add', '--all'], directory)
      const stagedFiles = (await run(['diff', '--cached', '--name-only'], directory))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      if (stagedFiles.length === 0) return { sha: null, secrets: [], nothingToCommit: true }
      const diff = await run(['diff', '--cached', '--no-color', '--no-ext-diff', '--unified=0'], directory)
      const secrets = scanForSecrets(diff, stagedFiles)
      if (secrets.length > 0) {
        // Unstage only: the files stay exactly as they are on disk.
        await tryRun(['reset', '--quiet'], directory)
        return { sha: null, secrets, nothingToCommit: false }
      }
      // The project's own hooks still run.
      await run(['commit', '-m', message], directory)
      const sha = (await run(['rev-parse', 'HEAD'], directory)).trim()
      return { sha, secrets: [], nothingToCommit: false }
    },
    async push(directory, branch, allowProtected = false) {
      if (!allowProtected && isProtectedBranch(branch, await this.defaultBranch(directory))) throw new Error(`Branche principale « ${branch} » : push refusé (non autorisé au lancement du pilote).`)
      // Explicit refspec: only this branch, never forced.
      await run(['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], directory)
    }
  }
}

export function commitNote(record: Pick<CommitRecord, 'sha' | 'pushed' | 'note'>): string {
  if (!record.sha) return record.note ?? 'Aucun commit.'
  return `${record.sha.slice(0, 10)}${record.pushed ? ' (poussé)' : ''}${record.note ? ` — ${record.note}` : ''}`
}
