/**
 * ORION CONNECT: the one link from Aether to ORION, for mods holding the `orion.connect` permission.
 *
 * The main process alone talks to ORION (one address chosen by the user), keeps the client secret encrypted with the
 * OS (Electron safeStorage) and the session in memory only. A mod never sees the secret, the session or the network:
 * it asks for one of a closed list of ORION APPS routes (`/api/connect/v1/...`), validated here.
 * ORION decides everything else (permissions per app and capability, confirmations): a mod gets no more than an
 * ORION CONNECT client, which itself has none of ORION Control's rights.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ORION_CONNECT_PREFIX,
  orionAddressProblem,
  orionRouteProblem,
  type OrionConnectStatus,
  type OrionRequest,
  type OrionState
} from '../../shared/orionConnect'

export interface SecretBox {
  available(): boolean
  encrypt(text: string): string
  decrypt(data: string): string
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>

interface Stored {
  address: string | null
  clientId: string | null
  secret: string | null
  clientName: string | null
  preferences: Record<string, unknown>
}

/** Below the 30 s a mod waits for an answer from Aether (aether-mod.js): the mod always gets a readable answer. */
const TIMEOUT_MS = 25_000
const MAX_RESPONSE = 2_000_000
const MAX_PREFERENCES = 4_000

export class OrionConnectError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export class OrionConnect {
  private stored: Stored
  private session: { token: string; expiresAt: number } | null = null
  private state: OrionState = 'disconnected'
  private lastError: string | null = null
  private lastContact: number | null = null

  constructor(
    private readonly file: string,
    private readonly box: SecretBox,
    private readonly fetcher: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now
  ) {
    this.stored = this.load()
  }

