/**
 * Isolated conversations and their pull requests.
 *
 * - An isolated conversation works in its own git worktree, on its own branch, so two conversations
 *   of one repository never step on each other. Worktrees live in `<repo>/.aether/worktrees/`, a folder
 *   git ignores through the repository's local `info/exclude` (no tracked file is touched).
 * - Pushing never forces and never targets a main branch; a pull request is opened with the GitHub CLI
 *   when it is installed and signed in, else on GitHub's own page. Aether never handles a GitHub token.
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { compareUrl, githubRepository, parseAheadBehind, parsePullRequest, slugifyBranch, type BranchInfo, type PullRequestInfo } from '../../shared/branch'
import { branchNameProblem, isProtectedBranch } from '../../shared/pilot'

export type CommandRun = (file: string, args: string[], directory: string, timeoutMs?: number) => Promise<string>

export const runCommand: CommandRun = (file, args, directory, timeoutMs = 60_000) =>
  new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd: directory, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reject(Object.assign(new Error(`${file} est introuvable.`), { code: 'ENOENT' }))
        else reject(new Error((stderr || error.message).trim().slice(0, 800)))
        return
      }
      resolvePromise(stdout)
    })
  })

/** Where the GitHub CLI usually is on Windows, besides the PATH. */
function ghCandidates(): string[] {
  const candidates = ['gh']
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    candidates.push(join(programFiles, 'GitHub CLI', 'gh.exe'))
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'))
  }
  return candidates
}

export class BranchService {
  private ghPath: string | null | undefined

  constructor(private readonly run: CommandRun = runCommand) {}

  private git(args: string[], directory: string, timeoutMs?: number): Promise<string> {
    return this.run('git', ['-c', 'core.quotepath=off', ...args], directory, timeoutMs)
  }

  private async tryGit(args: string[], directory: string): Promise<string | null> {
    try {
      return await this.git(args, directory)
    } catch {
      return null
    }
  }

  /** The GitHub CLI and whether it is signed in. */
  async gh(directory: string): Promise<{ path: string | null; problem: string | null }> {
    // Only a found CLI is remembered: installed while Aether runs, it is picked up at the next look.
    if (!this.ghPath) {
      this.ghPath = null
      for (const candidate of ghCandidates()) {
        if (candidate !== 'gh' && !existsSync(candidate)) continue
        try {
          await this.run(candidate, ['--version'], directory, 10_000)
          this.ghPath = candidate
          break
        } catch {
          // next candidate
        }
      }
    }
    if (!this.ghPath) return { path: null, problem: 'GitHub CLI n’est pas installé : winget install GitHub.cli, puis gh auth login.' }
    try {
      await this.run(this.ghPath, ['auth', 'status', '--hostname', 'github.com'], directory, 15_000)
      return { path: this.ghPath, problem: null }
    } catch {
      return { path: this.ghPath, problem: 'GitHub CLI n’est pas connecté : lancez gh auth login dans un terminal.' }
    }
  }

  /** Forgets the GitHub CLI lookup (after the user installed it). */
  resetGh(): void {
    this.ghPath = undefined
  }

