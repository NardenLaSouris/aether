/**
 * Codex pilot: GPT (through the official Codex CLI, signed in with the user's ChatGPT account)
 * decides the next task, Claude carries it out in an Aether conversation and reports back.
 * Pure types and logic only, shared by the main process (which runs the loop) and the renderer.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Configuration chosen by the user when starting a pilot
// ---------------------------------------------------------------------------

export interface PilotConfig {
  /** What the whole session must achieve. */
  objective: string
  /** What "finished" means; GPT may only conclude once it holds. */
  doneCriteria: string
  /** Command lines Aether runs itself after each task (e.g. `pnpm test`). */
  checks: string[]
  /** Claude may edit files of the working folder without asking (Claude Code's acceptEdits mode). */
  allowFileEdits: boolean
  /** Extra Claude Code allow rules for this pilot only, e.g. `Bash(pnpm test:*)`. */
  allowedTools: string[]
  /**
   * Claude may run every shell command without asking (Claude Code allow rules `Bash` and `PowerShell`,
   * plus file edits). Opt-in, off by default; the user's own deny rules still apply.
   */
  allowAllCommands?: boolean
  /** Branch the pilot works on. Missing: a new `aether/pilote-…` branch with auto-commits, the current one otherwise. */
  branch?: PilotBranchChoice
  /** The user accepted auto-commits and pushes on a main branch (main, master, develop, trunk, origin's default). */
  allowProtectedBranch?: boolean
  /** Commit then push the pilot branch once a task is validated. */
  autoCommit: boolean
  /** GPT may read the project (read-only sandbox) to check Claude's reports. */
  codexReadsProject: boolean
}

export type PilotBranchChoice =
  | { mode: 'current' }
  | { mode: 'new' }
  | { mode: 'existing'; name: string }
  | { mode: 'create'; name: string }

/** What the start form shows to pick a branch. */
export interface PilotBranchInfo {
  isRepository: boolean
  current: string | null
  defaultBranch: string | null
  /** Local branches and origin's, without duplicates. */
  branches: string[]
  /** Branches already checked out in another worktree of the repository → that worktree's folder. */
  worktrees: Record<string, string>
  clean: boolean
}

/** Why a branch name cannot be used, or null. Stricter than git, never ambiguous with an option. */
export function branchNameProblem(name: string): string | null {
  const value = name.trim()
  if (!value) return 'Donnez un nom de branche.'
  if (value.length > 200) return 'Nom de branche trop long.'
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return 'Nom de branche : lettres, chiffres, « . », « _ », « - » et « / » seulement.'
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock') || value.includes('..') || value.includes('//') || value === 'HEAD') return `« ${value} » n’est pas un nom de branche git valide.`
  return null
}

export function defaultBranchChoice(config: Pick<PilotConfig, 'branch' | 'autoCommit'>): PilotBranchChoice {
  return config.branch ?? (config.autoCommit ? { mode: 'new' } : { mode: 'current' })
}

export const MAX_CHECKS = 8
export const MAX_ALLOWED_TOOLS = 20

/**
 * Allow rules accepted for a pilot. A bare tool name (`Bash`, `Write`…) would allow every use of it,
 * so only rules with a specifier are accepted for the tools that run commands or write.
 */
const RULE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\((?<specifier>[^()\r\n]{1,300})\))?$/
const TOOLS_NEEDING_SPECIFIER = new Set(['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch'])
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch'])

export function allowRuleProblem(rule: string): string | null {
  const match = RULE_PATTERN.exec(rule.trim())
  if (!match) return `Règle illisible : « ${rule} ». Format attendu : Outil(motif), par exemple Bash(pnpm test:*).`
  const tool = rule.trim().split('(')[0] ?? ''
  const specifier = match.groups?.specifier
  if (!specifier && TOOLS_NEEDING_SPECIFIER.has(tool)) return `« ${tool} » seul autoriserait tout : précisez un motif, par exemple ${tool}(pnpm test:*).`
  if (specifier && /^\*+(:\*)?$/.test(specifier.trim())) return `« ${rule} » autoriserait tout : précisez la commande.`
  if (!specifier && !READ_ONLY_TOOLS.has(tool) && !tool.startsWith('mcp__')) return `« ${tool} » seul : précisez un motif.`
  return null
}

