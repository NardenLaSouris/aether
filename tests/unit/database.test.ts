import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../../src/main/database/appDatabase'
import { MIGRATIONS } from '../../src/main/database/migrations'
import { createRepositories } from '../../src/main/database/repositories'
import { DEFAULT_PREFERENCES } from '../../src/shared/domain'

const temporaryDirectories: string[] = []
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aether-db-'))
  temporaryDirectories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('AppDatabase', () => {
  it('applies every migration on a new database', async () => {
    const database = await AppDatabase.open({ filePath: null })
    expect(database.schemaVersion).toBe(MIGRATIONS.at(-1)?.version)
    const tables = database.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((row) => row.name)
    expect(tables).toEqual(expect.arrayContaining(['projects', 'conversations', 'session_mappings', 'preferences', 'usage_events', 'quota_events', 'application_logs']))
    database.close()
  })

  it('persists atomically to disk and reopens with the data', async () => {
    const directory = temporaryDirectory()
    const filePath = join(directory, 'test.sqlite')
    const database = await AppDatabase.open({ filePath })
    createRepositories(database).projects.upsert(directory)
    database.close()
    expect(existsSync(filePath)).toBe(true)
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
    const reopened = await AppDatabase.open({ filePath })
    expect(createRepositories(reopened).projects.list()).toHaveLength(1)
    reopened.close()
  })

  it('backs up an existing database before running a pending migration', async () => {
    const directory = temporaryDirectory()
    const filePath = join(directory, 'test.sqlite')
    const database = await AppDatabase.open({ filePath })
    createRepositories(database).projects.upsert(directory)
    database.close()
    MIGRATIONS.push({ version: 999, name: 'test migration', sql: 'CREATE TABLE test_extra (value TEXT);' })
    try {
      const reopened = await AppDatabase.open({ filePath, backupDirectory: join(directory, 'backups') })
      expect(reopened.schemaVersion).toBe(999)
      expect(createRepositories(reopened).projects.list()).toHaveLength(1)
      reopened.close()
      const backups = readdirSync(join(directory, 'backups'))
      expect(backups).toHaveLength(1)
      expect(backups[0]).toMatch(/^pre-migration-v1-/)
    } finally {
      MIGRATIONS.pop()
    }
  })

  it('rolls back a failing migration', async () => {
    MIGRATIONS.push({ version: 998, name: 'broken', sql: 'CREATE TABLE ok_table (x); THIS IS NOT SQL;' })
    try {
      await expect(AppDatabase.open({ filePath: null })).rejects.toThrow(/Migration 998/)
    } finally {
      MIGRATIONS.pop()
    }
  })

  it('writes manual backups', async () => {
    const directory = temporaryDirectory()
    const database = await AppDatabase.open({ filePath: join(directory, 'test.sqlite') })
    const backupPath = database.backupTo(join(directory, 'backups'))
    expect(existsSync(backupPath)).toBe(true)
    expect(readdirSync(join(directory, 'backups'))).toHaveLength(1)
    database.close()
  })
})

describe('repositories', () => {
  async function repositories() {
    const database = await AppDatabase.open({ filePath: null })
    return { database, repositories: createRepositories(database) }
  }

  it('manages projects without duplicates (case-insensitive paths)', async () => {
    const { repositories: repos } = await repositories()
    const first = repos.projects.upsert('C:\\Work\\Alpha')
    const second = repos.projects.upsert('c:\\work\\alpha')
    expect(second.id).toBe(first.id)
    expect(repos.projects.list()).toHaveLength(1)
    expect(first.name).toBe('Alpha')
  })

  it('creates, renames, archives, searches and deletes conversations', async () => {
    const { repositories: repos } = await repositories()
    const project = repos.projects.upsert('C:\\Work\\Beta')
    const conversation = repos.conversations.create({ title: 'Refactor 100% du module_x', projectId: project.id, workingDirectory: project.directoryPath })
    expect(repos.conversations.rename(conversation.id, 'Nouveau titre').title).toBe('Nouveau titre')
    expect(repos.conversations.setArchived(conversation.id, true).archived).toBe(true)
    expect(repos.conversations.list(false)).toHaveLength(0)
    expect(repos.conversations.list(true)).toHaveLength(1)
    expect(repos.conversations.search('Beta')).toHaveLength(1)
    expect(repos.conversations.search('%')).toHaveLength(0)
    repos.conversations.delete(conversation.id)
    expect(repos.conversations.findById(conversation.id)).toBeNull()
  })

  it('keeps the Claude session id and finds conversations by any mapped session', async () => {
    const { repositories: repos } = await repositories()
    const conversation = repos.conversations.create({ title: 't', projectId: null, workingDirectory: 'C:\\x' })
    repos.conversations.setSessionId(conversation.id, 'session-a')
    repos.sessionMappings.record(conversation.id, 'session-a', 'init', 'C:\\x')
    repos.sessionMappings.record(conversation.id, 'session-old', 'resume', 'C:\\x')
    repos.sessionMappings.record(conversation.id, 'session-old', 'resume', 'C:\\x')
    expect(repos.conversations.findBySessionId('session-a')?.id).toBe(conversation.id)
    expect(repos.conversations.findBySessionId('session-old')?.id).toBe(conversation.id)
    expect(repos.sessionMappings.sessionIdsFor(conversation.id).sort()).toEqual(['session-a', 'session-old'])
    expect(repos.sessionMappings.linkMap().get('session-old')).toBe(conversation.id)
  })

  it('removing a project keeps its conversations', async () => {
    const { repositories: repos } = await repositories()
    const project = repos.projects.upsert('C:\\Work\\Gamma')
    const conversation = repos.conversations.create({ title: 't', projectId: project.id, workingDirectory: project.directoryPath })
    repos.projects.remove(project.id)
    expect(repos.conversations.findById(conversation.id)?.projectId).toBeNull()
  })

  it('stores typed preferences with defaults', async () => {
    const { repositories: repos } = await repositories()
    expect(repos.preferences.getAll()).toEqual(DEFAULT_PREFERENCES)
    const updated = repos.preferences.update({ defaultModel: 'model-a', notificationsEnabled: false })
    expect(updated).toMatchObject({ defaultModel: 'model-a', notificationsEnabled: false, theme: 'forest' })
  })

  it('aggregates usage and keeps quota events and logs', async () => {
    const { repositories: repos } = await repositories()
    const base = { conversationId: 'c', claudeSessionId: 's', model: 'm', cacheReadInputTokens: 1, cacheCreationInputTokens: 2, durationMs: 5, isError: false }
    repos.usage.record({ ...base, inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.1, createdAt: 1000 })
    repos.usage.record({ ...base, inputTokens: 5, outputTokens: 5, estimatedCostUsd: null, createdAt: 5000 })
    expect(repos.usage.totalsSince(0)).toEqual({ inputTokens: 15, outputTokens: 25, cacheReadInputTokens: 2, cacheCreationInputTokens: 4, estimatedCostUsd: 0.1, turns: 2 })
    expect(repos.usage.totalsSince(2000).turns).toBe(1)
    repos.quotaEvents.record({ eventType: 'limit_detected', limitKind: 'five_hour', status: 'rejected', utilizationPercent: null, resetsAt: 123, message: 'x' })
    expect(repos.quotaEvents.recent(5)[0]).toMatchObject({ eventType: 'limit_detected', resetsAt: 123 })
    for (let index = 0; index < 20; index += 1) repos.logs.write('info', 'test', `message ${index}`, null)
    repos.logs.prune(5)
    expect(repos.logs.recent(100)).toHaveLength(5)
  })
})
