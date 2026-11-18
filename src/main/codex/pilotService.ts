/**
 * The Codex pilot loop, one per conversation:
 *   GPT decides (codex exec, read-only) → Claude works (normal Aether conversation, its permissions)
 *   → Aether runs the checks → GPT judges → commit + push when validated → next task.
 * It never retries a failure by itself: any error, refusal or doubt pauses it for the user.
 * Only a Claude usage limit is waited out, and only on the quota manager's real data.
 */
import type { PermissionModeOption } from '../../shared/domain'
import type { EngineEvent } from '../../shared/engineProtocol'
import {
  ALL_COMMAND_TOOLS,
  buildCodexPrompt,
  defaultBranchChoice,
  isProtectedBranch,
  detectStagnation,
  emptyPilot,
  formatClaudeInstruction,
  isCodexUsageLimit,
  isPilotActive,
  MAX_KEPT_EVENTS,
  MAX_KEPT_ROUNDS,
  parseClaudeReport,
  parseCodexDecision,
  pilotBranchName,
  pilotConfigSchema,
  type CodexStatus,
  type CommitRecord,
  type PilotBranchInfo,
  type PilotConfig,
  type PilotEvent,
  type PilotRound,
  type PilotSnapshot,
  type PilotStep
} from '../../shared/pilot'
import type { ScopedLogger } from '../services/logger'
import type { RunningChecks } from './checkRunner'
import type { CodexCarriedSettings, CodexLaunch, CodexTurnRequest, RunningCodexTurn } from './codexCli'
import type { PilotGit } from './pilotGit'

export interface PilotStorage {
  loadAll(): PilotSnapshot[]
  save(snapshot: PilotSnapshot): void
}

export interface PilotServiceDependencies {
  now: () => number
  newId: () => string
  storage: PilotStorage
  findConversation: (conversationId: string) => { id: string; title: string; workingDirectory: string } | null
  chat: {
    send: (conversationId: string, text: string, clientMessageId: string) => Promise<{ accepted: boolean; reason?: string }>
    interrupt: (conversationId: string) => Promise<void>
    closeRunner: (conversationId: string) => Promise<void>
  }
  isClaudeBusy: (conversationId: string) => boolean
  canSendToClaude: () => { allowed: boolean; reason?: string }
  codex: {
    status: () => Promise<CodexStatus>
    launch: () => Promise<CodexLaunch | null>
    settings: () => CodexCarriedSettings
    startTurn: (request: CodexTurnRequest) => RunningCodexTurn
  }
  git: PilotGit
  runChecks: (commands: string[], workingDirectory: string) => RunningChecks
  /** JSON schema file for `--output-schema`. */
  schemaPath: string
  /** Empty folder Codex works in when it must not read the project. */
  isolatedDirectory: string
  publish: (snapshot: PilotSnapshot) => void
  notify: (title: string, body: string) => void
  log: ScopedLogger
  codexTimeoutMs?: number
}

export const CODEX_TURN_TIMEOUT_MS = 30 * 60_000

export interface PilotLaunchOverrides {
  permissionMode?: PermissionModeOption
  allowedTools?: string[]
}

export class PilotService {
  private readonly snapshots = new Map<string, PilotSnapshot>()
  /** Bumped by stop / unlink / start: results of older steps are dropped. */
  private readonly generations = new Map<string, number>()
  private readonly cancellers = new Map<string, () => void>()
  private readonly pauseRequests = new Set<string>()
  /** A stagnation warning to give GPT on the next decision, once the user resumed. */
  private readonly warnings = new Map<string, string>()