export const pilotConfigSchema = z.object({
  objective: z.string().trim().min(5, 'Décrivez l’objectif (5 caractères au moins).').max(8000),
  doneCriteria: z.string().trim().max(4000),
  checks: z.array(z.string().trim().min(1).max(500)).max(MAX_CHECKS),
  allowFileEdits: z.boolean(),
  allowedTools: z
    .array(z.string().trim().min(1).max(320))
    .max(MAX_ALLOWED_TOOLS)
    .superRefine((rules, context) => {
      for (const rule of rules) {
        const problem = allowRuleProblem(rule)
        if (problem) context.addIssue({ code: 'custom', message: problem })
      }
    }),
  allowAllCommands: z.boolean().default(false),
  branch: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('current') }),
      z.object({ mode: z.literal('new') }),
      z.object({ mode: z.literal('existing'), name: z.string().trim() }),
      z.object({ mode: z.literal('create'), name: z.string().trim() })
    ])
    .optional()
    .superRefine((choice, context) => {
      if (choice && (choice.mode === 'existing' || choice.mode === 'create')) {
        const problem = branchNameProblem(choice.name)
        if (problem) context.addIssue({ code: 'custom', message: problem })
      }
    }),
  allowProtectedBranch: z.boolean().default(false),
  autoCommit: z.boolean(),
  codexReadsProject: z.boolean()
})

/** Tools pre-approved for a pilot that may run every command. */
export const ALL_COMMAND_TOOLS = ['Bash', 'PowerShell'] as const

