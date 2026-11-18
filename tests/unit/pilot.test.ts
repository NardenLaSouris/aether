import { describe, expect, it, vi } from 'vitest'
import type { EngineEvent, TurnResultPayload } from '../../src/shared/engineProtocol'
import {
  allowRuleForCheck,
  allowRuleProblem,
  branchNameProblem,
  buildCodexPrompt,
  detectStagnation,
  formatClaudeInstruction,
  isProtectedBranch,
  parseClaudeReport,
  parseCodexDecision,
  pilotBranchName,
  pilotConfigSchema,
  scanForSecrets,
  type CheckResult,
  type CodexStatus,
  type PilotConfig,
  type PilotRound,
  type PilotSnapshot
} from '../../src/shared/pilot'
import { codexExecArguments, foldCodexEvents, parseCodexSettings, type CodexTurnRequest, type CodexTurnResult } from '../../src/main/codex/codexCli'
import { displayRemote, type PilotGit } from '../../src/main/codex/pilotGit'
import { PilotService, type PilotServiceDependencies } from '../../src/main/codex/pilotService'

const CONFIG: PilotConfig = { objective: 'Ajouter un export PDF', doneCriteria: 'tests verts', checks: ['pnpm test'], allowFileEdits: true, allowedTools: ['Bash(pnpm test:*)'], autoCommit: true, codexReadsProject: true }

function round(partial: Partial<PilotRound>): PilotRound {
  return { index: 1, instruction: 'faire x', startedAt: 0, finishedAt: 1, report: null, checks: [], fingerprint: null, claudeError: null, commit: null, ...partial }
}

describe('GPT decisions', () => {
  it('reads the JSON decision, even surrounded by text', () => {
    const decision = parseCodexDecision('Voici : {"action":"continue","message":"Crée le module","previous_task_accepted":false,"commit_message":"","rationale":"début"}')
    expect(decision).toEqual({ action: 'continue', message: 'Crée le module', previousTaskAccepted: false, commitMessage: '', rationale: 'début' })
  })

  it('refuses anything else', () => {
    expect(parseCodexDecision(null)).toBeNull()
    expect(parseCodexDecision('pas du json')).toBeNull()
    expect(parseCodexDecision('{"action":"jump","message":"x","previous_task_accepted":true,"commit_message":"","rationale":""}')).toBeNull()
    expect(parseCodexDecision('{"action":"continue","message":"  ","previous_task_accepted":true,"commit_message":"","rationale":""}')).toBeNull()
  })
})

describe('Claude reports', () => {
  it('reads the last report block', () => {
    const text = `Fait.\n<rapport-aether>{"statut":"partiel","resume":"a"}</rapport-aether>\nPuis :\n<rapport-aether>\n{"statut": "terminé", "resume": "Export ajouté", "fichiers": ["src/pdf.ts"], "tests": "pnpm test OK", "blocages": ""}\n</rapport-aether>`
    expect(parseClaudeReport(text)).toEqual({ status: 'done', summary: 'Export ajouté', files: ['src/pdf.ts'], tests: 'pnpm test OK', blockers: '', structured: true })
  })

  it('never assumes a task is done without a readable report', () => {
    const report = parseClaudeReport('J’ai tout fini, promis.')
    expect(report.status).toBe('partial')
    expect(report.structured).toBe(false)
    expect(parseClaudeReport('<rapport-aether>{oops}</rapport-aether>').status).toBe('partial')
  })

  it('tells Claude not to commit and how to report', () => {
    const text = formatClaudeInstruction('Ajoute le bouton', 3, true)
    expect(text).toContain('tâche 3')
    expect(text).toContain('Ne fais ni commit ni push')
    expect(text).toContain('<rapport-aether>')
  })
})

