/**
 * Discovers existing Claude Code sessions through the official SDK `listSessions()`
 * (read-only access to Claude Code's local storage) and binds them to Aether conversations.
 * Original transcripts are never modified, copied or overwritten.
 */
import type { AppPreferences, Conversation, DiscoveredSession } from '../../shared/domain'
import type { Repositories } from '../database/repositories'
import type { EngineLike } from './chatService'
import type { ScopedLogger } from './logger'
import { directoryExists } from './pathGuard'

export interface SessionServiceDependencies {
  repositories: Repositories
  engine: EngineLike
  getPreferences: () => AppPreferences
  log: ScopedLogger
}

export function sessionTitle(session: Pick<DiscoveredSession, 'customTitle' | 'summary' | 'firstPrompt' | 'sessionId'>): string {
  const raw = session.customTitle || session.summary || session.firstPrompt || `Session ${session.sessionId.slice(0, 8)}`
  const compact = raw.replace(/\s+/g, ' ').trim()
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact
}

export class SessionService {
  private cache: DiscoveredSession[] = []
  private refreshedAt = 0
  private refreshing: Promise<{ sessions: DiscoveredSession[]; refreshedAt: number; error?: string }> | null = null

  constructor(private readonly dependencies: SessionServiceDependencies) {}

  async list(forceRefresh: boolean): Promise<{ sessions: DiscoveredSession[]; refreshedAt: number; error?: string }> {
    if (!forceRefresh && this.refreshedAt > 0 && Date.now() - this.refreshedAt < 30_000) return { sessions: this.annotate(this.cache), refreshedAt: this.refreshedAt }
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      try {
        const raw = await this.dependencies.engine.rpc({ method: 'list_sessions', limit: 500 })
        this.cache = raw.map((session) => ({ ...session, cwdExists: directoryExists(session.cwd) }))
        this.refreshedAt = Date.now()
        return { sessions: this.annotate(this.cache), refreshedAt: this.refreshedAt }
      } catch (error) {
        this.dependencies.log.warn('Découverte des sessions Claude Code échouée', error)
        return { sessions: this.annotate(this.cache), refreshedAt: this.refreshedAt, error: error instanceof Error ? error.message : String(error) }
      } finally {
        this.refreshing = null
      }
    })()
    return this.refreshing
  }

  private annotate(sessions: DiscoveredSession[]): DiscoveredSession[] {
    const links = this.dependencies.repositories.sessionMappings.linkMap()
    return sessions.map((session) => ({ ...session, linkedConversationId: links.get(session.sessionId) }))
  }

  /** Returns the conversation bound to a session, creating it (origin "imported") when needed. */
  async open(sessionId: string): Promise<Conversation> {
    const { repositories } = this.dependencies
    const linked = repositories.conversations.findBySessionId(sessionId)
    if (linked) {
      if (linked.archived) return repositories.conversations.setArchived(linked.id, false)
      return linked
    }
    let session = this.cache.find((candidate) => candidate.sessionId === sessionId)
    if (!session) {
      await this.list(true)
      session = this.cache.find((candidate) => candidate.sessionId === sessionId)
    }
    if (!session) throw new Error('Session introuvable dans le stockage local de Claude Code.')
    if (!session.cwd || !directoryExists(session.cwd)) {
      throw new Error(`Reprise impossible : le dossier de travail de cette session n’existe plus${session.cwd ? ` (${session.cwd})` : ''}. Claude Code rattache chaque session à son dossier.`)
    }
    const project = repositories.projects.findByDirectory(session.cwd)
    const conversation = repositories.conversations.create({
      title: sessionTitle(session),
      projectId: project?.id ?? null,
      workingDirectory: session.cwd,
      claudeSessionId: session.sessionId,
      model: null,
      permissionMode: this.dependencies.getPreferences().defaultPermissionMode,
      origin: 'imported',
      createdAt: session.createdAt ?? session.lastModified,
      updatedAt: session.lastModified
    })
    repositories.sessionMappings.record(conversation.id, session.sessionId, 'discovery', session.cwd)
    this.dependencies.log.info(`Session Claude Code ${session.sessionId} rattachée à la conversation ${conversation.id}`)
    return conversation
  }
}
