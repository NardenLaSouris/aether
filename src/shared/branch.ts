/**
 * A conversation's branch: its git state, its pull request and the CI checks (pure parsing, tested).
 */

export interface BranchInfo {
  isRepository: boolean
  repositoryRoot: string | null
  branch: string | null
  /** The folder is a linked worktree (an isolated conversation), not the main checkout. */
  isWorktree: boolean
  defaultBranch: string | null
  upstream: string | null
  ahead: number
  behind: number
  uncommitted: number
  /** `owner/name` when origin is on GitHub. */
  github: string | null
  /** GitHub CLI found and signed in. */
  ghReady: boolean
  ghProblem: string | null
}

export type CheckState = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral'

export interface PullRequestCheck {
  name: string
  state: CheckState
  url: string | null
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: string | null
  reviewDecision: string | null
  checks: PullRequestCheck[]
}

/** `https://github.com/o/r.git`, `git@github.com:o/r.git` → `o/r`; other hosts → null. */
export function githubRepository(remoteUrl: string | null): string | null {
  if (!remoteUrl) return null
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remoteUrl.trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/** The GitHub page that opens a pull request of `branch` into `base`. */
export function compareUrl(repository: string, base: string, branch: string): string {
  const encode = (value: string): string => value.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${repository}/compare/${encode(base)}...${encode(branch)}?expand=1`
}

/** A readable branch name from a free text: `Export PDF !` → `export-pdf`. */
export function slugifyBranch(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'conversation'
  )
}

function checkState(raw: Record<string, unknown>): CheckState {
  // CheckRun: status + conclusion; StatusContext: state.
  const conclusion = String(raw.conclusion ?? '').toUpperCase()
  const status = String(raw.status ?? '').toUpperCase()
  const state = String(raw.state ?? '').toUpperCase()
  if (state) {
    if (state === 'SUCCESS') return 'success'
    if (state === 'FAILURE' || state === 'ERROR') return 'failure'
    return 'pending'
  }
  if (status && status !== 'COMPLETED') return 'pending'
  if (conclusion === 'SUCCESS') return 'success'
  if (conclusion === 'SKIPPED') return 'skipped'
  if (conclusion === 'NEUTRAL') return 'neutral'
  if (!conclusion) return 'pending'
  return 'failure'
}

/** `gh pr view --json number,url,title,state,isDraft,mergeable,reviewDecision,statusCheckRollup`. */
export function parsePullRequest(json: string): PullRequestInfo | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof raw.number !== 'number' || typeof raw.url !== 'string') return null
  const rollup = Array.isArray(raw.statusCheckRollup) ? (raw.statusCheckRollup as Record<string, unknown>[]) : []
  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN'
  return {
    number: raw.number,
    url: raw.url,
    title: typeof raw.title === 'string' ? raw.title : '',
    state,
    isDraft: raw.isDraft === true,
    mergeable: typeof raw.mergeable === 'string' ? raw.mergeable : null,
    reviewDecision: typeof raw.reviewDecision === 'string' && raw.reviewDecision ? raw.reviewDecision : null,
    checks: rollup.map((check) => ({
      name: String(check.name ?? check.context ?? 'vérification'),
      state: checkState(check),
      url: typeof check.detailsUrl === 'string' ? check.detailsUrl : typeof check.targetUrl === 'string' ? check.targetUrl : null
    }))
  }
}

/** `git rev-list --left-right --count @{u}...HEAD` → behind / ahead. */
export function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const [behind, ahead] = output.trim().split(/\s+/).map(Number)
  return { ahead: Number.isFinite(ahead) ? (ahead as number) : 0, behind: Number.isFinite(behind) ? (behind as number) : 0 }
}

/** The message that asks Claude to fix the failing checks. */
export function fixChecksPrompt(pullRequest: PullRequestInfo): string {
  const failing = pullRequest.checks.filter((check) => check.state === 'failure')
  return [
    `La CI de la PR #${pullRequest.number} échoue sur : ${failing.map((check) => check.name).join(', ')}.`,
    'Lis les journaux des vérifications en échec (`gh pr checks` puis `gh run view --log-failed`), trouve la cause, corrige-la, vérifie localement, puis commite et pousse sur cette branche (jamais en force).'
  ].join('\n')
}