/** Suggested allow rule for a check command: `pnpm test` → `Bash(pnpm test:*)`. */
export function allowRuleForCheck(command: string): string | null {
  const compact = command.trim().replace(/\s+/g, ' ')
  if (!compact || /[|&;<>`$]/.test(compact)) return null
  return `Bash(${compact}:*)`
}

// ---------------------------------------------------------------------------
// Runtime state, pushed to the renderer
// ---------------------------------------------------------------------------

export type PilotStatus =
  /** Codex is linked, no work running. */
  | 'idle'
  /** GPT is deciding (a `codex exec` turn is running). */
  | 'thinking'
  /** Claude is carrying out GPT's instruction. */
  | 'working'
  /** Aether runs the checks. */
  | 'checking'
  /** Aether commits / pushes the validated task. */
  | 'committing'
  /** Waiting for the Claude usage limit to reset (resumes by itself on real quota data). */
  | 'waiting_quota'
  /** Stopped on a problem, a question from GPT or the user's request; resumes on the user's click. */
  | 'paused'
  /** GPT judged the objective reached. */
  | 'done'

export type PilotStep = 'plan' | 'send'

export interface ClaudeReport {
  status: 'done' | 'partial' | 'blocked'
  summary: string
  files: string[]
  tests: string
  blockers: string
  /** false when Claude gave no readable report block (its last answer is used as summary). */
  structured: boolean
}

export interface CheckResult {
  command: string
  exitCode: number | null
  passed: boolean
  durationMs: number
  /** Last part of the output (stdout + stderr). */
  outputTail: string
  timedOut: boolean
}

export interface CommitRecord {
  sha: string | null
  message: string
  branch: string
  pushed: boolean
  remoteUrl: string | null
  /** Why nothing was committed / pushed, when that happened. */
  note: string | null
}

export interface PilotRound {
  index: number
  instruction: string
  startedAt: number
  finishedAt: number | null
  report: ClaudeReport | null
  checks: CheckResult[]
  /** `git status` + diff fingerprint after the task (null outside a git repository). */
  fingerprint: string | null
  claudeError: string | null
  commit: CommitRecord | null
}

export type PilotDecisionAction = 'continue' | 'done' | 'ask_user'

export interface PilotDecision {
  action: PilotDecisionAction
  /** continue: the instruction for Claude; done: the final summary; ask_user: the question. */
  message: string
  /** Whether the task Claude just reported is accepted (meaningless on the first decision). */
  previousTaskAccepted: boolean
  /** Commit message for the accepted task (empty when nothing to commit). */
  commitMessage: string
  /** GPT's short reasoning, shown in the panel. */
  rationale: string
}

export interface PilotUsage {
  codexTurns: number
  codexInputTokens: number
  codexOutputTokens: number
  claudeTurns: number
  claudeInputTokens: number
  claudeOutputTokens: number
}

export const EMPTY_PILOT_USAGE: PilotUsage = { codexTurns: 0, codexInputTokens: 0, codexOutputTokens: 0, claudeTurns: 0, claudeInputTokens: 0, claudeOutputTokens: 0 }

export interface PilotEvent {
  at: number
  tone: 'info' | 'success' | 'warning' | 'error'
  text: string
}

export interface PilotSnapshot {
  conversationId: string
  linked: boolean
  status: PilotStatus
  /** Why the pilot is paused / waiting, or the final summary when done. */
  statusMessage: string | null
  /** Question GPT asked the user (status paused). */
  question: string | null
  config: PilotConfig | null
  rounds: PilotRound[]
  lastDecision: PilotDecision | null
  /** Where a resume starts: ask GPT again, or send its pending instruction to Claude. */
  resumeStep: PilotStep | null
  pendingInstruction: string | null
  /** The user's answers not yet given to GPT. */
  pendingAnswers: string[]
  codexThreadId: string | null
  /** Folder fingerprint when the pilot started (stagnation detection). */
  baselineFingerprint: string | null
  branch: string | null
  /**
   * Folder the pilot works in when it differs from the conversation's: the git worktree where the chosen
   * branch is already checked out. Checks, commits and GPT's reading happen there.
   */
  workDirectory?: string | null
  baseBranch: string | null
  remoteUrl: string | null
  usage: PilotUsage
  events: PilotEvent[]
  startedAt: number | null
  updatedAt: number
}

export const MAX_KEPT_ROUNDS = 200
export const MAX_KEPT_EVENTS = 200

export function emptyPilot(conversationId: string, now: number): PilotSnapshot {
  return {
    conversationId,
    linked: false,
    status: 'idle',
    statusMessage: null,
    question: null,
    config: null,
    rounds: [],
    lastDecision: null,
    resumeStep: null,
    pendingInstruction: null,
    pendingAnswers: [],
    codexThreadId: null,
    baselineFingerprint: null,
    branch: null,
    baseBranch: null,
    remoteUrl: null,
    usage: { ...EMPTY_PILOT_USAGE },
    events: [],
    startedAt: null,
    updatedAt: now
  }
}

export function isPilotActive(status: PilotStatus): boolean {
  return status === 'thinking' || status === 'working' || status === 'checking' || status === 'committing' || status === 'waiting_quota'
}

export interface CodexStatus {
  found: boolean
  executablePath: string | null
  version: string | null
  source: 'environment' | 'path' | 'npm' | 'codex-app' | 'none'
  loggedIn: boolean
  /** e.g. "Logged in using ChatGPT". */
  loginDetail: string | null
  error: string | null
}

// ---------------------------------------------------------------------------
// GPT's decision: the JSON schema given to `codex exec --output-schema`
// ---------------------------------------------------------------------------

/** OpenAI structured outputs: every property required, no extra property. */
export const CODEX_DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message', 'previous_task_accepted', 'commit_message', 'rationale'],
  properties: {
    action: { type: 'string', enum: ['continue', 'done', 'ask_user'] },
    message: { type: 'string' },
    previous_task_accepted: { type: 'boolean' },
    commit_message: { type: 'string' },
    rationale: { type: 'string' }
  }
} as const

const codexDecisionSchema = z.object({
  action: z.enum(['continue', 'done', 'ask_user']),
  message: z.string().max(40_000),
  previous_task_accepted: z.boolean(),
  commit_message: z.string().max(2000),
  rationale: z.string().max(8000)
})

/** Reads GPT's final message. Returns null when it is not the expected JSON. */
export function parseCodexDecision(text: string | null): PilotDecision | null {
  if (!text) return null
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
  const parsed = codexDecisionSchema.safeParse(raw)
  if (!parsed.success) return null
  const decision = parsed.data
  if (decision.action !== 'done' && decision.message.trim().length === 0) return null
  return { action: decision.action, message: decision.message.trim(), previousTaskAccepted: decision.previous_task_accepted, commitMessage: decision.commit_message.trim(), rationale: decision.rationale.trim() }
}

// ---------------------------------------------------------------------------
// Claude's report
// ---------------------------------------------------------------------------

export const REPORT_TAG = 'rapport-aether'
export const INSTRUCTION_HEADER = '[Pilote Codex] Instruction de GPT'

/** What Aether sends to Claude: GPT's instruction, then the pilot's rules and the report format. */
export function formatClaudeInstruction(instruction: string, roundIndex: number, autoCommit: boolean, workDirectory: string | null = null): string {
  return [
    `${INSTRUCTION_HEADER} — tâche ${roundIndex}`,
    '',
    instruction.trim(),
    '',
    '---',
    'Consignes du pilote Aether :',
    ...(workDirectory ? [`- Travaille dans le dossier ${workDirectory} (worktree git de la branche du pilote) : c’est là qu’Aether vérifie et commite.`] : []),
    autoCommit ? '- Ne fais ni commit ni push : Aether s’en charge après avoir lancé les vérifications.' : '- Ne fais ni commit ni push.',
    '- Ne change pas de branche git.',
    '- Si quelque chose t’empêche d’avancer, arrête-toi et explique-le dans le rapport plutôt que de contourner.',
    `- Termine ta réponse par ce bloc, rempli honnêtement (statut : "termine", "partiel" ou "bloque") :`,
    `<${REPORT_TAG}>`,
    '{"statut": "termine", "resume": "ce qui a été fait", "fichiers": ["chemins modifiés"], "tests": "ce que tu as vérifié et le résultat", "blocages": "ce qui reste ou bloque"}',
    `</${REPORT_TAG}>`
  ].join('\n')
}

const reportSchema = z.object({
  statut: z.string(),
  resume: z.string().optional().default(''),
  fichiers: z.array(z.string()).optional().default([]),
  tests: z.string().optional().default(''),
  blocages: z.string().optional().default('')
})

const STATUS_WORDS: Record<string, ClaudeReport['status']> = { termine: 'done', terminé: 'done', done: 'done', partiel: 'partial', partial: 'partial', bloque: 'blocked', bloqué: 'blocked', blocked: 'blocked' }

export function parseClaudeReport(resultText: string | null): ClaudeReport {
  const text = resultText ?? ''
  const pattern = new RegExp(`<${REPORT_TAG}>([\\s\\S]*?)</${REPORT_TAG}>`, 'gi')
  const blocks = [...text.matchAll(pattern)]
  const last = blocks.at(-1)?.[1]
  if (last) {
    try {
      const parsed = reportSchema.safeParse(JSON.parse(last.trim()))
      if (parsed.success) {
        const status = STATUS_WORDS[parsed.data.statut.trim().toLowerCase()]
        if (status) {
          return { status, summary: parsed.data.resume.slice(0, 8000), files: parsed.data.fichiers.slice(0, 200).map((file) => file.slice(0, 500)), tests: parsed.data.tests.slice(0, 4000), blockers: parsed.data.blocages.slice(0, 4000), structured: true }
        }
      }
    } catch {
      // falls through to the unstructured report
    }
  }
  // No readable block: never assume the task is done.
  return { status: 'partial', summary: text.trim().slice(-6000) || '(Claude n’a rien répondu)', files: [], tests: '', blockers: 'Claude n’a pas fourni de rapport structuré.', structured: false }
}

// ---------------------------------------------------------------------------
// Prompts for GPT
// ---------------------------------------------------------------------------

function describeChecks(checks: CheckResult[]): string {
  if (checks.length === 0) return 'Aucune vérification configurée.'
  return checks.map((check) => `- \`${check.command}\` : ${check.passed ? 'OK' : check.timedOut ? 'ÉCHEC (délai dépassé)' : `ÉCHEC (code ${check.exitCode ?? '?'})`}${check.passed ? '' : `\n  Fin de la sortie :\n${indent(check.outputTail.slice(-1500), '    ')}`}`).join('\n')
}

function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => prefix + line)
    .join('\n')
}