  constructor(private readonly dependencies: PilotServiceDependencies) {
    for (const stored of dependencies.storage.loadAll()) {
      const snapshot = { ...emptyPilot(stored.conversationId, dependencies.now()), ...stored }
      if (isPilotActive(snapshot.status)) {
        // Aether was closed mid-run: never continue by itself on start-up.
        const resumeStep: PilotStep = snapshot.status === 'waiting_quota' ? 'send' : 'plan'
        const working = snapshot.rounds.at(-1)
        if (working && working.finishedAt === null) {
          working.finishedAt = dependencies.now()
          working.claudeError = working.claudeError ?? 'Aether a été fermé pendant cette tâche.'
        }
        Object.assign(snapshot, { status: 'paused', resumeStep, statusMessage: 'Aether a été fermé pendant le pilotage. Reprenez quand vous voulez.' })
      }
      this.snapshots.set(snapshot.conversationId, snapshot)
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get(conversationId: string): PilotSnapshot {
    return this.snapshots.get(conversationId) ?? emptyPilot(conversationId, this.dependencies.now())
  }

  list(): PilotSnapshot[] {
    return [...this.snapshots.values()].filter((snapshot) => snapshot.linked)
  }

  /** Branches the start form offers for this conversation's folder. */
  async branches(conversationId: string): Promise<PilotBranchInfo> {
    const conversation = this.dependencies.findConversation(conversationId)
    if (!conversation) throw new Error('Conversation introuvable.')
    const { git } = this.dependencies
    const directory = conversation.workingDirectory
    if (!(await git.isRepository(directory))) return { isRepository: false, current: null, defaultBranch: null, branches: [], clean: true, worktrees: {} }
    const [current, defaultBranch, branches, clean, worktrees] = await Promise.all([git.currentBranch(directory), git.defaultBranch(directory), git.listBranches(directory), git.isClean(directory).catch(() => false), this.otherWorktrees(directory)])
    return { isRepository: true, current, defaultBranch, branches, clean, worktrees }
  }

  /** Branches checked out in a worktree other than the one holding `directory`. */
  private async otherWorktrees(directory: string): Promise<Record<string, string>> {
    const { git } = this.dependencies
    const [all, top] = await Promise.all([git.listWorktrees(directory), git.topLevel(directory)])
    const same = (left: string, right: string | null): boolean => right !== null && left.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === right.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    return Object.fromEntries(Object.entries(all).filter(([, path]) => !same(path, top)))
  }

  codexStatus(): Promise<CodexStatus> {
    return this.dependencies.codex.status()
  }

  /** Pre-authorisations the user chose for this pilot, applied when Claude's session (re)starts. */
  launchOverrides(conversationId: string): PilotLaunchOverrides | null {
    const snapshot = this.snapshots.get(conversationId)
    if (!snapshot?.linked || !snapshot.config || !this.sessionOpen(snapshot)) return null
    const overrides: PilotLaunchOverrides = {}
    const allCommands = snapshot.config.allowAllCommands === true
    // "Tout autoriser": Claude Code's bypassPermissions mode, as with `claude --dangerously-skip-permissions`.
    if (allCommands) overrides.permissionMode = 'bypassPermissions'
    else if (snapshot.config.allowFileEdits) overrides.permissionMode = 'acceptEdits'
    const tools = [...snapshot.config.allowedTools, ...(allCommands ? ALL_COMMAND_TOOLS : [])]
    if (tools.length > 0) overrides.allowedTools = [...new Set(tools)]
    return overrides.permissionMode || overrides.allowedTools ? overrides : null
  }

  private sessionOpen(snapshot: PilotSnapshot): boolean {
    return snapshot.status !== 'idle' && snapshot.status !== 'done'
  }

  // -------------------------------------------------------------------------
  // Link / detach
  // -------------------------------------------------------------------------

  async link(conversationId: string): Promise<PilotSnapshot> {
    if (!this.dependencies.findConversation(conversationId)) throw new Error('Conversation introuvable.')
    const status = await this.dependencies.codex.status()
    if (!status.found) throw new Error('Codex CLI est introuvable. Installez-le (npm i -g @openai/codex) ou installez l’application Codex, puis réessayez.')
    if (!status.loggedIn) throw new Error('Codex n’est pas connecté. Lancez « codex login » dans un terminal et choisissez « Sign in with ChatGPT », puis réessayez.')
    const snapshot = this.get(conversationId)
    if (snapshot.linked) return snapshot
    return this.commit({ ...snapshot, linked: true, status: snapshot.status === 'done' ? 'idle' : snapshot.status }, 'info', `Codex lié (${status.version ?? 'version inconnue'}, ${status.loginDetail ?? 'connecté'}).`)
  }

  async unlink(conversationId: string): Promise<PilotSnapshot> {
    const snapshot = this.get(conversationId)
    if (!snapshot.linked) return snapshot
    if (isPilotActive(snapshot.status) || snapshot.status === 'paused') await this.stop(conversationId)
    const current = this.get(conversationId)
    // The GPT thread is forgotten; the journal of past tasks is kept for reference.
    return this.commit({ ...current, linked: false, status: 'idle', codexThreadId: null, question: null, pendingInstruction: null, resumeStep: null, statusMessage: null }, 'info', 'Codex détaché de la conversation.')
  }

  // -------------------------------------------------------------------------
  // Start / pause / resume / answer / stop
  // -------------------------------------------------------------------------

  async start(conversationId: string, rawConfig: PilotConfig): Promise<PilotSnapshot> {
    const parsed = pilotConfigSchema.safeParse(rawConfig)
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(' '))
    const config: PilotConfig = { ...parsed.data, checks: parsed.data.checks.filter(Boolean), allowedTools: [...new Set(parsed.data.allowedTools)] }
    const snapshot = this.get(conversationId)
    if (!snapshot.linked) throw new Error('Liez d’abord Codex à cette conversation.')
    if (isPilotActive(snapshot.status)) throw new Error('Le pilote tourne déjà dans cette conversation.')
    const conversation = this.dependencies.findConversation(conversationId)
    if (!conversation) throw new Error('Conversation introuvable.')
    if (this.dependencies.isClaudeBusy(conversationId)) throw new Error('Claude est en train de répondre dans cette conversation : attendez la fin ou arrêtez-le.')
    const { git } = this.dependencies
    const directory = conversation.workingDirectory
    const isRepository = await git.isRepository(directory)
    let branch: string | null = null
    let baseBranch: string | null = null
    let remoteUrl: string | null = null
    const choice = defaultBranchChoice(config)
    let workDirectory: string | null = null
    if (!isRepository && (config.autoCommit || choice.mode !== 'current')) throw new Error(config.autoCommit ? 'Les commits automatiques demandent un dépôt git : ce dossier n’en est pas un.' : 'Ce dossier n’est pas un dépôt git : impossible de choisir une branche.')
    if (isRepository && choice.mode === 'existing') {
      const elsewhere = (await this.otherWorktrees(directory))[choice.name]
      if (elsewhere) workDirectory = elsewhere
    }
    const gitDirectory = workDirectory ?? directory
    if (isRepository) {
      if (config.autoCommit && !(await git.isClean(gitDirectory))) throw new Error('Le dossier contient des modifications non commitées. Commitez-les ou mettez-les de côté avant de lancer le pilote avec commits automatiques, pour qu’elles ne partent pas dans ses commits.')
      baseBranch = await git.currentBranch(gitDirectory)
      const target = choice.mode === 'new' ? pilotBranchName(config.objective, new Date(this.dependencies.now())) : choice.mode === 'current' ? baseBranch : choice.name
      if (!target) throw new Error('HEAD est détaché : choisissez une branche pour le pilote.')
      if (config.autoCommit && !config.allowProtectedBranch && isProtectedBranch(target, await git.defaultBranch(gitDirectory))) throw new Error(`« ${target} » est une branche principale : cochez l’autorisation de commiter dessus, ou choisissez une autre branche.`)
      if (choice.mode === 'create' || choice.mode === 'new') {
        if ((await git.listBranches(directory)).includes(target)) throw new Error(`La branche « ${target} » existe déjà : choisissez-la dans la liste.`)
        await git.createBranch(directory, target)
      } else if (target !== baseBranch) {
        await git.switchBranch(gitDirectory, target)
      }
      branch = target
      if (config.autoCommit) remoteUrl = await git.remoteUrl(gitDirectory)
    }
    const baselineFingerprint = isRepository ? await git.fingerprint(gitDirectory) : null
    this.bumpGeneration(conversationId)
    this.pauseRequests.delete(conversationId)
    this.warnings.delete(conversationId)
    const now = this.dependencies.now()
    const started = this.commit(
      {
        ...emptyPilot(conversationId, now),
        linked: true,
        status: 'thinking',
        config,
        branch,
        baseBranch,
        workDirectory,
        remoteUrl,
        baselineFingerprint,
        startedAt: now,
        events: snapshot.events
      },
      'info',
      workDirectory ? `Pilote lancé sur la branche ${branch ?? ''}, dans son worktree ${workDirectory}${config.autoCommit && remoteUrl ? ` (push vers ${remoteUrl})` : ''}.` : !branch ? 'Pilote lancé.' : !config.autoCommit ? `Pilote lancé sur la branche ${branch} (sans commit automatique).` : `Pilote lancé sur la branche ${branch}${remoteUrl ? ` (push vers ${remoteUrl})` : ' (pas de remote origin : commits locaux seulement)'}.`
    )
    // Claude's session restarts with the pilot's pre-authorisations (same Claude Code session, context kept).
    await this.dependencies.chat.closeRunner(conversationId)
    void this.plan(conversationId)
    return started
  }

  pause(conversationId: string): PilotSnapshot {
    const snapshot = this.get(conversationId)
    if (snapshot.status === 'waiting_quota') return this.commit({ ...snapshot, status: 'paused', statusMessage: 'Mis en pause à votre demande.' }, 'info', 'Pause demandée.')
    if (!isPilotActive(snapshot.status)) return snapshot
    this.pauseRequests.add(conversationId)
    return this.commit({ ...snapshot, statusMessage: 'Pause demandée : l’étape en cours se termine, puis le pilote s’arrête.' }, 'info', 'Pause demandée : fin de l’étape en cours.')
  }

  resume(conversationId: string): PilotSnapshot {
    const snapshot = this.get(conversationId)
    if (!snapshot.linked || !snapshot.config) throw new Error('Aucun pilotage à reprendre.')
    if (snapshot.status !== 'paused' && snapshot.status !== 'waiting_quota') return snapshot
    if (snapshot.question && snapshot.pendingAnswers.length === 0) throw new Error('GPT attend votre réponse à sa question.')
    this.pauseRequests.delete(conversationId)
    const step = snapshot.resumeStep ?? 'plan'
    if (step === 'send' && !snapshot.pendingInstruction) return this.resumeWith(conversationId, 'plan')
    return this.resumeWith(conversationId, step)
  }

  answer(conversationId: string, text: string): PilotSnapshot {
    const answer = text.trim()
    if (!answer) throw new Error('Réponse vide.')
    const snapshot = this.get(conversationId)
    if (!snapshot.linked || !snapshot.config) throw new Error('Aucun pilotage en cours.')
    const updated = this.commit({ ...snapshot, question: null, pendingAnswers: [...snapshot.pendingAnswers, answer.slice(0, 8000)] }, 'info', 'Votre réponse est transmise à GPT.')
    if (updated.status === 'paused') return this.resumeWith(conversationId, 'plan')
    return updated
  }

  async stop(conversationId: string): Promise<PilotSnapshot> {
    const snapshot = this.get(conversationId)
    this.bumpGeneration(conversationId)
    this.pauseRequests.delete(conversationId)
    this.cancellers.get(conversationId)?.()
    this.cancellers.delete(conversationId)
    if (snapshot.status === 'working') await this.dependencies.chat.interrupt(conversationId).catch(() => undefined)
    const rounds = snapshot.rounds.map((round) => (round.finishedAt === null ? { ...round, finishedAt: this.dependencies.now(), claudeError: round.claudeError ?? 'Arrêté par l’utilisateur.' } : round))
    const stopped = this.commit({ ...snapshot, rounds, status: 'idle', statusMessage: 'Pilote arrêté.', question: null, pendingInstruction: null, resumeStep: null }, 'warning', 'Pilote arrêté à votre demande.')
    await this.dropPreAuthorisations(conversationId)
    return stopped
  }

  /** Aether is quitting: ends Codex and the checks; the journal says "paused" on next start. */
  dispose(): void {
    for (const conversationId of this.cancellers.keys()) this.bumpGeneration(conversationId)
    for (const cancel of this.cancellers.values()) cancel()
    this.cancellers.clear()
  }

  /** Quota state changed: a pilot waiting for the Claude limit resumes once sending is allowed again. */
  onQuotaChange(): void {
    if (!this.dependencies.canSendToClaude().allowed) return
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.status === 'waiting_quota' && snapshot.linked) {
        this.addEvent(snapshot, 'info', 'Limite Claude réinitialisée : le pilote reprend.')
        this.resumeWith(snapshot.conversationId, snapshot.resumeStep ?? 'send')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Engine events (Claude's side)
  // -------------------------------------------------------------------------

  handleEngineEvent(event: EngineEvent): void {
    if (!('conversationId' in event)) return
    const snapshot = this.snapshots.get(event.conversationId)
    if (!snapshot || snapshot.status !== 'working') return
    const round = snapshot.rounds.at(-1)
    if (!round || round.finishedAt !== null) return
    if (event.type === 'turn_result') {
      const { result } = event
      const usage = { ...snapshot.usage, claudeTurns: snapshot.usage.claudeTurns + 1, claudeInputTokens: snapshot.usage.claudeInputTokens + result.inputTokens + result.cacheReadInputTokens + result.cacheCreationInputTokens, claudeOutputTokens: snapshot.usage.claudeOutputTokens + result.outputTokens }
      const finished: PilotRound = { ...round, finishedAt: this.dependencies.now(), report: parseClaudeReport(result.resultText) }
      if (result.isError) {
        const reason = (result.errors.join(' ').trim() || result.resultText?.trim() || result.subtype).slice(0, 2000)
        finished.claudeError = reason
        const next = { ...snapshot, usage, rounds: replaceLast(snapshot.rounds, finished) }
        if (!this.dependencies.canSendToClaude().allowed) {
          // Usage limit: the same instruction is sent again once the quota manager sees the reset.
          this.commit({ ...next, status: 'waiting_quota', resumeStep: 'send', pendingInstruction: round.instruction, statusMessage: this.dependencies.canSendToClaude().reason ?? 'Limite Claude atteinte.' }, 'warning', 'Limite d’usage Claude atteinte : le pilote attend la réinitialisation.')
          return
        }
        // A stopped turn (the user's "Arrêter", or a message sent to interrupt) is not a crash of Claude.
        this.pauseWith(next, result.interrupted ? 'Le tour de Claude a été interrompu : le pilote est en pause.' : `Claude s’est arrêté sur une erreur : ${reason}`, 'plan')
        return
      }
      this.commit({ ...snapshot, usage, rounds: replaceLast(snapshot.rounds, finished), status: 'checking', statusMessage: null }, 'info', `Claude a rendu la tâche ${round.index} (${finished.report?.status === 'done' ? 'terminée' : finished.report?.status === 'blocked' ? 'bloquée' : 'partielle'}).`)
      void this.check(event.conversationId)
      return
    }
    if (event.type === 'runner_state' && (event.state === 'error' || event.state === 'closed')) {
      const finished: PilotRound = { ...round, finishedAt: this.dependencies.now(), claudeError: event.message ?? 'La session Claude s’est fermée.' }
      this.pauseWith({ ...snapshot, rounds: replaceLast(snapshot.rounds, finished) }, `La session Claude s’est arrêtée${event.message ? ` : ${event.message}` : '.'}`, 'plan')
    }
  }

  // -------------------------------------------------------------------------
  // The loop's steps
  // -------------------------------------------------------------------------

  private resumeWith(conversationId: string, step: PilotStep): PilotSnapshot {
    const snapshot = this.get(conversationId)
    const resumed = this.commit({ ...snapshot, status: step === 'plan' ? 'thinking' : 'working', statusMessage: null, resumeStep: null }, 'info', 'Pilote repris.')
    if (step === 'plan') void this.plan(conversationId)
    else void this.send(conversationId)
    return resumed
  }

  /** GPT decides. */
  private async plan(conversationId: string, retriedFresh = false): Promise<void> {
    const generation = this.generation(conversationId)
    const snapshot = this.get(conversationId)
    const config = snapshot.config
    const conversation = this.dependencies.findConversation(conversationId)
    if (!config || !conversation) return
    if (this.takePauseRequest(snapshot, 'plan')) return
    const warning = this.warnings.get(conversationId) ?? null
    if (!warning) {
      const stagnation = detectStagnation(snapshot.rounds, snapshot.baselineFingerprint)
      if (stagnation) {
        this.warnings.set(conversationId, `Aether a détecté un enlisement : ${stagnation} L’utilisateur a choisi de continuer ; change d’approche ou pose-lui une question.`)
        this.pauseWith(snapshot, `Le pilote semble tourner en rond : ${stagnation} Reprenez pour que GPT change d’approche, ou arrêtez.`, 'plan')
        this.dependencies.notify('Pilote Codex en pause', `${conversation.title} : ${stagnation}`)
        return
      }
    }
    this.commit({ ...snapshot, status: 'thinking', statusMessage: null }, null, null)
    const launch = await this.dependencies.codex.launch()
    if (!this.isCurrent(conversationId, generation)) return
    if (!launch) {
      this.pauseWith(this.get(conversationId), 'Codex est introuvable : réinstallez-le, puis reprenez.', 'plan')
      return
    }
    const readsProject = config.codexReadsProject
    const workingDirectory = readsProject ? (snapshot.workDirectory ?? conversation.workingDirectory) : this.dependencies.isolatedDirectory
    const skipGitCheck = readsProject ? !(await this.dependencies.git.isRepository(workingDirectory)) : true
    const prompt = buildCodexPrompt({ config, rounds: snapshot.rounds, answers: snapshot.pendingAnswers, freshThread: snapshot.codexThreadId === null, stagnationWarning: warning })
    const turn = this.dependencies.codex.startTurn({
      launch,
      workingDirectory,
      prompt,
      threadId: snapshot.codexThreadId,
      schemaPath: this.dependencies.schemaPath,
      settings: this.dependencies.codex.settings(),
      timeoutMs: this.dependencies.codexTimeoutMs ?? CODEX_TURN_TIMEOUT_MS,
      skipGitCheck
    })
    this.cancellers.set(conversationId, turn.cancel)
    const result = await turn.done
    this.cancellers.delete(conversationId)
    if (!this.isCurrent(conversationId, generation)) return
    const current = this.get(conversationId)
    const usage = { ...current.usage, codexTurns: current.usage.codexTurns + 1, codexInputTokens: current.usage.codexInputTokens + result.inputTokens, codexOutputTokens: current.usage.codexOutputTokens + result.outputTokens }
    const withUsage: PilotSnapshot = { ...current, usage, codexThreadId: result.threadId ?? current.codexThreadId }
    if (result.error) {
      if (current.codexThreadId && !retriedFresh && /no (such )?(session|thread|conversation)|not found|introuvable/i.test(result.error)) {
        // GPT's thread is gone: one new thread, given the whole journal.
        this.commit({ ...withUsage, codexThreadId: null }, 'warning', 'Le fil de GPT est introuvable : nouveau fil avec le journal complet.')
        await this.plan(conversationId, true)
        return
      }
      if (isCodexUsageLimit(result.error)) {
        this.pauseWith(withUsage, `Limite d’usage ChatGPT atteinte (${result.error}). Reprenez quand elle est réinitialisée.`, 'plan')
        this.dependencies.notify('Pilote Codex en pause', 'Limite d’usage ChatGPT atteinte.')
        return
      }
      this.pauseWith(withUsage, `Codex a échoué : ${result.error}`, 'plan')
      return
    }
    const decision = parseCodexDecision(result.finalMessage)
    if (!decision) {
      this.pauseWith(withUsage, 'La réponse de GPT n’est pas au format attendu. Reprenez pour lui redemander.', 'plan')
      return
    }
    this.warnings.delete(conversationId)
    let decided: PilotSnapshot = { ...withUsage, lastDecision: decision, pendingAnswers: [] }
    decided = await this.commitAcceptedTask(decided, decision.previousTaskAccepted, decision.commitMessage, decided.workDirectory ?? conversation.workingDirectory, generation)
    if (!this.isCurrent(conversationId, generation)) return
    if (decided.status === 'paused') {
      // Commit blocked (secret, wrong branch, push refused): resume carries on with GPT's instruction.
      this.commit(decision.action === 'continue' ? { ...decided, resumeStep: 'send', pendingInstruction: decision.message } : decided, null, null)
      return
    }
    if (decision.action === 'done') {
      this.commit({ ...decided, status: 'done', statusMessage: decision.message || 'Objectif atteint.', pendingInstruction: null, resumeStep: null }, 'success', 'GPT juge l’objectif atteint.')
      this.dependencies.notify('Pilote Codex terminé', `${conversation.title} : ${(decision.message || 'objectif atteint').slice(0, 200)}`)
      await this.dropPreAuthorisations(conversationId)
      return
    }
    if (decision.action === 'ask_user') {
      this.commit({ ...decided, status: 'paused', question: decision.message, statusMessage: 'GPT vous pose une question.', resumeStep: 'plan', pendingInstruction: null }, 'warning', 'GPT attend votre réponse.')
      this.dependencies.notify('Pilote Codex : question', `${conversation.title} : ${decision.message.slice(0, 200)}`)
      return
    }
    this.commit({ ...decided, pendingInstruction: decision.message }, null, null)
    await this.send(conversationId)
  }

  /** Claude works on GPT's instruction. */
  private async send(conversationId: string): Promise<void> {
    const generation = this.generation(conversationId)
    const snapshot = this.get(conversationId)
    const config = snapshot.config
    const instruction = snapshot.pendingInstruction
    if (!config || !instruction) return
    if (this.takePauseRequest(snapshot, 'send')) return
    const quota = this.dependencies.canSendToClaude()
    if (!quota.allowed) {
      this.commit({ ...snapshot, status: 'waiting_quota', resumeStep: 'send', statusMessage: quota.reason ?? 'Limite Claude atteinte.' }, 'warning', 'Limite d’usage Claude atteinte : le pilote attend la réinitialisation.')
      return
    }
    if (this.dependencies.isClaudeBusy(conversationId)) {
      this.pauseWith(snapshot, 'Claude est déjà occupé dans cette conversation : reprenez quand il a fini.', 'send')
      return
    }
    const index = (snapshot.rounds.at(-1)?.index ?? 0) + 1
    const round: PilotRound = { index, instruction, startedAt: this.dependencies.now(), finishedAt: null, report: null, checks: [], fingerprint: null, claudeError: null, commit: null }
    this.commit({ ...snapshot, status: 'working', pendingInstruction: null, resumeStep: null, statusMessage: null, rounds: [...snapshot.rounds, round].slice(-MAX_KEPT_ROUNDS) }, 'info', `Tâche ${index} confiée à Claude.`)
    let outcome: { accepted: boolean; reason?: string }
    try {
      outcome = await this.dependencies.chat.send(conversationId, formatClaudeInstruction(instruction, index, config.autoCommit, snapshot.workDirectory ?? null), this.dependencies.newId())
    } catch (error) {
      outcome = { accepted: false, reason: error instanceof Error ? error.message : String(error) }
    }
    if (!this.isCurrent(conversationId, generation) || outcome.accepted) return
    // Not sent: the round did not happen.
    const current = this.get(conversationId)
    const rounds = current.rounds.filter((candidate) => candidate.index !== index)
    const quotaAfter = this.dependencies.canSendToClaude()
    if (!quotaAfter.allowed) {
      this.commit({ ...current, rounds, status: 'waiting_quota', resumeStep: 'send', pendingInstruction: instruction, statusMessage: quotaAfter.reason ?? 'Limite Claude atteinte.' }, 'warning', 'Limite d’usage Claude atteinte : le pilote attend la réinitialisation.')
      return
    }
    this.pauseWith({ ...current, rounds, pendingInstruction: instruction }, `L’instruction n’a pas pu être envoyée à Claude : ${outcome.reason ?? 'raison inconnue'}`, 'send')
  }

  /** Aether runs the checks itself, then GPT judges. */
  private async check(conversationId: string): Promise<void> {
    const generation = this.generation(conversationId)
    const snapshot = this.get(conversationId)
    const conversation = this.dependencies.findConversation(conversationId)
    const round = snapshot.rounds.at(-1)
    if (!snapshot.config || !conversation || !round) return
    const projectDirectory = snapshot.workDirectory ?? conversation.workingDirectory
    const running = this.dependencies.runChecks(snapshot.config.checks, projectDirectory)
    this.cancellers.set(conversationId, running.cancel)
    const checks = await running.done
    this.cancellers.delete(conversationId)
    if (!this.isCurrent(conversationId, generation)) return
    const fingerprint = (await this.dependencies.git.isRepository(projectDirectory)) ? await this.dependencies.git.fingerprint(projectDirectory) : null
    if (!this.isCurrent(conversationId, generation)) return
    const current = this.get(conversationId)
    const failed = checks.filter((check) => !check.passed).length
    const checked = this.commit(
      { ...current, rounds: replaceLast(current.rounds, { ...round, checks, fingerprint }), status: 'thinking' },
      checks.length === 0 ? null : failed === 0 ? 'success' : 'warning',
      checks.length === 0 ? null : failed === 0 ? `Vérifications vertes (${checks.length}).` : `${failed} vérification(s) en échec sur ${checks.length}.`
    )
    if (this.takePauseRequest(checked, 'plan')) return
    await this.plan(conversationId)
  }

  /**
   * Commits (then pushes) the task just judged when all three agree: Claude reported it finished,
   * every check Aether ran passed, and GPT accepted it.
   */
  private async commitAcceptedTask(snapshot: PilotSnapshot, accepted: boolean, message: string, directory: string, generation: number): Promise<PilotSnapshot> {
    const round = snapshot.rounds.at(-1)
    const config = snapshot.config
    if (!round || !config?.autoCommit || !snapshot.branch || round.commit) return snapshot
    const checksPassed = round.checks.every((check) => check.passed)
    const claudeDone = round.report?.status === 'done' && !round.claudeError
    const record = (commit: CommitRecord): PilotSnapshot => ({ ...snapshot, rounds: replaceLast(snapshot.rounds, { ...round, commit }) })
    if (!accepted || !checksPassed || !claudeDone) {
      const why = [!claudeDone ? 'Claude ne l’a pas déclarée terminée' : null, !checksPassed ? 'des vérifications échouent' : null, !accepted ? 'GPT ne l’a pas acceptée' : null].filter(Boolean).join(', ')
      return record({ sha: null, message: '', branch: snapshot.branch, pushed: false, remoteUrl: snapshot.remoteUrl, note: `Pas de commit : ${why}.` })
    }
    const commitMessage = (message || `Pilote Aether : tâche ${round.index}`).replace(/\r/g, '').slice(0, 2000)
    this.commit({ ...snapshot, status: 'committing' }, null, null)
    const { git } = this.dependencies
    try {
      const outcome = await git.commitAll(directory, snapshot.branch, commitMessage, config.allowProtectedBranch === true)
      if (!this.isCurrent(snapshot.conversationId, generation)) return snapshot
      if (outcome.secrets.length > 0) {
        const list = outcome.secrets.map((finding) => `${finding.label}${finding.file ? ` (${finding.file})` : ''}`).join(', ')
        const blocked = record({ sha: null, message: commitMessage, branch: snapshot.branch, pushed: false, remoteUrl: snapshot.remoteUrl, note: `Bloqué : secret possible — ${list}.` })
        this.dependencies.notify('Pilote Codex : commit bloqué', `Secret possible détecté : ${list}`)
        return this.pauseWith(blocked, `Commit et push bloqués : secret possible détecté (${list}). Rien n’a été commité ; les fichiers sont intacts. Retirez le secret puis reprenez.`, 'plan', false)
      }
      if (outcome.nothingToCommit) return record({ sha: null, message: commitMessage, branch: snapshot.branch, pushed: false, remoteUrl: snapshot.remoteUrl, note: 'Rien à commiter.' })
      let pushed = false
      let note: string | null = null
      if (snapshot.remoteUrl) {
        try {
          await git.push(directory, snapshot.branch, config.allowProtectedBranch === true)
          pushed = true
        } catch (error) {
          note = `push refusé : ${error instanceof Error ? error.message : String(error)}`
        }
      } else {
        note = 'pas de remote origin : commit local'
      }
      if (!this.isCurrent(snapshot.conversationId, generation)) return snapshot
      const committed = record({ sha: outcome.sha, message: commitMessage, branch: snapshot.branch, pushed, remoteUrl: snapshot.remoteUrl, note })
      this.addEvent(committed, 'success', `Commit ${outcome.sha?.slice(0, 10) ?? ''}${pushed ? ' poussé' : ''} sur ${snapshot.branch}.`)
      if (note?.startsWith('push refusé')) {
        // Never retried in a loop: the user looks at it.
        return this.pauseWith(committed, `Le commit est fait mais le ${note}. Corrigez (accès, réseau…) puis reprenez : le prochain commit poussera tout.`, 'plan', false)
      }
      return committed
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const failed = record({ sha: null, message: commitMessage, branch: snapshot.branch, pushed: false, remoteUrl: snapshot.remoteUrl, note: `Échec du commit : ${reason}` })
      return this.pauseWith(failed, `Le commit a échoué : ${reason}`, 'plan', false)
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private takePauseRequest(snapshot: PilotSnapshot, step: PilotStep): boolean {
    if (!this.pauseRequests.delete(snapshot.conversationId)) return false
    this.pauseWith(snapshot, 'Mis en pause à votre demande.', step)
    return true
  }

  private pauseWith(snapshot: PilotSnapshot, message: string, step: PilotStep, publish = true): PilotSnapshot {
    const paused: PilotSnapshot = { ...snapshot, status: 'paused', statusMessage: message, resumeStep: step }
    if (!publish) {
      this.addEvent(paused, 'warning', message)
      return paused
    }
    return this.commit(paused, 'warning', message)
  }

  private async dropPreAuthorisations(conversationId: string): Promise<void> {
    // The next manual message restarts Claude's session (same context) without the pilot's allow rules.
    if (!this.dependencies.isClaudeBusy(conversationId)) await this.dependencies.chat.closeRunner(conversationId).catch(() => undefined)
  }

  private generation(conversationId: string): number {
    return this.generations.get(conversationId) ?? 0
  }

  private bumpGeneration(conversationId: string): void {
    this.generations.set(conversationId, this.generation(conversationId) + 1)
  }

  private isCurrent(conversationId: string, generation: number): boolean {
    return this.generation(conversationId) === generation
  }

  private addEvent(snapshot: PilotSnapshot, tone: PilotEvent['tone'], text: string): void {
    snapshot.events = [...snapshot.events, { at: this.dependencies.now(), tone, text: text.slice(0, 2000) }].slice(-MAX_KEPT_EVENTS)
  }

  /** Stores, persists and publishes a new snapshot (with an optional journal line). */
  private commit(snapshot: PilotSnapshot, tone: PilotEvent['tone'] | null, text: string | null): PilotSnapshot {
    const next: PilotSnapshot = { ...snapshot, updatedAt: this.dependencies.now() }
    if (tone && text) this.addEvent(next, tone, text)
    this.snapshots.set(next.conversationId, next)
    try {
      this.dependencies.storage.save(next)
    } catch (error) {
      this.dependencies.log.warn('Sauvegarde du pilote échouée', error)
    }
    this.dependencies.publish(next)
    return next
  }
}

function replaceLast<Item>(items: Item[], replacement: Item): Item[] {
  return items.length === 0 ? [replacement] : [...items.slice(0, -1), replacement]
}