  async info(directory: string): Promise<BranchInfo> {
    const empty: BranchInfo = { isRepository: false, repositoryRoot: null, branch: null, isWorktree: false, defaultBranch: null, upstream: null, ahead: 0, behind: 0, uncommitted: 0, github: null, ghReady: false, ghProblem: null }
    const root = (await this.tryGit(['rev-parse', '--show-toplevel'], directory))?.trim()
    if (!root) return empty
    const [branch, gitDir, commonDir, upstream, status, remote, remoteHead] = await Promise.all([
      this.tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], directory),
      this.tryGit(['rev-parse', '--absolute-git-dir'], directory),
      this.tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], directory),
      this.tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], directory),
      this.tryGit(['status', '--porcelain', '--untracked-files=normal'], directory),
      this.tryGit(['remote', 'get-url', 'origin'], directory),
      this.tryGit(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], directory)
    ])
    const counts = upstream?.trim() ? parseAheadBehind((await this.tryGit(['rev-list', '--left-right', '--count', '@{u}...HEAD'], directory)) ?? '') : { ahead: 0, behind: 0 }
    const github = githubRepository(remote?.trim() ?? null)
    const gh = github ? await this.gh(directory) : { path: null, problem: null }
    const normalise = (path: string | null | undefined): string => resolve((path ?? '').trim()).toLowerCase()
    return {
      isRepository: true,
      repositoryRoot: root,
      branch: branch?.trim() || null,
      isWorktree: Boolean(gitDir?.trim() && commonDir?.trim() && normalise(gitDir) !== normalise(commonDir)),
      defaultBranch: remoteHead?.trim().replace(/^origin\//, '') || null,
      upstream: upstream?.trim() || null,
      ...counts,
      uncommitted: (status ?? '').split(/\r?\n/).filter(Boolean).length,
      github,
      ghReady: Boolean(gh.path && !gh.problem),
      ghProblem: gh.problem
    }
  }

  /**
   * Creates the worktree of an isolated conversation, branching from what `directory` has checked out.
   * Returns its folder and branch.
   */
  async createWorktree(directory: string, name: string, now = new Date()): Promise<{ path: string; branch: string }> {
    const root = (await this.git(['rev-parse', '--show-toplevel'], directory)).trim()
    const commonDir = (await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], directory)).trim()
    // The main checkout holds the worktrees, even when asked from another worktree.
    const mainRoot = (await this.tryGit(['rev-parse', '--show-toplevel'], resolve(commonDir, '..')))?.trim() || root
    const slug = slugifyBranch(name)
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const branch = `aether/${slug}-${stamp}`
    const problem = branchNameProblem(branch)
    if (problem) throw new Error(problem)
    const base = join(mainRoot, '.aether', 'worktrees')
    const path = join(base, `${slug}-${stamp}`)
    if (existsSync(path)) throw new Error(`Le dossier existe déjà : ${path}`)
    if ((await this.tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], directory))?.trim()) throw new Error(`La branche « ${branch} » existe déjà.`)
    // Keep .aether/ out of git status, through the repository's local exclude file (never .gitignore).
    const exclude = join(commonDir, 'info', 'exclude')
    try {
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!current.split(/\r?\n/).some((line) => line.trim() === '/.aether/')) {
        mkdirSync(join(commonDir, 'info'), { recursive: true })
        appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Aether: worktrees of isolated conversations\n/.aether/\n`)
      }
    } catch {
      // not fatal: the folder would only show as untracked
    }
    mkdirSync(base, { recursive: true })
    await this.git(['worktree', 'add', '-b', branch, path, 'HEAD'], directory, 120_000)
    return { path, branch }
  }

  /** Removes an isolated conversation's worktree; git refuses when it holds uncommitted work. The branch stays. */
  async removeWorktree(path: string): Promise<void> {
    const info = await this.info(path)
    if (!info.isWorktree) throw new Error('Ce dossier n’est pas le worktree d’une conversation isolée.')
    const commonDir = (await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path)).trim()
    await this.git(['worktree', 'remove', path], resolve(commonDir, '..'))
  }

  /** `git push -u origin <branch>`: never forced, never a main branch. */
  async push(directory: string): Promise<{ branch: string }> {
    const info = await this.info(directory)
    if (!info.isRepository || !info.branch) throw new Error('Aucune branche active à pousser.')
    if (isProtectedBranch(info.branch, info.defaultBranch)) throw new Error(`« ${info.branch} » est une branche principale : Aether ne la pousse pas. Travaillez dans une conversation isolée.`)
    await this.git(['push', '--set-upstream', 'origin', `refs/heads/${info.branch}:refs/heads/${info.branch}`], directory, 180_000)
    return { branch: info.branch }
  }

  async pullRequest(directory: string): Promise<PullRequestInfo | null> {
    const info = await this.info(directory)
    if (!info.branch || !info.github) return null
    const gh = await this.gh(directory)
    if (!gh.path || gh.problem) return null
    try {
      const output = await this.run(gh.path, ['pr', 'view', info.branch, '--repo', info.github, '--json', 'number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup'], directory, 30_000)
      return parsePullRequest(output)
    } catch (error) {
      if (error instanceof Error && /no pull requests found|could not find/i.test(error.message)) return null
      throw error
    }
  }

  /**
   * Opens the pull request of the branch: with the GitHub CLI when ready (returns its URL), else returns
   * GitHub's page to open it by hand. Pushes the branch first.
   */
  async createPullRequest(directory: string, title: string, body: string, draft: boolean): Promise<{ url: string; created: boolean }> {
    const info = await this.info(directory)
    if (!info.github) throw new Error('Le dépôt distant n’est pas sur GitHub.')
    if (!info.branch) throw new Error('Aucune branche active.')
    const base = info.defaultBranch ?? 'main'
    if (info.branch === base) throw new Error(`Vous êtes sur « ${base} » : une PR part d’une autre branche.`)
    await this.push(directory)
    const gh = await this.gh(directory)
    if (!gh.path || gh.problem) return { url: compareUrl(info.github, base, info.branch), created: false }
    const output = await this.run(gh.path, ['pr', 'create', '--repo', info.github, '--head', info.branch, '--base', base, '--title', title.slice(0, 250), '--body', body.slice(0, 60_000), ...(draft ? ['--draft'] : [])], directory, 60_000)
    const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(output)?.[0]
    if (!url) throw new Error('GitHub CLI n’a pas renvoyé l’adresse de la PR.')
    return { url, created: true }
  }
}

/** The folder of an isolated conversation must be one of Aether's worktrees. */
export function isAetherWorktreePath(path: string): boolean {
  return isAbsolute(path) && /[\\/]\.aether[\\/]worktrees[\\/][^\\/]+[\\/]?$/i.test(path)
}