function describeRound(round: PilotRound): string {
  const lines = [`### Tâche ${round.index}`, `Instruction : ${round.instruction.slice(0, 3000)}`]
  if (round.claudeError) lines.push(`Erreur de Claude : ${round.claudeError}`)
  if (round.report) {
    const report = round.report
    lines.push(`Statut annoncé par Claude : ${report.status === 'done' ? 'terminé' : report.status === 'partial' ? 'partiel' : 'bloqué'}${report.structured ? '' : ' (pas de rapport structuré)'}`)
    lines.push(`Résumé : ${report.summary}`)
    if (report.files.length > 0) lines.push(`Fichiers : ${report.files.join(', ')}`)
    if (report.tests) lines.push(`Tests selon Claude : ${report.tests}`)
    if (report.blockers) lines.push(`Blocages : ${report.blockers}`)
  }
  lines.push('Vérifications lancées par Aether :', describeChecks(round.checks))
  if (round.commit) lines.push(`Commit : ${round.commit.sha ? round.commit.sha.slice(0, 10) : 'aucun'}${round.commit.note ? ` (${round.commit.note})` : ''}`)
  return lines.join('\n')
}

export interface CodexPromptInput {
  config: PilotConfig
  /** Rounds so far, oldest first; the last one is the task to judge (if any). */
  rounds: PilotRound[]
  answers: string[]
  /** true when GPT's thread was lost (or never existed) and the journal must give it the full picture. */
  freshThread: boolean
  stagnationWarning: string | null
}