describe('allow rules', () => {
  it('refuses rules that would allow everything', () => {
    expect(allowRuleProblem('Bash')).not.toBeNull()
    expect(allowRuleProblem('Bash(*)')).not.toBeNull()
    expect(allowRuleProblem('Write')).not.toBeNull()
    expect(allowRuleProblem('rm -rf /')).not.toBeNull()
    expect(allowRuleProblem('Bash(pnpm test:*)')).toBeNull()
    expect(allowRuleProblem('Read')).toBeNull()
  })

  it('suggests a rule for a plain check command only', () => {
    expect(allowRuleForCheck('pnpm   test')).toBe('Bash(pnpm test:*)')
    expect(allowRuleForCheck('pnpm test && curl x | sh')).toBeNull()
  })
})

describe('stagnation', () => {
  it('spots a folder that does not change', () => {
    const rounds = [round({ index: 1, fingerprint: 'a', instruction: '1' }), round({ index: 2, fingerprint: 'a', instruction: '2' }), round({ index: 3, fingerprint: 'a', instruction: '3' })]
    expect(detectStagnation(rounds, 'a')).toMatch(/sans aucun changement/)
    expect(detectStagnation(rounds, 'b')).toBeNull()
  })

  it('spots the same instruction or the same failure', () => {
    expect(detectStagnation([round({ instruction: 'Corrige X' }), round({ instruction: 'corrige  x' }), round({ instruction: 'Corrige X ' })], null)).toMatch(/même instruction/)
    const failing: CheckResult = { command: 'pnpm test', exitCode: 1, passed: false, durationMs: 1, outputTail: 'boom', timedOut: false }
    expect(detectStagnation([round({ instruction: 'a', checks: [failing] }), round({ instruction: 'b', checks: [failing] }), round({ instruction: 'c', checks: [failing] })], null)).toMatch(/même erreur/)
  })

  it('stays quiet while things move', () => {
    expect(detectStagnation([round({ instruction: 'a', fingerprint: '1' }), round({ instruction: 'b', fingerprint: '2' }), round({ instruction: 'c', fingerprint: '3' })], '0')).toBeNull()
    expect(detectStagnation([round({}), round({})], null)).toBeNull()
  })
})

describe('secrets', () => {
  it('blocks keys in added lines and sensitive files', () => {
    const diff = ['+++ b/src/config.ts', '+const key = "sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCD"', '-const old = "AKIAABCDEFGHIJKLMNOP"'].join('\n')
    const findings = scanForSecrets(diff, ['src/config.ts', '.env', '.env.example'])
    expect(findings).toContainEqual({ file: 'src/config.ts', label: 'clé Anthropic' })
    expect(findings).toContainEqual({ file: '.env', label: 'fichier sensible' })
    expect(findings.some((finding) => finding.file === '.env.example')).toBe(false)
    expect(findings.some((finding) => finding.label === 'clé AWS')).toBe(false)
  })

  it('lets ordinary code through', () => {
    expect(scanForSecrets('+++ b/a.ts\n+const token = getToken()\n', ['a.ts'])).toEqual([])
  })
})

describe('branches', () => {
  it('names the pilot branch from the objective', () => {
    expect(pilotBranchName('Ajouter l’export PDF des conversations !', new Date(2026, 10, 7, 9, 5))).toBe('aether/pilote-ajouter-l-export-pdf-des-20261107-0905')
  })

  it('protects every branch but its own', () => {
    expect(isProtectedBranch('main', 'main')).toBe(true)
    expect(isProtectedBranch('feature/x', 'main')).toBe(false)
    expect(isProtectedBranch('develop', 'main')).toBe(true)
    expect(isProtectedBranch('aether/pilote-x', 'main')).toBe(false)
    expect(isProtectedBranch('aether/pilote-x', 'aether/pilote-x')).toBe(true)
  })

  it('hides credentials in the remote shown', () => {
    expect(displayRemote('https://user:token@github.com/a/b.git')).toBe('https://github.com/a/b.git')
  })
})

