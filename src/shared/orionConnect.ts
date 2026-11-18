/**
 * ORION CONNECT, shared part: what a mod holding `orion.connect` may ask, checked in the renderer and again in the
 * main process. Only the ORION APPS client routes (`/api/connect/v1/...`) are reachable, never ORION Control's.
 */
import { z } from 'zod'

export const ORION_CONNECT_PREFIX = '/api/connect/v1'

export type OrionState = 'disconnected' | 'connecting' | 'connected' | 'auth_refused' | 'unavailable' | 'error'

export interface OrionConnectStatus {
  address: string | null
  paired: boolean
  clientName: string | null
  state: OrionState
  sessionExpiresAt: number | null
  lastError: string | null
  lastContact: number | null
  /** False when Windows cannot encrypt the client secret: pairing is then refused. */
  encryption: boolean
  preferences: Record<string, unknown>
}

const SEGMENT = '[a-z0-9][a-z0-9_.-]{0,79}'
/** Client routes of ORION APPS (orion/apps/module.py). Pairing and sessions are done by the main process only. */
const ROUTES: { method: 'GET' | 'POST'; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^me$/ },
  { method: 'GET', pattern: /^apps$/ },
  { method: 'GET', pattern: new RegExp(`^apps/${SEGMENT}$`) },
  { method: 'GET', pattern: new RegExp(`^apps/${SEGMENT}/resources/${SEGMENT}$`) },
  { method: 'POST', pattern: new RegExp(`^apps/${SEGMENT}/actions$`) },
  { method: 'GET', pattern: /^actions$/ },
  { method: 'GET', pattern: new RegExp(`^actions/${SEGMENT}$`) },
  { method: 'POST', pattern: new RegExp(`^actions/${SEGMENT}/execute$`) },
  { method: 'GET', pattern: /^activity$/ },
  { method: 'GET', pattern: /^reports$/ },
  { method: 'GET', pattern: new RegExp(`^reports/${SEGMENT}$`) },
  { method: 'POST', pattern: /^reports$/ }
]

export const orionRequestSchema = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string().min(1).max(200),
  query: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
  body: z.unknown().optional()
})
export type OrionRequest = z.infer<typeof orionRequestSchema>

export function orionRouteProblem(request: OrionRequest): string | null {
  const parsed = orionRequestSchema.safeParse(request)
  if (!parsed.success) return 'Requête ORION invalide.'
  if (!ROUTES.some((route) => route.method === request.method && route.pattern.test(request.path))) return `Route ORION non permise : ${request.method} ${request.path.slice(0, 80)}`
  if (request.body !== undefined && JSON.stringify(request.body).length > 32_000) return 'Corps de requête trop volumineux.'
  return null
}

/** http(s) address of the ORION Core, without credentials, path or parameters. */
export function orionAddressProblem(address: string): string | null {
  let url: URL
  try {
    url = new URL(String(address ?? '').trim())
  } catch {
    return 'Adresse invalide (ex. http://192.168.1.91:8866).'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Adresse http ou https attendue.'
  if (url.username || url.password) return 'Pas d’identifiants dans l’adresse.'
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return 'L’adresse du Core seule, sans chemin ni paramètres.'
  return null
}

export const ORION_OPERATIONS = ['status', 'test', 'configure', 'pair', 'connect', 'disconnect', 'forget', 'request', 'preferences'] as const
export type OrionOperation = (typeof ORION_OPERATIONS)[number]
