/**
 * Typed data access for the app-owned tables. Claude Code transcripts are never stored here:
 * they stay in Claude Code's own storage and are read on demand through the SDK.
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
  DEFAULT_PREFERENCES,
  type AppPreferences,
  type Conversation,
  type ConversationOrigin,
  type LogRecord,
  type PermissionModeOption,
  type Project,
  type QuotaEventRecord,
  type TokenUsageTotals,
  type UsageEventRecord
} from '../../shared/domain'
import type { AppDatabase } from './appDatabase'

interface ProjectRow {
  id: string
  name: string
  directory_path: string
  created_at: number
  last_opened_at: number
}

interface ConversationRow {
  id: string
  title: string
  project_id: string | null
  working_directory: string
  claude_session_id: string | null
  model: string | null
  permission_mode: string
  archived: number
  origin: string
  created_at: number
  updated_at: number
}

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, directoryPath: row.directory_path, createdAt: row.created_at, lastOpenedAt: row.last_opened_at }
}

function toPermissionMode(value: string): PermissionModeOption {
  return value === 'acceptEdits' || value === 'plan' || value === 'bypassPermissions' ? value : 'default'
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    workingDirectory: row.working_directory,
    claudeSessionId: row.claude_session_id,
    model: row.model,
    permissionMode: toPermissionMode(row.permission_mode),
    archived: row.archived === 1,
    origin: (row.origin === 'imported' ? 'imported' : 'aether') as ConversationOrigin,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProjectRepository {
  constructor(private readonly database: AppDatabase) {}

  list(): Project[] {
    return this.database.all<ProjectRow>('SELECT * FROM projects ORDER BY last_opened_at DESC').map(toProject)
  }

  findById(projectId: string): Project | null {
    const row = this.database.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', [projectId])
    return row ? toProject(row) : null
  }

  findByDirectory(directoryPath: string): Project | null {
    const row = this.database.get<ProjectRow>('SELECT * FROM projects WHERE lower(directory_path) = lower(?)', [directoryPath])
    return row ? toProject(row) : null
  }

  /** Adds a project or returns the existing one for the same directory (case-insensitive on Windows). */
  upsert(directoryPath: string, now: number = Date.now()): Project {
    const existing = this.findByDirectory(directoryPath)
    if (existing) {
      this.touch(existing.id, now)
      return { ...existing, lastOpenedAt: now }
    }
    const project: Project = { id: randomUUID(), name: basename(directoryPath) || directoryPath, directoryPath, createdAt: now, lastOpenedAt: now }
    this.database.run('INSERT INTO projects (id, name, directory_path, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?)', [project.id, project.name, project.directoryPath, project.createdAt, project.lastOpenedAt])
    return project
  }

  touch(projectId: string, now: number = Date.now()): void {
    this.database.run('UPDATE projects SET last_opened_at = ? WHERE id = ?', [now, projectId])
  }

  /** Removes the project from Aether only; files on disk and conversations are kept. */
  remove(projectId: string): void {
    this.database.run('UPDATE conversations SET project_id = NULL WHERE project_id = ?', [projectId])
    this.database.run('DELETE FROM projects WHERE id = ?', [projectId])
  }
}

export interface NewConversation {
  title: string
  projectId: string | null
  workingDirectory: string
  claudeSessionId?: string | null
  model?: string | null
  permissionMode?: PermissionModeOption
  origin?: ConversationOrigin
  createdAt?: number
  updatedAt?: number
}

export class ConversationRepository {
  constructor(private readonly database: AppDatabase) {}

  list(includeArchived: boolean): Conversation[] {
    const sql = includeArchived ? 'SELECT * FROM conversations ORDER BY updated_at DESC' : 'SELECT * FROM conversations WHERE archived = 0 ORDER BY updated_at DESC'
    return this.database.all<ConversationRow>(sql).map(toConversation)
  }

  findById(conversationId: string): Conversation | null {
    const row = this.database.get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', [conversationId])
    return row ? toConversation(row) : null
  }

  findBySessionId(claudeSessionId: string): Conversation | null {
    const row = this.database.get<ConversationRow>(
      `SELECT c.* FROM conversations c
       LEFT JOIN session_mappings m ON m.conversation_id = c.id
       WHERE c.claude_session_id = ? OR m.claude_session_id = ?
       ORDER BY c.updated_at DESC LIMIT 1`,
      [claudeSessionId, claudeSessionId]
    )
    return row ? toConversation(row) : null
  }