const RECENT_ROUNDS_IN_PROMPT = 6

export function buildCodexPrompt(input: CodexPromptInput): string {
  const { config, rounds, answers } = input
  const parts: string[] = []
  const last = rounds.at(-1) ?? null
  if (input.freshThread) {
    parts.push(
      'Tu es le pilote d’une session de développement dans Aether (une interface pour Claude Code).',
      'Ton rôle : découper l’objectif en tâches concrètes, les confier une par une à Claude (qui modifie le code), juger ses rapports et décider de la suite.',
      config.codexReadsProject
        ? 'Ton dossier de travail est le projet. Tu peux y lancer des commandes de lecture (lire des fichiers, `git status`, `git diff`, `git log`, rechercher dans le code) : fais-le pour vérifier ce que Claude affirme plutôt que de croire son rapport sur parole. Le bac à sable est en lecture seule : tu ne peux rien modifier ni lancer de programme qui écrit.'
        : 'Tu ne vois pas le projet : tu juges sur les rapports de Claude et le résultat des vérifications lancées par Aether.',
      'Règles :',
      '- Une instruction = une tâche précise et vérifiable, avec ce qu’il faut faire et comment savoir que c’est fini.',
      '- N’accepte une tâche (previous_task_accepted = true) que si le rapport et les vérifications le justifient ; sinon renvoie une instruction de correction.',
      '- commit_message : message de commit court (impératif, en anglais ou en français) pour la tâche acceptée ; vide sinon.',
      '- action = "done" seulement quand les critères de fin sont tous remplis ; message = bilan final.',
      '- action = "ask_user" si une décision revient à l’utilisateur (choix produit, accès, information manquante) ; message = la question.',
      '- Ne demande jamais de contourner les permissions, de pousser sur la branche principale, de forcer un push ou de désactiver des tests.',
      '',
      `## Objectif\n${config.objective}`,
      `## Critères de fin\n${config.doneCriteria || '(non précisés : juge sur l’objectif et des vérifications vertes)'}`,
      `## Vérifications lancées par Aether après chaque tâche\n${config.checks.length > 0 ? config.checks.map((check) => `- \`${check}\``).join('\n') : '(aucune)'}`,
      `## Permissions de Claude\n${config.allowAllCommands ? 'Claude peut lancer toutes les commandes et modifier les fichiers sans demander : il peut installer, compiler et lancer les tests lui-même. Évite quand même les commandes destructrices ou les accès réseau inutiles.' : config.allowFileEdits ? 'Claude modifie les fichiers sans demander ; les commandes non pré-autorisées attendent l’accord de l’utilisateur.' : 'Chaque modification et chaque commande non pré-autorisée attend l’accord de l’utilisateur.'}`,
      `## Commits\n${config.autoCommit ? 'Aether commite et pousse automatiquement chaque tâche acceptée (rapport « terminé » + vérifications vertes + ton accord), sur une branche dédiée.' : 'Pas de commit automatique.'}`
    )
    const earlier = rounds.slice(0, -1)
    if (earlier.length > 0) {
      const shown = earlier.slice(-RECENT_ROUNDS_IN_PROMPT)
      parts.push(`## Journal (${earlier.length} tâche(s) précédente(s)${earlier.length > shown.length ? `, les ${shown.length} dernières` : ''})`, ...shown.map(describeRound))
    }
  }
  if (last) parts.push('## Tâche à juger', describeRound(last))
  else parts.push('## Début de session', 'Aucune tâche n’a encore été faite. Donne la première instruction pour Claude.')
  if (answers.length > 0) parts.push('## Réponse(s) de l’utilisateur à ta question', ...answers.map((answer) => `> ${answer.replace(/\r?\n/g, '\n> ')}`))
  if (input.stagnationWarning) parts.push('## Attention', input.stagnationWarning)
  parts.push('Réponds uniquement avec l’objet JSON demandé.')
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Stagnation (two AIs going round in circles)
// ---------------------------------------------------------------------------

