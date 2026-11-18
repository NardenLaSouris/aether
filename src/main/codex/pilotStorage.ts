/**
 * Pilot journals, one JSON file per conversation in Aether's data folder (`pilots/`).
 * Written through a temporary file then renamed, so a crash never leaves half a journal.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PilotSnapshot } from '../../shared/pilot'
import type { PilotStorage } from './pilotService'

const FILE_NAME = /^[A-Za-z0-9_.:-]{1,200}\.json$/

export function createPilotStorage(directory: string, onError: (message: string, error: unknown) => void): PilotStorage {
  return {
    loadAll() {
      let names: string[]
      try {
        names = readdirSync(directory)
      } catch {
        return []
      }
      const snapshots: PilotSnapshot[] = []
      for (const name of names) {
        if (!FILE_NAME.test(name) || name === 'decision-schema.json') continue
        try {
          const parsed = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Partial<PilotSnapshot>
          if (typeof parsed.conversationId === 'string' && Array.isArray(parsed.rounds)) snapshots.push(parsed as PilotSnapshot)
        } catch (error) {
          onError(`Journal de pilote illisible : ${name}`, error)
        }
      }
      return snapshots
    },
    save(snapshot) {
      mkdirSync(directory, { recursive: true })
      const safeName = snapshot.conversationId.replace(/[^A-Za-z0-9_.-]/g, '_')
      const target = join(directory, `${safeName}.json`)
      const temporary = `${target}.tmp`
      writeFileSync(temporary, JSON.stringify(snapshot), 'utf8')
      renameSync(temporary, target)
    }
  }
}