  create(input: NewConversation): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      title: input.title.trim() || 'Nouvelle conversation',
      projectId: input.projectId,
      workingDirectory: input.workingDirectory,
      claudeSessionId: input.claudeSessionId ?? null,
      model: input.model ?? null,
      permissionMode: input.permissionMode ?? 'default',
      archived: false,
      origin: input.origin ?? 'aether',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now
    }
    this.database.run(
      `INSERT INTO conversations (id, title, project_id, working_directory, claude_session_id, model, permission_mode, archived, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [conversation.id, conversation.title, conversation.projectId, conversation.workingDirectory, conversation.claudeSessionId, conversation.model, conversation.permissionMode, conversation.origin, conversation.createdAt, conversation.updatedAt]
    )
    return conversation
  }

  private update(conversationId: string, assignments: string, parameters: (string | number | null)[]): Conversation {
    this.database.run(`UPDATE conversations SET ${assignments}, updated_at = ? WHERE id = ?`, [...parameters, Date.now(), conversationId])
    const conversation = this.findById(conversationId)
    if (!conversation) throw new Error('Conversation introuvable.')
    return conversation
  }

  rename(conversationId: string, title: string): Conversation {
    return this.update(conversationId, 'title = ?', [title.trim()])
  }

  setArchived(conversationId: string, archived: boolean): Conversation {
    return this.update(conversationId, 'archived = ?', [archived ? 1 : 0])
  }

  setModel(conversationId: string, model: string | null): Conversation {
    return this.update(conversationId, 'model = ?', [model])
  }

  setPermissionMode(conversationId: string, permissionMode: PermissionModeOption): Conversation {
    return this.update(conversationId, 'permission_mode = ?', [permissionMode])
  }

  setProject(conversationId: string, projectId: string | null, workingDirectory?: string): Conversation {
    if (workingDirectory) return this.update(conversationId, 'project_id = ?, working_directory = ?', [projectId, workingDirectory])
    return this.update(conversationId, 'project_id = ?', [projectId])
  }

  setSessionId(conversationId: string, claudeSessionId: string): Conversation {
    return this.update(conversationId, 'claude_session_id = ?', [claudeSessionId])
  }

  touch(conversationId: string): void {
    this.database.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [Date.now(), conversationId])
  }

  /** Deletes the Aether conversation only. The Claude Code transcript on disk is never touched. */
  delete(conversationId: string): void {
    this.database.run('DELETE FROM conversations WHERE id = ?', [conversationId])
  }

  search(query: string): Conversation[] {
    const pattern = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    return this.database
      .all<ConversationRow>(
        `SELECT DISTINCT c.* FROM conversations c LEFT JOIN projects p ON p.id = c.project_id
         WHERE c.title LIKE ? ESCAPE '\\' OR c.working_directory LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\'
         ORDER BY c.updated_at DESC LIMIT 200`,
        [pattern, pattern, pattern]
      )
      .map(toConversation)
  }
}

export class SessionMappingRepository {
  constructor(private readonly database: AppDatabase) {}

  record(conversationId: string, claudeSessionId: string, source: 'init' | 'discovery' | 'resume', workingDirectory: string | null, now: number = Date.now()): void {
    this.database.run(
      `INSERT INTO session_mappings (conversation_id, claude_session_id, source, working_directory, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, claude_session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      [conversationId, claudeSessionId, source, workingDirectory, now, now]
    )
  }

  sessionIdsFor(conversationId: string): string[] {
    return this.database.all<{ claude_session_id: string }>('SELECT claude_session_id FROM session_mappings WHERE conversation_id = ? ORDER BY last_seen_at DESC', [conversationId]).map((row) => row.claude_session_id)
  }

  /** sessionId -> conversationId for every mapped session. */
  linkMap(): Map<string, string> {
    const links = new Map<string, string>()
    for (const row of this.database.all<{ claude_session_id: string; conversation_id: string }>('SELECT claude_session_id, conversation_id FROM session_mappings')) links.set(row.claude_session_id, row.conversation_id)
    for (const row of this.database.all<{ claude_session_id: string; id: string }>('SELECT claude_session_id, id FROM conversations WHERE claude_session_id IS NOT NULL')) links.set(row.claude_session_id, row.id)
    return links
  }
}

export class PreferencesRepository {
  constructor(private readonly database: AppDatabase) {}

  getAll(): AppPreferences {
    const preferences: AppPreferences = { ...DEFAULT_PREFERENCES }
    const mutable = preferences as unknown as Record<string, unknown>
    for (const row of this.database.all<{ key: string; value: string }>('SELECT key, value FROM preferences')) {
      if (!(row.key in DEFAULT_PREFERENCES)) continue
      try {
        mutable[row.key] = JSON.parse(row.value)
      } catch {
        // ignore a corrupted value and keep the default
      }
    }
    return preferences
  }

  update(changes: Partial<AppPreferences>): AppPreferences {
    const now = Date.now()
    this.database.transaction(() => {
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || !(key in DEFAULT_PREFERENCES)) continue
        this.database.run('INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(value), now])
      }
    })
    return this.getAll()
  }
}

