import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareUrl, fixChecksPrompt, githubRepository, parseAheadBehind, parsePullRequest, slugifyBranch } from '../../src/shared/branch'
import { BranchService, isAetherWorktreePath } from '../../src/main/services/branchService'

describe('branch helpers', () => {
  it('recognises GitHub remotes and builds the compare page', () => {
    expect(githubRepository('https://github.com/NardenLaSouris/ORION.git')).toBe('NardenLaSouris/ORION')
    expect(githubRepository('git@github.com:org/repo.git')).toBe('org/repo')
    expect(githubRepository('https://gitlab.com/org/repo.git')).toBeNull()
    expect(compareUrl('org/repo', 'main', 'aether/export-pdf')).toBe('https://github.com/org/repo/compare/main...aether/export-pdf?expand=1')
  })

  it('makes branch names out of free text', () => {
    expect(slugifyBranch('Export PDF des factures !')).toBe('export-pdf-des-factures')
    expect(slugifyBranch('Réparer l’écran')).toBe('reparer-l-ecran')
    expect(slugifyBranch('???')).toBe('conversation')
  })

  it('reads a pull request and its checks', () => {
    const pullRequest = parsePullRequest(
      JSON.stringify({
        number: 12,
        url: 'https://github.com/o/r/pull/12',
        title: 'Export',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/1' },
          { __typename: 'CheckRun', name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
          { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS', targetUrl: 'https://vercel.com/x' },
          { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }
        ]
      })
    )
    expect(pullRequest).toMatchObject({ number: 12, state: 'OPEN', reviewDecision: null })
    expect(pullRequest?.checks.map((check) => [check.name, check.state])).toEqual([
      ['tests', 'failure'],
      ['lint', 'pending'],
      ['vercel', 'success'],
      ['docs', 'skipped']
    ])
    expect(fixChecksPrompt(pullRequest!)).toContain('échoue sur : tests')
    expect(parsePullRequest('pas du json')).toBeNull()
    expect(parseAheadBehind('2\t5\n')).toEqual({ behind: 2, ahead: 5 })
  })
})

describe('isolated conversations (real git)', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' })

  it('creates a worktree on its own branch, keeps it out of git status, refuses to push main, and removes it', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'aether-branch-'))
    directories.push(repository)
    git(repository, 'init', '-b', 'main')
    writeFileSync(join(repository, 'a.txt'), 'un\n')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'init')

    const service = new BranchService()
    const main = await service.info(repository)
    expect(main).toMatchObject({ isRepository: true, branch: 'main', isWorktree: false, uncommitted: 0, github: null })
    await expect(service.push(repository)).rejects.toThrow(/branche principale/)

    const worktree = await service.createWorktree(repository, 'Export PDF', new Date(2026, 10, 7, 9, 5))
    expect(worktree.branch).toBe('aether/export-pdf-20261107-0905')
    expect(isAetherWorktreePath(worktree.path)).toBe(true)
    expect(existsSync(join(worktree.path, 'a.txt'))).toBe(true)
    expect(await service.info(worktree.path)).toMatchObject({ branch: worktree.branch, isWorktree: true })
    // The worktrees folder does not show up in the main checkout, and no tracked file changed.
    expect(git(repository, 'status', '--porcelain').trim()).toBe('')
    expect(readFileSync(join(repository, '.git', 'info', 'exclude'), 'utf8')).toContain('/.aether/')
    await expect(service.createWorktree(repository, 'Export PDF', new Date(2026, 10, 7, 9, 5))).rejects.toThrow()

    // Uncommitted work blocks the removal; once committed, the worktree goes and the branch stays.
    writeFileSync(join(worktree.path, 'b.txt'), 'deux\n')
    await expect(service.removeWorktree(worktree.path)).rejects.toThrow()
    git(worktree.path, 'add', '.')
    git(worktree.path, 'commit', '-m', 'b')
    await service.removeWorktree(worktree.path)
    expect(existsSync(worktree.path)).toBe(false)
    expect(git(repository, 'branch', '--list', worktree.branch).trim()).toContain(worktree.branch)
  }, 60_000)
})