describe('Codex CLI', () => {
  it('runs read-only, without approvals, without the user config, prompt on stdin', () => {
    const settings = { model: 'gpt-x', reasoningEffort: 'medium', windowsSandbox: 'elevated' as const }
    const first = codexExecArguments({ threadId: null, schemaPath: 'C:/s.json', settings, skipGitCheck: true, workingDirectory: 'C:/p' })
    expect(first.slice(0, 2)).toEqual(['exec', '--json'])
    expect(first).toContain('--ignore-user-config')
    expect(first).toContain('sandbox_mode="read-only"')
    expect(first).toContain('approval_policy="never"')
    expect(first).toContain('windows.sandbox="elevated"')
    expect(first).toContain('--skip-git-repo-check')
    expect(first.slice(-3)).toEqual(['--cd', 'C:/p', '-'])
    expect(first.join(' ')).not.toMatch(/dangerously|full-access|workspace-write/)
    const resumed = codexExecArguments({ threadId: 'thread-1', schemaPath: 'C:/s.json', settings, skipGitCheck: false, workingDirectory: 'C:/p' })
    expect(resumed.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(resumed.slice(-2)).toEqual(['thread-1', '-'])
    expect(resumed).not.toContain('--cd')
  })

  it('folds the JSON events Codex prints', () => {
    const result = foldCodexEvents([
      '{"type":"thread.started","thread_id":"01a1"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Je lis."}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"git diff","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"{\\"action\\":\\"done\\"}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20}}',
      '2026-11-07T12:31:11Z ERROR something logged'
    ])
    expect(result).toEqual({ threadId: '01a1', finalMessage: '{"action":"done"}', inputTokens: 100, outputTokens: 20, error: null, activity: ['git diff'] })
    expect(foldCodexEvents(['{"type":"turn.failed","error":{"message":"usage limit reached"}}']).error).toBe('usage limit reached')
  })

  it('carries over only the model, effort and Windows sandbox of the user config', () => {
    const toml = ['notify = ["x.exe"]', 'model = "gpt-6-luna"', 'model_reasoning_effort = "medium"', '[mcp_servers.node_repl]', 'command = "repl.exe"', 'model = "ignored"', '[windows]', 'sandbox = "elevated"'].join('\n')
    expect(parseCodexSettings(toml)).toEqual({ model: 'gpt-6-luna', reasoningEffort: 'medium', windowsSandbox: 'elevated' })
    expect(parseCodexSettings('model = "bad value; rm"')).toEqual({ model: null, reasoningEffort: null, windowsSandbox: 'unelevated' })
  })
})

describe('GPT prompt', () => {
  it('gives the whole picture to a new thread only', () => {
    const fresh = buildCodexPrompt({ config: CONFIG, rounds: [], answers: [], freshThread: true, stagnationWarning: null })
    expect(fresh).toContain('Ajouter un export PDF')
    expect(fresh).toContain('Début de session')
    const resumed = buildCodexPrompt({ config: CONFIG, rounds: [round({ report: parseClaudeReport('x') })], answers: ['Oui, en A4'], freshThread: false, stagnationWarning: null })
    expect(resumed).not.toContain('## Objectif')
    expect(resumed).toContain('Tâche à juger')
    expect(resumed).toContain('> Oui, en A4')
  })
})

// ---------------------------------------------------------------------------
// The loop, with doubles for Claude, Codex, git and the checks
// ---------------------------------------------------------------------------

const DECISION = (action: string, message: string, accepted = false, commitMessage = '') => JSON.stringify({ action, message, previous_task_accepted: accepted, commit_message: commitMessage, rationale: 'r' })
const DONE_REPORT = '<rapport-aether>{"statut":"termine","resume":"fait","fichiers":["a.ts"],"tests":"ok","blocages":""}</rapport-aether>'

function turnResult(resultText: string, isError = false): TurnResultPayload {
  return { subtype: isError ? 'error_during_execution' : 'success', isError, durationMs: 1, totalCostUsd: null, inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, errors: isError ? ['boom'] : [], resultText, apiErrorStatus: null, model: 'claude' }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

function harness(options: { codexReplies?: (CodexTurnResult | string)[]; loggedIn?: boolean; canSend?: () => boolean; checksPass?: boolean; secrets?: boolean; stored?: PilotSnapshot[] } = {}) {
  const replies = [...(options.codexReplies ?? [])]
  const codexRequests: CodexTurnRequest[] = []
  const sent: string[] = []
  const saved: PilotSnapshot[] = []
  const status: CodexStatus = { found: true, executablePath: 'codex.exe', version: '0.167.0', source: 'path', loggedIn: options.loggedIn ?? true, loginDetail: 'Logged in using ChatGPT', error: null }
  const git: PilotGit = {
    isRepository: vi.fn(async () => true),
    currentBranch: vi.fn(async (directory: string) => (directory === 'C:/projet-v3' ? 'v3' : 'main')),
    isClean: vi.fn(async () => true),
    defaultBranch: vi.fn(async () => 'main'),
    remoteUrl: vi.fn(async () => 'https://github.com/me/app.git'),
    createBranch: vi.fn(async () => undefined),
    listBranches: vi.fn(async () => ['feature/x', 'main', 'v3']),
    listWorktrees: vi.fn(async (): Promise<Record<string, string>> => ({ main: 'C:/projet', v3: 'C:/projet-v3' })),
    topLevel: vi.fn(async () => 'C:/projet'),
    switchBranch: vi.fn(async () => undefined),
    fingerprint: vi.fn(async () => `fp-${sent.length}`),
    commitAll: vi.fn(async () => (options.secrets ? { sha: null, secrets: [{ file: '.env', label: 'fichier sensible' }], nothingToCommit: false } : { sha: 'abcdef1234567890', secrets: [], nothingToCommit: false })),
    push: vi.fn(async () => undefined)
  }
  const chat = {
    send: vi.fn(async (_conversationId: string, text: string) => {
      if (options.canSend && !options.canSend()) return { accepted: false, reason: 'limite' }
      sent.push(text)
      return { accepted: true }
    }),
    interrupt: vi.fn(async () => undefined),
    closeRunner: vi.fn(async () => undefined)
  }
  const notify = vi.fn()
  const dependencies: PilotServiceDependencies = {
    now: () => 1_000,
    newId: () => 'id-1',
    storage: { loadAll: () => options.stored ?? [], save: (snapshot) => saved.push(snapshot) },
    findConversation: (id) => (id === 'c1' ? { id, title: 'Conv', workingDirectory: 'C:/projet' } : null),
    chat,
    isClaudeBusy: () => false,
    canSendToClaude: () => (options.canSend && !options.canSend() ? { allowed: false, reason: 'Limite 5 h atteinte.' } : { allowed: true }),
    codex: {
      status: async () => status,
      launch: async () => ({ command: 'codex.exe', prefixArgs: [], source: 'path' }),
      settings: () => ({ model: null, reasoningEffort: null, windowsSandbox: 'unelevated' }),
      startTurn: (request) => {
        codexRequests.push(request)
        const reply = replies.shift() ?? { threadId: 't1', finalMessage: null, inputTokens: 0, outputTokens: 0, error: 'plus de réponse prévue', activity: [] }
        const result: CodexTurnResult = typeof reply === 'string' ? { threadId: 't1', finalMessage: reply, inputTokens: 50, outputTokens: 10, error: null, activity: [] } : reply
        return { done: Promise.resolve(result), cancel: () => undefined }
      }
    },
    git,
    runChecks: (commands) => ({ done: Promise.resolve(commands.map((command) => ({ command, exitCode: options.checksPass === false ? 1 : 0, passed: options.checksPass !== false, durationMs: 1, outputTail: options.checksPass === false ? 'FAIL' : 'ok', timedOut: false }))), cancel: () => undefined }),
    schemaPath: 'schema.json',
    isolatedDirectory: 'C:/isolated',
    publish: () => undefined,
    notify,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
  }
  const service = new PilotService(dependencies)
  const claudeAnswers = async (text: string, isError = false): Promise<void> => {
    const event: EngineEvent = { type: 'turn_result', conversationId: 'c1', sessionId: 's', result: turnResult(text, isError) }
    service.handleEngineEvent(event)
    await flush()
  }
  return { service, chat, git, codexRequests, sent, saved, notify, claudeAnswers }
}

describe('pilot loop', () => {
  it('refuses to link a Codex that is not signed in', async () => {
    const { service } = harness({ loggedIn: false })
    await expect(service.link('c1')).rejects.toThrow(/codex login/)
    expect(service.get('c1').linked).toBe(false)
  })

  it('pre-approves every shell command when the user opts in', async () => {
    const { service, codexRequests } = harness({ codexReplies: [DECISION('continue', 'Lance les tests')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, allowFileEdits: false, allowAllCommands: true })
    await flush()
    expect(service.launchOverrides('c1')).toEqual({ permissionMode: 'bypassPermissions', allowedTools: ['Bash(pnpm test:*)', 'Bash', 'PowerShell'] })
    expect(codexRequests[0]?.prompt).toContain('toutes les commandes')
    await service.stop('c1')
    expect(service.launchOverrides('c1')).toBeNull()
  })

  it('works on an existing branch the user picked, and commits there', async () => {
    const { service, git, claudeAnswers } = harness({ codexReplies: [DECISION('continue', 'Tâche'), DECISION('done', 'Fini', true, 'Do it')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, branch: { mode: 'existing', name: 'feature/x' } })
    await flush()
    expect(git.switchBranch).toHaveBeenCalledWith('C:/projet', 'feature/x')
    expect(git.createBranch).not.toHaveBeenCalled()
    expect(service.get('c1').branch).toBe('feature/x')
    await claudeAnswers(`ok\n${DONE_REPORT}`)
    expect(git.commitAll).toHaveBeenCalledWith('C:/projet', 'feature/x', 'Do it', false)
    expect(git.push).toHaveBeenCalledWith('C:/projet', 'feature/x', false)
  })

  it('works in the worktree where the chosen branch is already checked out', async () => {
    const { service, git, codexRequests, sent, claudeAnswers } = harness({ codexReplies: [DECISION('continue', 'Tâche'), DECISION('done', 'Fini', true, 'Do it')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, branch: { mode: 'existing', name: 'v3' } })
    await flush()
    expect(git.switchBranch).not.toHaveBeenCalled()
    expect(service.get('c1').workDirectory).toBe('C:/projet-v3')
    expect(service.get('c1').branch).toBe('v3')
    expect(codexRequests[0]?.workingDirectory).toBe('C:/projet-v3')
    expect(sent[0]).toContain('C:/projet-v3')
    await claudeAnswers(`ok\n${DONE_REPORT}`)
    expect(git.commitAll).toHaveBeenCalledWith('C:/projet-v3', 'v3', 'Do it', false)
    expect(git.push).toHaveBeenCalledWith('C:/projet-v3', 'v3', false)
  })

  it('creates a branch with the name the user typed, refusing one that exists', async () => {
    const { service, git } = harness({ codexReplies: [DECISION('continue', 'Tâche')] })
    await service.link('c1')
    await expect(service.start('c1', { ...CONFIG, branch: { mode: 'create', name: 'feature/x' } })).rejects.toThrow(/existe déjà/)
    await service.start('c1', { ...CONFIG, branch: { mode: 'create', name: 'feature/pdf' } })
    expect(git.createBranch).toHaveBeenCalledWith('C:/projet', 'feature/pdf')
  })

  it('auto-commits on a main branch only when the user accepted it', async () => {
    const { service, git } = harness({ codexReplies: [DECISION('continue', 'Tâche')] })
    await service.link('c1')
    await expect(service.start('c1', { ...CONFIG, branch: { mode: 'current' } })).rejects.toThrow(/branche principale/)
    expect(git.switchBranch).not.toHaveBeenCalled()
    await service.start('c1', { ...CONFIG, branch: { mode: 'current' }, allowProtectedBranch: true })
    expect(service.get('c1').branch).toBe('main')
    expect(git.createBranch).not.toHaveBeenCalled()
  })

  it('rejects branch names git could misread', () => {
    expect(branchNameProblem('feature/pdf')).toBeNull()
    expect(branchNameProblem('-f')).not.toBeNull()
    expect(branchNameProblem('a..b')).not.toBeNull()
    expect(branchNameProblem('a b')).not.toBeNull()
  })

  it('keeps the usual permissions when "all commands" is off', () => {
    expect(pilotConfigSchema.parse({ ...CONFIG }).allowAllCommands).toBe(false)
    expect(allowRuleProblem('Bash')).not.toBeNull()
  })

  it('runs GPT → Claude → checks → commit + push → GPT until done', async () => {
    const { service, chat, git, codexRequests, sent, claudeAnswers, notify } = harness({ codexReplies: [DECISION('continue', 'Crée src/pdf.ts'), DECISION('done', 'Export livré', true, 'Add PDF export')] })
    await service.link('c1')
    await service.start('c1', CONFIG)
    await flush()
    expect(git.createBranch).toHaveBeenCalledWith('C:/projet', expect.stringMatching(/^aether\/pilote-ajouter-un-export-pdf-/))
    // Claude's session restarts with the user's pre-authorisations.
    expect(chat.closeRunner).toHaveBeenCalledWith('c1')
    expect(service.launchOverrides('c1')).toEqual({ permissionMode: 'acceptEdits', allowedTools: ['Bash(pnpm test:*)'] })
    expect(codexRequests[0]?.threadId).toBeNull()
    expect(codexRequests[0]?.workingDirectory).toBe('C:/projet')
    expect(sent[0]).toContain('Crée src/pdf.ts')
    expect(service.get('c1').status).toBe('working')

    await claudeAnswers(`Voilà.\n${DONE_REPORT}`)
    // Second GPT turn resumes the same thread and judges the task.
    expect(codexRequests[1]?.threadId).toBe('t1')
    expect(git.commitAll).toHaveBeenCalledWith('C:/projet', expect.stringMatching(/^aether\/pilote-/), 'Add PDF export', false)
    expect(git.push).toHaveBeenCalledTimes(1)
    const finished = service.get('c1')
    expect(finished.status).toBe('done')
    expect(finished.statusMessage).toBe('Export livré')
    expect(finished.rounds[0]?.commit).toMatchObject({ sha: 'abcdef1234567890', pushed: true })
    expect(finished.usage).toMatchObject({ codexTurns: 2, claudeTurns: 1 })
    expect(notify).toHaveBeenCalledWith('Pilote Codex terminé', expect.any(String))
    // Done: the pre-authorisations are gone.
    expect(service.launchOverrides('c1')).toBeNull()
  })

  it('does not commit when a check fails, even if GPT accepts', async () => {
    const { service, git, claudeAnswers } = harness({ checksPass: false, codexReplies: [DECISION('continue', 'tâche'), DECISION('continue', 'corrige', true, 'msg')] })
    await service.link('c1')
    await service.start('c1', CONFIG)
    await flush()
    await claudeAnswers(DONE_REPORT)
    expect(git.commitAll).not.toHaveBeenCalled()
    expect(service.get('c1').rounds[0]?.commit?.note).toMatch(/vérifications échouent/)
  })

  it('pauses instead of pushing when a secret is staged', async () => {
    const { service, git, claudeAnswers } = harness({ secrets: true, codexReplies: [DECISION('continue', 'tâche'), DECISION('continue', 'suite', true, 'msg')] })
    await service.link('c1')
    await service.start('c1', CONFIG)
    await flush()
    await claudeAnswers(DONE_REPORT)
    expect(git.push).not.toHaveBeenCalled()
    const paused = service.get('c1')
    expect(paused.status).toBe('paused')
    expect(paused.statusMessage).toMatch(/secret possible/)
    // Resuming carries on with GPT's next instruction.
    expect(paused.resumeStep).toBe('send')
    expect(paused.pendingInstruction).toBe('suite')
  })

  it('pauses on a Claude error and never retries by itself', async () => {
    const { service, codexRequests, sent, claudeAnswers } = harness({ codexReplies: [DECISION('continue', 'tâche')] })
    await service.link('c1')
    await service.start('c1', CONFIG)
    await flush()
    await claudeAnswers('', true)
    expect(service.get('c1').status).toBe('paused')
    expect(codexRequests).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  it('refuses to start with pending changes when commits are automatic', async () => {
    const { service, git } = harness()
    vi.mocked(git.isClean).mockResolvedValue(false)
    await service.link('c1')
    await expect(service.start('c1', CONFIG)).rejects.toThrow(/modifications non commitées/)
  })

  it('waits for the Claude quota and resumes on real quota data', async () => {
    let allowed = false
    const { service, sent } = harness({ canSend: () => allowed, codexReplies: [DECISION('continue', 'tâche')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, autoCommit: false })
    await flush()
    expect(service.get('c1').status).toBe('waiting_quota')
    service.onQuotaChange()
    await flush()
    expect(sent).toHaveLength(0)
    allowed = true
    service.onQuotaChange()
    await flush()
    expect(sent).toHaveLength(1)
    expect(service.get('c1').status).toBe('working')
  })

  it('asks the user, then gives the answer to GPT', async () => {
    const { service, codexRequests } = harness({ codexReplies: [DECISION('ask_user', 'Format A4 ou Lettre ?'), DECISION('continue', 'Fais A4')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, autoCommit: false })
    await flush()
    expect(service.get('c1')).toMatchObject({ status: 'paused', question: 'Format A4 ou Lettre ?' })
    expect(() => service.resume('c1')).toThrow(/attend votre réponse/)
    service.answer('c1', 'A4')
    await flush()
    expect(codexRequests[1]?.prompt).toContain('> A4')
    expect(service.get('c1').status).toBe('working')
  })

  it('pauses when GPT is stuck at its usage limit', async () => {
    const { service } = harness({ codexReplies: [{ threadId: null, finalMessage: null, inputTokens: 0, outputTokens: 0, error: 'You have hit your usage limit. Try again in 3 hours.', activity: [] }] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, autoCommit: false })
    await flush()
    expect(service.get('c1').statusMessage).toMatch(/Limite d’usage ChatGPT/)
  })

  it('lets GPT read only an empty folder when it may not read the project', async () => {
    const { service, codexRequests } = harness({ codexReplies: [DECISION('done', 'rien à faire')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, autoCommit: false, codexReadsProject: false })
    await flush()
    expect(codexRequests[0]?.workingDirectory).toBe('C:/isolated')
    expect(codexRequests[0]?.skipGitCheck).toBe(true)
  })

  it('stops: interrupts Claude and drops the pre-authorisations', async () => {
    const { service, chat } = harness({ codexReplies: [DECISION('continue', 'tâche')] })
    await service.link('c1')
    await service.start('c1', { ...CONFIG, autoCommit: false })
    await flush()
    await service.stop('c1')
    expect(chat.interrupt).toHaveBeenCalledWith('c1')
    expect(service.get('c1').status).toBe('idle')
    expect(service.launchOverrides('c1')).toBeNull()
    await service.unlink('c1')
    expect(service.get('c1')).toMatchObject({ linked: false, codexThreadId: null })
  })

  it('never resumes by itself after Aether restarts', () => {
    const stored = { ...harness().service.get('c1'), linked: true, status: 'working' as const, config: CONFIG, rounds: [round({ finishedAt: null })] }
    const { service } = harness({ stored: [stored] })
    expect(service.get('c1')).toMatchObject({ status: 'paused', resumeStep: 'plan' })
    expect(service.get('c1').rounds[0]?.claudeError).toMatch(/fermé/)
  })
})