interface UsageRow {
  id: number
  conversation_id: string | null
  claude_session_id: string | null
  model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  estimated_cost_usd: number | null
  duration_ms: number
  is_error: number
  created_at: number
}

export class UsageRepository {
  constructor(private readonly database: AppDatabase) {}

  record(event: Omit<UsageEventRecord, 'id' | 'createdAt'> & { createdAt?: number }): void {
    this.database.run(
      `INSERT INTO usage_events (conversation_id, claude_session_id, model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, estimated_cost_usd, duration_ms, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [event.conversationId, event.claudeSessionId, event.model, event.inputTokens, event.outputTokens, event.cacheReadInputTokens, event.cacheCreationInputTokens, event.estimatedCostUsd, event.durationMs, event.isError ? 1 : 0, event.createdAt ?? Date.now()]
    )
  }

  recent(limit: number): UsageEventRecord[] {
    return this.database.all<UsageRow>('SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?', [limit]).map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      claudeSessionId: row.claude_session_id,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      durationMs: row.duration_ms,
      isError: row.is_error === 1,
      createdAt: row.created_at
    }))
  }

  totalsSince(since: number): TokenUsageTotals {
    const row = this.database.get<{ input: number | null; output: number | null; cache_read: number | null; cache_create: number | null; cost: number | null; turns: number }>(
      `SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_input_tokens) AS cache_read,
              SUM(cache_creation_input_tokens) AS cache_create, SUM(COALESCE(estimated_cost_usd, 0)) AS cost, COUNT(*) AS turns
       FROM usage_events WHERE created_at >= ?`,
      [since]
    )
    return {
      inputTokens: row?.input ?? 0,
      outputTokens: row?.output ?? 0,
      cacheReadInputTokens: row?.cache_read ?? 0,
      cacheCreationInputTokens: row?.cache_create ?? 0,
      estimatedCostUsd: row?.cost ?? 0,
      turns: row?.turns ?? 0
    }
  }
}

export class QuotaEventRepository {
  constructor(private readonly database: AppDatabase) {}

  record(event: Omit<QuotaEventRecord, 'id' | 'createdAt'> & { createdAt?: number }): void {
    this.database.run('INSERT INTO quota_events (event_type, limit_kind, status, utilization_percent, resets_at, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      event.eventType,
      event.limitKind,
      event.status,
      event.utilizationPercent,
      event.resetsAt,
      event.message,
      event.createdAt ?? Date.now()
    ])
  }

  recent(limit: number): QuotaEventRecord[] {
    return this.database
      .all<{ id: number; event_type: QuotaEventRecord['eventType']; limit_kind: string | null; status: string | null; utilization_percent: number | null; resets_at: number | null; message: string | null; created_at: number }>(
        'SELECT * FROM quota_events ORDER BY created_at DESC, id DESC LIMIT ?',
        [limit]
      )
      .map((row) => ({ id: row.id, eventType: row.event_type, limitKind: row.limit_kind, status: row.status, utilizationPercent: row.utilization_percent, resetsAt: row.resets_at, message: row.message, createdAt: row.created_at }))
  }
}

export class LogRepository {
  constructor(private readonly database: AppDatabase) {}

  write(level: LogRecord['level'], scope: string, message: string, details: string | null): void {
    this.database.run('INSERT INTO application_logs (level, scope, message, details, created_at) VALUES (?, ?, ?, ?, ?)', [level, scope, message.slice(0, 2000), details ? details.slice(0, 8000) : null, Date.now()])
  }

  recent(limit: number): LogRecord[] {
    return this.database.all<{ id: number; level: LogRecord['level']; scope: string; message: string; details: string | null; created_at: number }>('SELECT * FROM application_logs ORDER BY id DESC LIMIT ?', [limit]).map((row) => ({
      id: row.id,
      level: row.level,
      scope: row.scope,
      message: row.message,
      details: row.details,
      createdAt: row.created_at
    }))
  }

  /** Keep the log table bounded. */
  prune(keepLatest: number): void {
    this.database.run('DELETE FROM application_logs WHERE id <= (SELECT id FROM application_logs ORDER BY id DESC LIMIT 1 OFFSET ?)', [keepLatest])
  }
}

export interface Repositories {
  projects: ProjectRepository
  conversations: ConversationRepository
  sessionMappings: SessionMappingRepository
  preferences: PreferencesRepository
  usage: UsageRepository
  quotaEvents: QuotaEventRepository
  logs: LogRepository
}

export function createRepositories(database: AppDatabase): Repositories {
  return {
    projects: new ProjectRepository(database),
    conversations: new ConversationRepository(database),
    sessionMappings: new SessionMappingRepository(database),
    preferences: new PreferencesRepository(database),
    usage: new UsageRepository(database),
    quotaEvents: new QuotaEventRepository(database),
    logs: new LogRepository(database)
  }
}