export const STAGNATION_WINDOW = 3

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function failureSignature(round: PilotRound): string | null {
  const failing = round.checks.filter((check) => !check.passed).map((check) => `${check.command}:${check.exitCode}:${normalise(check.outputTail.slice(-400))}`)
  if (round.claudeError) failing.push(`claude:${normalise(round.claudeError)}`)
  return failing.length > 0 ? failing.join('|') : null
}

/**
 * Returns why the loop looks stuck over its last rounds, or null.
 * `baselineFingerprint` is the folder's state when the pilot started.
 */
export function detectStagnation(rounds: PilotRound[], baselineFingerprint: string | null, window = STAGNATION_WINDOW): string | null {
  if (rounds.length < window) return null
  const recent = rounds.slice(-window)
  // The folder's state before each of the last tasks and after the last one: all equal = nothing changed.
  const states = [baselineFingerprint, ...rounds.map((round) => round.fingerprint)].slice(-(window + 1))
  if (states.every((state) => state !== null && state === states[0])) return `${window} tâches de suite sans aucun changement dans le projet.`
  const instructions = recent.map((round) => normalise(round.instruction))
  if (instructions.every((instruction) => instruction === instructions[0])) return `GPT a donné ${window} fois de suite la même instruction.`
  const failures = recent.map(failureSignature)
  if (failures.every((failure) => failure !== null && failure === failures[0])) return `La même erreur revient ${window} fois de suite.`
  return null
}

// ---------------------------------------------------------------------------
// Secrets: never pushed
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'clé privée', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { label: 'clé AWS', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'jeton GitHub', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'clé OpenAI', pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { label: 'clé Anthropic', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { label: 'clé Google', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'jeton Slack', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'clé Stripe', pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { label: 'mot de passe en clair', pattern: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i }
]

const SECRET_FILE_PATTERN = /(^|[\\/])(\.env(\.[^\\/]*)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|credentials\.json|\.npmrc|\.pypirc)$/i
const SAFE_ENV_FILE = /(^|[\\/])\.env\.(example|sample|template)$/i

export interface SecretFinding {
  file: string | null
  label: string
}

/** Scans the added lines of a staged diff and the staged file names. */
export function scanForSecrets(diff: string, stagedFiles: string[]): SecretFinding[] {
  const findings: SecretFinding[] = []
  for (const file of stagedFiles) {
    if (SECRET_FILE_PATTERN.test(file) && !SAFE_ENV_FILE.test(file)) findings.push({ file, label: 'fichier sensible' })
  }
  let currentFile: string | null = null
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      currentFile = line.slice(4).replace(/^b\//, '')
      continue
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    for (const { label, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line) && !findings.some((finding) => finding.file === currentFile && finding.label === label)) findings.push({ file: currentFile, label })
    }
  }
  return findings
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

export const PILOT_BRANCH_PREFIX = 'aether/pilote-'

export function pilotBranchName(objective: string, now: Date): string {
  const slug = objective
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `${PILOT_BRANCH_PREFIX}${slug || 'session'}-${stamp}`
}

/** Main branches: the pilot commits and pushes there only if the user explicitly accepted it. */
export function isProtectedBranch(branch: string, defaultBranch: string | null): boolean {
  const name = branch.trim()
  return name === defaultBranch || ['main', 'master', 'develop', 'trunk'].includes(name)
}

/** Classifies a Codex failure message. */
export function isCodexUsageLimit(message: string): boolean {
  return /usage limit|rate limit|too many requests|\b429\b|quota|limit reached|try again (in|at)/i.test(message)
}
