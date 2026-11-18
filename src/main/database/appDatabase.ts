/**
 * SQLite storage for app-owned data, using sql.js (SQLite compiled to WebAssembly).
 * Chosen over native bindings so the same binary works in Electron and in Node test runs
 * without an ABI rebuild. Writes are persisted atomically (temp file + rename).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { MIGRATIONS } from './migrations'

export type SqlParameters = SqlValue[] | Record<string, SqlValue>

export interface OpenDatabaseOptions {
  /** null = in-memory database (tests). */
  filePath: string | null
  /** Directory where automatic pre-migration backups go. */
  backupDirectory?: string
  wasmBinary?: Uint8Array
  persistDebounceMs?: number
}

export class AppDatabase {
  private persistTimer: NodeJS.Timeout | null = null
  private dirty = false

  private constructor(
    private readonly database: Database,
    private readonly options: OpenDatabaseOptions
  ) {}

  static async open(options: OpenDatabaseOptions): Promise<AppDatabase> {
    const sqlModule = await initSqlJs(options.wasmBinary ? { wasmBinary: options.wasmBinary as unknown as ArrayBuffer } : undefined)
    let database: Database
    if (options.filePath && existsSync(options.filePath)) {
      database = new sqlModule.Database(readFileSync(options.filePath))
    } else {
      database = new sqlModule.Database()
    }
    const appDatabase = new AppDatabase(database, options)
    appDatabase.run('PRAGMA foreign_keys = ON')
    appDatabase.migrate()
    return appDatabase
  }

  get schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version')
    return row?.user_version ?? 0
  }

  private migrate(): void {
    const currentVersion = this.schemaVersion
    const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion)
    if (pending.length === 0) return
    // Never migrate an existing database without a backup first.
    if (currentVersion > 0 && this.options.filePath && existsSync(this.options.filePath)) {
      const backupDirectory = this.options.backupDirectory ?? join(dirname(this.options.filePath), 'backups')
      mkdirSync(backupDirectory, { recursive: true })
      copyFileSync(this.options.filePath, join(backupDirectory, `pre-migration-v${currentVersion}-${Date.now()}.sqlite`))
    }
    for (const migration of pending) {
      this.database.exec('BEGIN')
      try {
        this.database.exec(migration.sql)
        this.database.exec(`PRAGMA user_version = ${migration.version}`)
        this.database.exec('COMMIT')
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw new Error(`Migration ${migration.version} (${migration.name}) échouée : ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    this.persistNow()
  }

  run(sql: string, parameters: SqlParameters = []): { changes: number; lastInsertId: number } {
    this.database.run(sql, parameters)
    const changes = this.database.getRowsModified()
    const idRow = this.database.exec('SELECT last_insert_rowid() AS id')[0]
    const lastInsertId = Number(idRow?.values[0]?.[0] ?? 0)
    if (!/^\s*(SELECT|PRAGMA)/i.test(sql)) this.schedulePersist()
    return { changes, lastInsertId }
  }

  all<Row>(sql: string, parameters: SqlParameters = []): Row[] {
    const statement = this.database.prepare(sql)
    try {
      statement.bind(parameters)
      const rows: Row[] = []
      while (statement.step()) rows.push(statement.getAsObject() as Row)
      return rows
    } finally {
      statement.free()
    }
  }

  get<Row>(sql: string, parameters: SqlParameters = []): Row | undefined {
    return this.all<Row>(sql, parameters)[0]
  }

  transaction<Value>(work: () => Value): Value {
    this.database.exec('BEGIN')
    try {
      const value = work()
      this.database.exec('COMMIT')
      this.schedulePersist()
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private schedulePersist(): void {
    if (!this.options.filePath) return
    this.dirty = true
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, this.options.persistDebounceMs ?? 250)
  }

  /** Atomic write: export to a temporary file then rename over the original. */
  persistNow(): void {
    if (!this.options.filePath) return
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    mkdirSync(dirname(this.options.filePath), { recursive: true })
    const temporaryPath = `${this.options.filePath}.tmp`
    writeFileSync(temporaryPath, Buffer.from(this.database.export()))
    renameSync(temporaryPath, this.options.filePath)
    this.dirty = false
  }

  /** Writes a consistent copy of the database to `targetDirectory` and returns its path. */
  backupTo(targetDirectory: string): string {
    mkdirSync(targetDirectory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const targetPath = join(targetDirectory, `aether-backup-${stamp}.sqlite`)
    writeFileSync(targetPath, Buffer.from(this.database.export()))
    return targetPath
  }

  close(): void {
    if (this.dirty) this.persistNow()
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.database.close()
  }
}