  private load(): Stored {
    const empty: Stored = { address: null, clientId: null, secret: null, clientName: null, preferences: {} }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Stored>
      return { ...empty, ...raw, preferences: raw.preferences && typeof raw.preferences === 'object' ? raw.preferences : {} }
    } catch {
      return empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2), 'utf8')
  }

  status(): OrionConnectStatus {
    return {
      address: this.stored.address,
      paired: Boolean(this.stored.clientId && this.stored.secret),
      clientName: this.stored.clientName,
      state: this.state,
      sessionExpiresAt: this.session?.expiresAt ?? null,
      lastError: this.lastError,
      lastContact: this.lastContact,
      encryption: this.box.available(),
      preferences: this.stored.preferences
    }
  }

  /** A new address forgets the pairing: a credential is only ever sent to the ORION that issued it. */
  configure(address: string): OrionConnectStatus {
    const problem = orionAddressProblem(address)
    if (problem) throw new OrionConnectError('bad_address', problem)
    const origin = new URL(address).origin
    if (origin !== this.stored.address) {
      this.stored = { ...this.stored, address: origin, clientId: null, secret: null, clientName: null }
      this.session = null
      this.state = 'disconnected'
      this.lastError = null
    }
    this.save()
    return this.status()
  }

  setPreferences(preferences: Record<string, unknown>): OrionConnectStatus {
    const text = JSON.stringify(preferences ?? {})
    if (text.length > MAX_PREFERENCES) throw new OrionConnectError('too_large', 'Préférences trop volumineuses.')
    this.stored = { ...this.stored, preferences: JSON.parse(text) as Record<string, unknown> }
    this.save()
    return this.status()
  }

  private async raw(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
    if (!this.stored.address) throw new OrionConnectError('no_address', 'Adresse d’ORION non réglée.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers.Authorization = `Bearer ${token}`
    try {
      const response = await this.fetcher(`${this.stored.address}${ORION_CONNECT_PREFIX}/${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal
      })
      const text = await response.text()
      if (text.length > MAX_RESPONSE) throw new OrionConnectError('too_large', 'Réponse d’ORION trop volumineuse.')
      let data: Record<string, unknown> = {}
      try {
        data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {
        throw new OrionConnectError('bad_response', 'Réponse d’ORION illisible.')
      }
      this.lastContact = this.now()
      return { status: response.status, data }
    } catch (error) {
      if (error instanceof OrionConnectError) throw error
      if (controller.signal.aborted) {
        // ORION answers, but slowly (an application behind it is slow): not « unavailable », and maybe done later.
        this.lastError = 'ORION n’a pas répondu à temps.'
        throw new OrionConnectError('timeout', 'ORION n’a pas répondu à temps : la demande continue peut-être (voir Activité).')
      }
      this.state = 'unavailable'
      this.lastError = 'ORION ne répond pas.'
      throw new OrionConnectError('unavailable', 'ORION ne répond pas (adresse, réseau ou service arrêté).')
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(status: number, data: Record<string, unknown>): never {
    const code = String(data.error ?? `http_${status}`)
    const message = String(data.message ?? '') || `Erreur ${status}.`
    if (status === 401 || status === 403) {
      if (['auth_refused', 'client_revoked', 'pairing_refused'].includes(code)) this.state = 'auth_refused'
    } else if (status === 503 && code === 'apps_unavailable') {
      this.state = 'unavailable'
    } else if (status >= 500 && code === 'internal_error') {
      this.state = 'error'
    }
    this.lastError = message
    throw new OrionConnectError(code, message)
  }

  async test(): Promise<{ protocol: string; service: string }> {
    const { status, data } = await this.raw('GET', 'info')
    if (status !== 200) this.fail(status, data)
    return { protocol: String(data.protocol ?? ''), service: String(data.service ?? '') }
  }

  async pair(code: string, name: string): Promise<OrionConnectStatus> {
    if (!this.box.available()) throw new OrionConnectError('no_encryption', 'Chiffrement du système indisponible : le secret ne serait pas protégé.')
    const cleaned = String(code ?? '').trim().slice(0, 20)
    if (!cleaned) throw new OrionConnectError('bad_code', 'Code d’appairage vide.')
    this.state = 'connecting'
    const { status, data } = await this.raw('POST', 'pair', { code: cleaned, name: String(name || 'AETHER').slice(0, 60) })
    if (status !== 201) this.fail(status, data)
    this.stored = { ...this.stored, clientId: String(data.client_id), secret: this.box.encrypt(String(data.client_secret)), clientName: String(data.name ?? 'AETHER') }
    this.save()
    return this.connect()
  }

  async connect(): Promise<OrionConnectStatus> {
    if (!this.stored.clientId || !this.stored.secret) throw new OrionConnectError('not_paired', 'Pas encore appairé : saisissez un code d’appairage créé dans ORION Control.')
    this.state = 'connecting'
    let secret: string
    try {
      secret = this.box.decrypt(this.stored.secret)
    } catch {
      this.state = 'error'
      throw new OrionConnectError('secret_unreadable', 'Secret illisible sur cette session Windows : appairez de nouveau.')
    }
    const { status, data } = await this.raw('POST', 'session', { client_id: this.stored.clientId, client_secret: secret })
    if (status !== 201) this.fail(status, data)
    this.session = { token: String(data.session), expiresAt: Number(data.expires_at) * 1000 }
    this.state = 'connected'
    this.lastError = null
    return this.status()
  }

  async disconnect(): Promise<OrionConnectStatus> {
    const session = this.session
    this.session = null
    this.state = 'disconnected'
    if (session) {
      try {
        await this.raw('POST', 'session/close', {}, session.token)
      } catch {
        /* ORION absent: the session simply expires there */
      }
      this.state = 'disconnected'
    }
    return this.status()
  }

  /** Revokes this client in ORION and forgets it here. */
  async forget(): Promise<OrionConnectStatus> {
    let revokedRemotely = false
    try {
      if (!this.session && this.stored.clientId) await this.connect()
      if (this.session) {
        const { status } = await this.raw('POST', 'client/revoke', {}, this.session.token)
        revokedRemotely = status === 200
      }
    } catch {
      /* forgotten locally anyway; ORION Control can revoke it too */
    }
    this.session = null
    this.stored = { ...this.stored, clientId: null, secret: null, clientName: null }
    this.save()
    this.state = 'disconnected'
    this.lastError = revokedRemotely ? null : 'Oublié ici ; révocation dans ORION non confirmée (ORION Control › ORION APPS).'
    return this.status()
  }

  /** One ORION APPS call on behalf of a mod. Reopens an expired session once. */
  async request(request: OrionRequest): Promise<unknown> {
    const problem = orionRouteProblem(request)
    if (problem) throw new OrionConnectError('route_refused', problem)
    if (!this.session || this.session.expiresAt - 30_000 <= this.now()) await this.connect()
    const query = request.query && Object.keys(request.query).length ? `?${new URLSearchParams(Object.entries(request.query).map(([key, value]): [string, string] => [key, String(value)])).toString()}` : ''
    let body = request.body
    if (request.method === 'POST' && /\/actions$/.test(request.path)) {
      // Idempotency: a request replayed by the mod is the same action for ORION.
      const given = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      body = { ...given, request_id: typeof given.request_id === 'string' ? given.request_id : `aether-${randomUUID()}` }
    }
    let result = await this.raw(request.method, `${request.path}${query}`, request.method === 'POST' ? (body ?? {}) : undefined, this.session?.token)
    if (result.status === 401 && ['session_expired', 'unauthorized'].includes(String(result.data.error))) {
      await this.connect()
      result = await this.raw(request.method, `${request.path}${query}`, request.method === 'POST' ? (body ?? {}) : undefined, this.session?.token)
    }
    if (result.status >= 400) this.fail(result.status, result.data)
    this.state = 'connected'
    return result.data
  }
}
