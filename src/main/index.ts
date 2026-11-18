/**
 * Electron main process: lifecycle, services wiring, IPC.
 */
import type { BrowserWindow} from 'electron';
import { app, dialog, ipcMain, Notification, safeStorage, shell, utilityProcess } from 'electron'
import type * as NodePty from 'node-pty'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { APP_CONFIG } from '../shared/appConfig'
import type { AccountSummary, AppPreferences, AuthStatus, ClaudeInstallation, Conversation, ModelOption } from '../shared/domain'
import type { PushEvents } from '../shared/ipcContract'
import { AppDatabase } from './database/appDatabase'
import { createRepositories, type Repositories } from './database/repositories'
import { detectClaudeInstallation, launchOfficialLogin, readAuthStatus, runCommand } from './engine/claudeLocator'
import { EngineSupervisor, type HostProcessHandle } from './engine/engineSupervisor'
import { isTrustedSenderUrl, registerIpcHandlers, type IpcHandlers } from './ipc/ipcSecurity'
import { QuotaManager } from './quota/quotaManager'
import { ChatService, DEFAULT_CONVERSATION_TITLE } from './services/chatService'
import { ExtensionService } from './services/extensionService'
import { CHATGPT_WEB_URL, findChatGptApp, launchStoreApp } from './services/externalApps'
import { configureChatGptSession } from './chatgptView'
import { TerminalService } from './services/terminalService'
import { logger } from './services/logger'
import { isAllowedExternalUrl, requireExecutableFile, requireExistingDirectory } from './services/pathGuard'
import { SessionService } from './services/sessionService'
import { createMainWindow, DEV_SERVER_URL, installSecurityPolicies, rendererFileUrlPrefix } from './window'
import { readGitGraph } from './mods/gitReader'
import { handleModProtocol, registerModScheme } from './mods/modProtocol'
import { watchModsFolder } from './mods/modWatcher'
import { FileSearch } from './services/fileSearch'
import { ChangesService, readTextFile, resolveInside } from './services/changesService'
import { BranchService, isAetherWorktreePath } from './services/branchService'
import { ModRegistry } from './mods/modRegistry'
import { OrionConnect } from './mods/orionConnect'
import { orionRequestSchema } from '../shared/orionConnect'
import { CODEX_DECISION_JSON_SCHEMA } from '../shared/pilot'
import { runChecks } from './codex/checkRunner'
import { locateCodex, readCodexSettings, readCodexStatus, startCodexTurn } from './codex/codexCli'
import { createPilotGit } from './codex/pilotGit'
import { PilotService } from './codex/pilotService'
import { createPilotStorage } from './codex/pilotStorage'

// Aether mods are served by their own protocol; the scheme must be declared before the app is ready.
registerModScheme()

const userDataOverride = process.env.AETHER_USER_DATA_DIR
app.setPath('userData', userDataOverride ?? join(app.getPath('appData'), APP_CONFIG.dataFolderName))
app.setName(APP_CONFIG.name)
if (process.platform === 'win32') app.setAppUserModelId(APP_CONFIG.appId)

const log = logger.scope('main')

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let installation: ClaudeInstallation = { found: false, executablePath: null, version: null, detectionSource: 'none' }
let authStatus: AuthStatus = { checked: false, loggedIn: false }
let installationChecked = false
let models: ModelOption[] = []
let account: AccountSummary | null = null

function push<Channel extends keyof PushEvents>(channel: Channel, payload: PushEvents[Channel]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function notify(title: string, body: string, onlyWhenUnfocused = false): void {
  if (onlyWhenUnfocused && mainWindow?.isFocused()) return
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: `${APP_CONFIG.name} — ${title}`, body, silent: false })
  notification.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  notification.show()
}

function createHostProcess(): HostProcessHandle {
  const child = utilityProcess.fork(join(__dirname, 'engineHost.js'), [], { serviceName: `${APP_CONFIG.name} Engine`, stdio: 'pipe' })
  const hostLog = logger.scope('engine-host')
  child.stdout?.on('data', (chunk: Buffer) => hostLog.debug(chunk.toString('utf8').trim()))
  child.stderr?.on('data', (chunk: Buffer) => hostLog.warn(chunk.toString('utf8').trim()))
  return {
    get pid() {
      return child.pid
    },
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => child.on('message', listener),
    onExit: (listener) => child.on('exit', listener),
    kill: () => child.kill()
  }
}

