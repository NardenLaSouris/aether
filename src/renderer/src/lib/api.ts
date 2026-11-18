import type { AetherApi } from '../../../shared/ipcContract'

/** Typed bridge exposed by the preload script. */
export const api: AetherApi = window.aether

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(error)
}

export function newClientId(): string {
  return crypto.randomUUID()
}
