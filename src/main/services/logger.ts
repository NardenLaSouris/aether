import type { LogRecord } from '../../shared/domain'
import type { LogRepository } from '../database/repositories'

type LogLevel = LogRecord['level']

/** Application logger: console + SQLite `application_logs` table (bounded). */
export class Logger {
  private repository: LogRepository | null = null
  private writesSincePrune = 0

  attach(repository: LogRepository): void {
    this.repository = repository
  }

  log(level: LogLevel, scope: string, message: string, details?: unknown): void {
    const detailText = details === undefined ? null : details instanceof Error ? (details.stack ?? details.message) : typeof details === 'string' ? details : safeStringify(details)
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${message}`
    if (level === 'error') console.error(line, detailText ?? '')
    else if (level === 'warn') console.warn(line, detailText ?? '')
    else if (process.env.AETHER_DEBUG || level === 'info') console.log(line)
    if (!this.repository || (level === 'debug' && !process.env.AETHER_DEBUG)) return
    try {
      this.repository.write(level, scope, message, detailText)
      this.writesSincePrune += 1
      if (this.writesSincePrune > 500) {
        this.repository.prune(5000)
        this.writesSincePrune = 0
      }
    } catch (error) {
      console.error('Logger write failed', error)
    }
  }

  scope(scope: string): ScopedLogger {
    return {
      debug: (message, details) => this.log('debug', scope, message, details),
      info: (message, details) => this.log('info', scope, message, details),
      warn: (message, details) => this.log('warn', scope, message, details),
      error: (message, details) => this.log('error', scope, message, details)
    }
  }
}

export interface ScopedLogger {
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logger = new Logger()