async function bootstrap(): Promise<void> {
  const dataDirectory = app.getPath('userData')
  const wasmBinary = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))
  const database = await AppDatabase.open({ filePath: join(dataDirectory, APP_CONFIG.databaseFileName), backupDirectory: join(dataDirectory, 'backups'), wasmBinary })
  const repositories: Repositories = createRepositories(database)
  logger.attach(repositories.logs)
  log.info(`${APP_CONFIG.name} ${app.getVersion()} démarré`, { dataDirectory })

  const getPreferences = (): AppPreferences => repositories.preferences.getAll()
  const supervisor = new EngineSupervisor(createHostProcess, logger.scope('engine'))

  const defaultWorkingDirectory = (): string => getPreferences().lastDirectory ?? homedir()

  // Assigned below; the quota manager only calls it after start-up.
  let pilot: PilotService | null = null
  const quota = new QuotaManager({
    now: () => Date.now(),
    setTimer: (callback, delay) => setTimeout(callback, Math.min(delay, 2_147_000_000)),
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
    notify: (title, body) => {
      if (getPreferences().notificationsEnabled) notify(title, body)
      push('app:toast', { tone: 'info', title, body })
    },
    recordEvent: (event) => repositories.quotaEvents.record(event),
    readUsage: async () => {
      if (!installation.executablePath) throw new Error('Claude Code introuvable.')
      const activeConversation = supervisor.activeConversationIds()[0] ?? null
      return supervisor.rpc({ method: 'usage', executablePath: installation.executablePath, workingDirectory: defaultWorkingDirectory(), conversationId: activeConversation })
    },
    onStateChange: (state) => {
      push('quota:state', state)
      // A pilot waiting for the Claude limit resumes on the quota manager's real data only.
      pilot?.onQuotaChange()
    },
    isSubscriptionAccount: () => authStatus.authMethod === 'claude.ai' || Boolean(authStatus.subscriptionType) || Boolean(account?.subscriptionType)
  })

  const claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const extensions = new ExtensionService({
    runCommand,
    probeCommands: async (workingDirectory, launchExtensions) => {
      if (!installation.executablePath) throw new Error('Claude Code introuvable.')
      const probe = await supervisor.rpc({ method: 'probe', executablePath: installation.executablePath, workingDirectory, extensions: launchExtensions }, 90_000)
      return probe.commands
    },
    getExecutablePath: () => installation.executablePath,
    getOverrides: () => getPreferences().extensionOverrides,
    saveOverrides: (overrides) => {
      repositories.preferences.update({ extensionOverrides: overrides })
    },
    modsRoot: join(claudeConfigDirectory, 'dev-mods'),
    log: logger.scope('extensions')
  })

  const terminals = new TerminalService({
    spawn: (file, args, options) => {
      // Loaded on first use: a native module (Windows ConPTY), kept out of the startup path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodePty = require('node-pty') as typeof NodePty
      return nodePty.spawn(file, args, { ...options, useConpty: true })
    },
    onData: (terminalId, data) => push('terminal:data', { terminalId, data }),
    onExit: (terminalId, exitCode) => push('terminal:exit', { terminalId, exitCode })
  })

  const fileSearch = new FileSearch()
  const changes = new ChangesService()
  const branches = new BranchService()
  const requireConversation = (conversationId: string): Conversation => {
    const conversation = repositories.conversations.findById(conversationId)
    if (!conversation) throw new Error('Conversation introuvable.')
    return conversation
  }
  const resourcesDirectory = join(__dirname, '../../resources')
  const mods = new ModRegistry({ builtinDirectory: join(resourcesDirectory, 'mods'), userDirectory: join(dataDirectory, 'mods'), getChoices: () => getPreferences().aetherMods })
  handleModProtocol(mods, join(resourcesDirectory, 'mods-sdk'), (message, error) => log.warn(message, error))
  // Editing a user mod's files reloads its panels: no restart, no rebuild.
  const modsWatcher = watchModsFolder({ directory: mods.userDirectory, onChange: (folder) => push('mods:changed', { folder }) })
  app.on('will-quit', () => modsWatcher.close())
  // ORION CONNECT: one client of ORION for the mods holding `orion.connect`; secret encrypted by Windows (DPAPI).
  const orion = new OrionConnect(join(dataDirectory, 'orion-connect.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64'))
  })

  /** A mod may only read folders Aether already works in: a conversation's or a project's. */
  const requireKnownDirectory = (workingDirectory: string): string => {
    const directory = requireExistingDirectory(workingDirectory)
    const wanted = directory.toLowerCase()
    const known = [...repositories.conversations.list(true).map((conversation) => conversation.workingDirectory), ...repositories.projects.list().map((project) => project.directoryPath)]
    if (!known.some((path) => path.toLowerCase() === wanted)) throw new Error('Ce dossier n’appartient à aucune conversation ni aucun projet d’Aether.')
    return directory
  }

  const chat = new ChatService({
    repositories,
    engine: supervisor,
    quota,
    getInstallation: () => installation,
    getPreferences,
    push,
    notify,
    log: logger.scope('chat'),
    resolveExtensions: (workingDirectory) => extensions.launchExtensions(workingDirectory),
    getLaunchOverrides: (conversationId) => pilot?.launchOverrides(conversationId) ?? null
  })

  const pilotsDirectory = join(dataDirectory, 'pilots')
  const isolatedDirectory = join(pilotsDirectory, 'isolated')
  mkdirSync(isolatedDirectory, { recursive: true })
  const decisionSchemaPath = join(pilotsDirectory, 'decision-schema.json')
  writeFileSync(decisionSchemaPath, JSON.stringify(CODEX_DECISION_JSON_SCHEMA), 'utf8')
  const pilotLog = logger.scope('pilot')
  const isClaudeBusy = (conversationId: string): boolean => {
    const state = supervisor.runnerState(conversationId)
    return state === 'running' || state === 'starting' || state === 'interrupting'
  }
  pilot = new PilotService({
    now: () => Date.now(),
    newId: () => randomUUID(),
    storage: createPilotStorage(pilotsDirectory, (message, error) => pilotLog.warn(message, error)),
    findConversation: (conversationId) => repositories.conversations.findById(conversationId),
    chat: {
      send: (conversationId, text, clientMessageId) => chat.send(conversationId, text, clientMessageId),
      interrupt: (conversationId) => chat.interrupt(conversationId),
      closeRunner: (conversationId) => chat.closeRunner(conversationId)
    },
    isClaudeBusy,
    canSendToClaude: () => quota.canSend(),
    codex: {
      status: () => readCodexStatus(runCommand),
      launch: () => locateCodex(runCommand),
      settings: () => readCodexSettings(),
      startTurn: (request) => startCodexTurn(request)
    },
    git: createPilotGit(),
    runChecks: (commands, workingDirectory) => runChecks(commands, workingDirectory),
    schemaPath: decisionSchemaPath,
    isolatedDirectory,
    publish: (snapshot) => push('pilot:state', snapshot),
    notify: (title, body) => {
      if (getPreferences().notificationsEnabled) notify(title, body)
    },
    log: pilotLog
  })
  const pilots = pilot
  const sessions = new SessionService({ repositories, engine: supervisor, getPreferences, log: logger.scope('sessions') })

  supervisor.on('event', (event) => {
    try {
      chat.handleEngineEvent(event)
      pilots.handleEngineEvent(event)
    } catch (error) {
      log.error('Traitement d’un événement moteur échoué', error)
    }
  })
  supervisor.on('status', (status) => push('engine:status', status))

  const detect = async (): Promise<ClaudeInstallation> => {
    installation = await detectClaudeInstallation(getPreferences().claudeExecutablePath)
    installationChecked = true
    log.info(installation.found ? `Claude Code ${installation.version} détecté (${installation.executablePath})` : 'Claude Code introuvable')
    return installation
  }

  const refreshModels = async (): Promise<{ models: ModelOption[]; account: AccountSummary | null; error?: string }> => {
    if (!installation.executablePath) return { models, account, error: 'Claude Code introuvable.' }
    try {
      const probe = await supervisor.rpc({ method: 'probe', executablePath: installation.executablePath, workingDirectory: defaultWorkingDirectory() })
      models = probe.models
      account = probe.account
      return { models, account }
    } catch (error) {
      log.warn('Lecture des modèles échouée', error)
      return { models, account, error: error instanceof Error ? error.message : String(error) }
    }
  }

  const addProject = async (directoryPath?: string): Promise<ReturnType<Repositories['projects']['upsert']> | null> => {
    let chosen = directoryPath
    if (!chosen) {
      const options = { title: 'Ajouter un projet', defaultPath: getPreferences().lastDirectory ?? homedir(), properties: ['openDirectory' as const] }
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) return null
      chosen = result.filePaths[0]
    }
    const validated = requireExistingDirectory(chosen)
    repositories.preferences.update({ lastDirectory: validated })
    return repositories.projects.upsert(validated)
  }

  const handlers: IpcHandlers = {
    'app:get-bootstrap': () => ({
      appName: APP_CONFIG.name,
      appVersion: app.getVersion(),
      platform: process.platform,
      dataDirectory: app.getPath('userData'),
      preferences: getPreferences(),
      installation: installationChecked ? installation : null,
      auth: authStatus,
      engine: supervisor.status(),
      models,
      account,
      quota: quota.snapshot
    }),
    'window:minimize': () => mainWindow?.minimize(),
    'window:toggle-maximize': () => {
      if (!mainWindow) return
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    },
    'window:close': () => mainWindow?.close(),

    'engine:get-status': () => supervisor.status(),
    'engine:restart': async () => {
      await supervisor.restart()
      return supervisor.status()
    },
    'engine:detect-claude': () => detect(),
    'engine:check-auth': async () => {
      if (!installation.executablePath) await detect()
      if (!installation.executablePath) {
        authStatus = { checked: true, loggedIn: false, error: 'Claude Code introuvable.' }
        return authStatus
      }
      authStatus = await readAuthStatus(installation.executablePath)
      return authStatus
    },
    'engine:open-login': ({ method }) => {
      if (!installation.executablePath) return { launched: false, error: 'Claude Code introuvable.' }
      return launchOfficialLogin(installation.executablePath, method)
    },
    'engine:refresh-models': () => refreshModels(),

    'projects:list': () => repositories.projects.list(),
    'projects:add': ({ directoryPath }) => addProject(directoryPath),
    'projects:remove': ({ projectId }) => repositories.projects.remove(projectId),
    'projects:touch': ({ projectId }) => {
      repositories.projects.touch(projectId)
      return repositories.projects.findById(projectId)
    },

    'conversations:list': ({ includeArchived }) => repositories.conversations.list(includeArchived),
    'conversations:create': ({ projectId, workingDirectory, title, model }) => {
      const project = projectId ? repositories.projects.findById(projectId) : null
      if (projectId && !project) throw new Error('Projet introuvable.')
      const directory = requireExistingDirectory(project?.directoryPath ?? workingDirectory ?? defaultWorkingDirectory())
      if (project) repositories.projects.touch(project.id)
      const preferences = getPreferences()
      return repositories.conversations.create({ title: title ?? DEFAULT_CONVERSATION_TITLE, projectId: project?.id ?? null, workingDirectory: directory, model: model ?? preferences.defaultModel, permissionMode: preferences.defaultPermissionMode })
    },
    'conversations:rename': ({ conversationId, title }) => repositories.conversations.rename(conversationId, title),
    'conversations:archive': async ({ conversationId, archived }) => {
      if (archived) await chat.closeRunner(conversationId)
      return repositories.conversations.setArchived(conversationId, archived)
    },
    'conversations:delete': ({ conversationId }) => chat.deleteConversation(conversationId),
    'conversations:search': ({ query }) => (query.trim() ? repositories.conversations.search(query.trim()) : repositories.conversations.list(false)),
    'conversations:history': ({ conversationId }) => chat.history(conversationId),
    'conversations:set-model': ({ conversationId, model }) => chat.setModel(conversationId, model),
    'conversations:set-permission-mode': ({ conversationId, permissionMode }) => chat.setPermissionMode(conversationId, permissionMode),
    'conversations:set-project': async ({ conversationId, projectId }) => {
      const conversation = repositories.conversations.findById(conversationId)
      if (!conversation) throw new Error('Conversation introuvable.')
      if (!projectId) return repositories.conversations.setProject(conversationId, null)
      const project = repositories.projects.findById(projectId)
      if (!project) throw new Error('Projet introuvable.')
      // A Claude Code session is bound to its directory: only an unstarted conversation can move to another folder.
      if (conversation.claudeSessionId && project.directoryPath.toLowerCase() !== conversation.workingDirectory.toLowerCase()) {
        throw new Error('Cette conversation a déjà une session Claude Code liée à son dossier ; créez une nouvelle conversation dans ce projet.')
      }
      await chat.closeRunner(conversationId)
      return repositories.conversations.setProject(conversationId, project.id, project.directoryPath)
    },

    'chat:send': ({ conversationId, text, clientMessageId, images }) => chat.send(conversationId, text, clientMessageId, images ?? []),
    'chat:set-effort': async ({ conversationId, effort }) => {
      const efforts = { ...getPreferences().conversationEfforts }
      if (effort) efforts[conversationId] = effort
      else delete efforts[conversationId]
      const updated = repositories.preferences.update({ conversationEfforts: efforts })
      await chat.setEffort(conversationId, effort)
      return updated
    },
    'files:search': ({ conversationId, query }) => {
      const conversation = repositories.conversations.findById(conversationId)
      if (!conversation) throw new Error('Conversation introuvable.')
      return fileSearch.search(requireExistingDirectory(conversation.workingDirectory), query)
    },
    'files:read': ({ conversationId, path }) => {
      const conversation = repositories.conversations.findById(conversationId)
      if (!conversation) throw new Error('Conversation introuvable.')
      // Relative paths are read from the conversation's folder; absolute ones only inside a folder Aether knows.
      if (!isAbsolute(path)) return readTextFile(resolveInside(requireExistingDirectory(conversation.workingDirectory), path))
      const known = [conversation.workingDirectory, ...repositories.conversations.list(true).map((item) => item.workingDirectory), ...repositories.projects.list().map((project) => project.directoryPath)]
      for (const directory of known) {
        try {
          return readTextFile(resolveInside(directory, path))
        } catch (error) {
          if (!(error instanceof Error) || !error.message.includes('hors du dossier')) throw error
        }
      }
      throw new Error('Ce fichier n’est dans aucun dossier de conversation ou de projet d’Aether.')
    },
    'chat:rewind-files': ({ conversationId, userMessageId, dryRun }) => chat.rewindFiles(conversationId, userMessageId, dryRun),
    'changes:list': ({ conversationId }) => {
      const conversation = repositories.conversations.findById(conversationId)
      if (!conversation) throw new Error('Conversation introuvable.')
      return changes.summary(requireExistingDirectory(conversation.workingDirectory))
    },
    'changes:file-diff': ({ conversationId, path }) => {
      const conversation = repositories.conversations.findById(conversationId)
      if (!conversation) throw new Error('Conversation introuvable.')
      return changes.fileDiff(requireExistingDirectory(conversation.workingDirectory), path)
    },
    'branch:info': ({ conversationId }) => branches.info(requireExistingDirectory(requireConversation(conversationId).workingDirectory)),
    'branch:create-isolated': async ({ conversationId, name }) => {
      const source = requireConversation(conversationId)
      const worktree = await branches.createWorktree(requireExistingDirectory(source.workingDirectory), name)
      log.info(`Conversation isolée : ${worktree.branch}`, { path: worktree.path })
      const conversation = repositories.conversations.create({ title: name, projectId: source.projectId, workingDirectory: requireExistingDirectory(worktree.path), model: source.model, permissionMode: source.permissionMode })
      return conversation
    },
    'branch:push': ({ conversationId }) => branches.push(requireExistingDirectory(requireConversation(conversationId).workingDirectory)),
    'branch:pull-request': ({ conversationId }) => branches.pullRequest(requireExistingDirectory(requireConversation(conversationId).workingDirectory)),
    'branch:create-pr': async ({ conversationId, title, body, draft }) => {
      const result = await branches.createPullRequest(requireExistingDirectory(requireConversation(conversationId).workingDirectory), title, body, draft)
      if (!result.created && isAllowedExternalUrl(result.url)) await shell.openExternal(result.url)
      return result
    },
    'branch:remove-worktree': async ({ conversationId }) => {
      const conversation = requireConversation(conversationId)
      if (!isAetherWorktreePath(conversation.workingDirectory)) throw new Error('Cette conversation n’est pas isolée dans un worktree d’Aether.')
      await chat.closeRunner(conversationId)
      await branches.removeWorktree(conversation.workingDirectory)
      return repositories.conversations.setArchived(conversationId, true)
    },
    'chat:interrupt': ({ conversationId }) => chat.interrupt(conversationId),
    'chat:permission-decision': ({ requestId, allow, message, answers }) => chat.decidePermission(requestId, allow, message, answers),
    'chat:pending-permissions': () => chat.listPendingPermissions(),

    'sessions:list': ({ forceRefresh }) => sessions.list(forceRefresh),
    'sessions:open': ({ sessionId }) => sessions.open(sessionId),

    'usage:get-summary': () => {
      const now = Date.now()
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      return {
        quota: quota.snapshot,
        totals: { today: repositories.usage.totalsSince(startOfDay.getTime()), sevenDays: repositories.usage.totalsSince(now - 7 * 86_400_000), allTime: repositories.usage.totalsSince(0) },
        recentUsage: repositories.usage.recent(100),
        quotaEvents: repositories.quotaEvents.recent(100),
        subscriptionType: account?.subscriptionType ?? authStatus.subscriptionType ?? null
      }
    },
    'usage:check-now': () => quota.checkNow(),
    'usage:clear-block': () => quota.clearManually(),

    'preferences:get': () => getPreferences(),
    'preferences:update': async (changes) => {
      if (changes.claudeExecutablePath) changes.claudeExecutablePath = requireExecutableFile(changes.claudeExecutablePath)
      const updated = repositories.preferences.update(changes as Partial<AppPreferences>)
      if ('claudeExecutablePath' in changes) await detect()
      return updated
    },
    'preferences:pick-executable': async () => {
      const options = { title: 'Choisir l’exécutable Claude Code', properties: ['openFile' as const], filters: [{ name: 'Claude Code', extensions: ['exe', 'js'] }] }
      const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },

    'apps:open-chatgpt': async () => {
      const chatGpt = await findChatGptApp(runCommand).catch(() => null)
      if (chatGpt) {
        launchStoreApp(chatGpt.appId)
        return { openedIn: 'app' as const }
      }
      await shell.openExternal(CHATGPT_WEB_URL)
      return { openedIn: 'browser' as const }
    },

    'pilot:codex-status': () => pilots.codexStatus(),
    'pilot:list': () => pilots.list(),
    'pilot:get': ({ conversationId }) => pilots.get(conversationId),
    'pilot:branches': ({ conversationId }) => pilots.branches(conversationId),
    'pilot:link': ({ conversationId }) => pilots.link(conversationId),
    'pilot:unlink': ({ conversationId }) => pilots.unlink(conversationId),
    'pilot:start': ({ conversationId, config }) => pilots.start(conversationId, config),
    'pilot:pause': ({ conversationId }) => pilots.pause(conversationId),
    'pilot:resume': ({ conversationId }) => pilots.resume(conversationId),
    'pilot:stop': ({ conversationId }) => pilots.stop(conversationId),
    'pilot:answer': ({ conversationId, text }) => pilots.answer(conversationId, text),

    'mods:catalog': () => mods.catalog(),
    'mods:set-enabled': ({ modId, enabled }) => {
      if (!mods.find(modId)) throw new Error('Mod introuvable.')
      repositories.preferences.update({ aetherMods: { ...getPreferences().aetherMods, [modId]: enabled } })
      log.info(`Mod Aether « ${modId} » ${enabled ? 'activé' : 'désactivé'}`)
      return mods.catalog()
    },
    'mods:open-folder': async () => {
      mkdirSync(mods.userDirectory, { recursive: true })
      await shell.openPath(mods.userDirectory)
    },
    'mods:git-log': ({ modId, workingDirectory, limit }) => {
      const mod = mods.find(modId)
      if (!mod?.enabled) throw new Error('Ce mod est désactivé.')
      if (!mod.manifest.permissions.includes('git.read')) throw new Error('Ce mod n’a pas déclaré la permission git.read.')
      return readGitGraph(requireKnownDirectory(workingDirectory), limit)
    },
    'mods:orion': async ({ modId, operation, params: given }) => {
      const params: Record<string, unknown> = given ?? {}
      const mod = mods.find(modId)
      if (!mod?.enabled) throw new Error('Ce mod est désactivé.')
      if (!mod.manifest.permissions.includes('orion.connect')) throw new Error('Ce mod n’a pas déclaré la permission orion.connect.')
      switch (operation) {
        case 'status':
          return orion.status()
        case 'test':
          return orion.test()
        case 'configure':
          return orion.configure(String(params.address ?? ''))
        case 'pair':
          return orion.pair(String(params.code ?? ''), String(params.name ?? 'AETHER'))
        case 'connect':
          return orion.connect()
        case 'disconnect':
          return orion.disconnect()
        case 'forget':
          log.info(`ORION CONNECT : client oublié à la demande du mod « ${modId} »`)
          return orion.forget()
        case 'preferences':
          return orion.setPreferences((params.preferences ?? {}) as Record<string, unknown>)
        case 'request': {
          const parsed = orionRequestSchema.safeParse(params)
          if (!parsed.success) throw new Error('Requête ORION invalide.')
          return orion.request(parsed.data)
        }
      }
    },

    'extensions:catalog': ({ workingDirectory, refreshPlugins, refreshSkills }) => {
      const directory = workingDirectory ? requireExistingDirectory(workingDirectory) : defaultWorkingDirectory()
      return extensions.catalog(directory, { refreshPlugins, refreshSkills })
    },
    'extensions:update': async ({ changes }) => {
      await extensions.update(changes)
      // Idle sessions are closed so their next message restarts them with the new choices;
      // Claude Code resumes the same session, so the context is kept.
      let reloadedConversations = 0
      let busyConversations = 0
      for (const conversationId of supervisor.activeConversationIds()) {
        const state = supervisor.runnerState(conversationId)
        if (state === 'running' || state === 'starting' || state === 'interrupting') {
          busyConversations += 1
          continue
        }
        await chat.closeRunner(conversationId)
        reloadedConversations += 1
      }
      return { reloadedConversations, busyConversations }
    },

    'terminal:shells': () => terminals.shells(),
    'terminal:list': () => terminals.list(),
    'terminal:create': ({ shell, workingDirectory, columns, rows }) => {
      const directory = requireExistingDirectory(workingDirectory ?? defaultWorkingDirectory())
      return terminals.create({ shell: shell ?? getPreferences().terminalShell, workingDirectory: directory, columns, rows })
    },
    'terminal:write': ({ terminalId, data }) => terminals.write(terminalId, data),
    'terminal:resize': ({ terminalId, columns, rows }) => terminals.resize(terminalId, columns, rows),
    'terminal:close': ({ terminalId }) => terminals.close(terminalId),
    'terminal:scrollback': ({ terminalId }) => terminals.scrollback(terminalId),

    'diagnostics:logs': ({ limit }) => repositories.logs.recent(limit),
    'diagnostics:backup': () => {
      database.persistNow()
      return { filePath: database.backupTo(join(app.getPath('userData'), 'backups')) }
    },
    'diagnostics:open-data-folder': async () => {
      await shell.openPath(app.getPath('userData'))
    },
    'shell:open-external': async ({ url }) => {
      if (!isAllowedExternalUrl(url)) throw new Error('Lien externe non autorisé.')
      await shell.openExternal(url)
    }
  }

  const trustedPrefix = rendererFileUrlPrefix()
  registerIpcHandlers(
    ipcMain,
    handlers,
    (senderUrl) => isTrustedSenderUrl(senderUrl, trustedPrefix, DEV_SERVER_URL),
    (channel, error) => log.warn(`IPC ${channel} a échoué`, error)
  )

  installSecurityPolicies()
  configureChatGptSession()
  mainWindow = createMainWindow()
  mainWindow.on('maximize', () => push('window:maximized', true))
  mainWindow.on('unmaximize', () => push('window:maximized', false))
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Background start: the window is usable even while the engine starts or if it is missing.
  void (async () => {
    await detect()
    supervisor.ensureStarted().catch((error: unknown) => log.error('Moteur indisponible', error))
  })()

  let sessionTimer: NodeJS.Timeout | null = setInterval(() => {
    if (!getPreferences().autoRefreshSessions) return
    sessions
      .list(true)
      .then((result) => push('sessions:updated', { sessions: result.sessions, refreshedAt: result.refreshedAt }))
      .catch(() => undefined)
  }, APP_CONFIG.sessionRefreshIntervalMs)

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    event.preventDefault()
    if (sessionTimer) clearInterval(sessionTimer)
    sessionTimer = null
    quota.dispose()
    pilots.dispose()
    terminals.closeAll()
    supervisor
      .stop()
      .catch(() => undefined)
      .finally(() => {
        try {
          database.close()
        } catch (error) {
          console.error(error)
        }
        app.exit(0)
      })
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  // Windows check their own <webview> requests (the main window allows the ChatGPT panel only,
  // ChatGPT sign-in pop-ups none); anything else (guests, frames) can never embed one.
  if (contents.getType() !== 'window') contents.on('will-attach-webview', (event) => event.preventDefault())
})

app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    console.error(error)
    dialog.showErrorBox(`${APP_CONFIG.name} — erreur au démarrage`, error instanceof Error ? (error.stack ?? error.message) : String(error))
    app.exit(1)
  })
