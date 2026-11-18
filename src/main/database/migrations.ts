/**
 * Ordered, append-only schema migrations. Never edit a released migration: add a new one.
 * The database is backed up automatically before any pending migration runs.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        directory_path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        working_directory TEXT NOT NULL,
        claude_session_id TEXT,
        model TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'default',
        archived INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'aether',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX conversations_updated_index ON conversations(updated_at DESC);
      CREATE INDEX conversations_session_index ON conversations(claude_session_id);

      CREATE TABLE session_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        claude_session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        working_directory TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        UNIQUE(conversation_id, claude_session_id)
      );

      CREATE TABLE preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT,
        claude_session_id TEXT,
        model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        is_error INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX usage_events_created_index ON usage_events(created_at);

      CREATE TABLE quota_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        limit_kind TEXT,
        status TEXT,
        utilization_percent REAL,
        resets_at INTEGER,
        message TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX quota_events_created_index ON quota_events(created_at);

      CREATE TABLE application_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX application_logs_created_index ON application_logs(created_at);
    `
  }
]
