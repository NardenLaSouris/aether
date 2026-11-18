import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrionConnect, type FetchLike, type SecretBox } from '../../src/main/mods/orionConnect'
import { BRIDGE_METHOD_PERMISSION, bridgeRequestSchema, parseModManifest } from '../../src/shared/aetherMods'
import { orionAddressProblem, orionRouteProblem } from '../../src/shared/orionConnect'

const box: SecretBox = { available: () => true, encrypt: (text) => `chiffré:${Buffer.from(text).toString('base64')}`, decrypt: (data) => Buffer.from(data.replace('chiffré:', ''), 'base64').toString() }

/** A tiny ORION APPS stand-in: pairing, sessions, apps, actions (orion/apps/module.py shapes). */
function fakeOrion() {
  const calls: { method: string; url: string; auth?: string; body?: unknown }[] = []
  const state = { up: true, sessions: new Set<string>(), revoked: false, expired: false, n: 0 }
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined })
    if (!state.up) throw new TypeError('fetch failed')
    const path = url.replace(/^http:\/\/orion:8866\/api\/connect\/v1\//, '').split('?')[0]
    const reply = (status: number, data: unknown) => ({ status, text: async () => JSON.stringify(data) })
    const body = init.body ? (JSON.parse(init.body) as Record<string, string>) : {}
    if (path === 'info') return reply(200, { protocol: 'orion-connect/1', service: 'ORION APPS' })
    if (path === 'pair') return body.code === 'ABCD-EFGH' ? reply(201, { client_id: 'cli-1', client_secret: 'secret-du-client', name: body.name }) : reply(401, { error: 'pairing_refused', message: 'Code refusé.' })
    if (path === 'session') {
      if (state.revoked) return reply(401, { error: 'client_revoked', message: 'Révoqué.' })
      if (body.client_secret !== 'secret-du-client') return reply(401, { error: 'auth_refused', message: 'Refusé.' })
      const token = `session-${++state.n}`
      state.sessions.add(token)
      return reply(201, { session: token, expires_at: Date.now() / 1000 + 3600, client_id: 'cli-1', name: 'AETHER' })
    }
    const token = init.headers.Authorization?.replace('Bearer ', '') ?? ''
    if (!state.sessions.has(token)) return reply(401, { error: 'unauthorized', message: 'Session inconnue.' })
    if (state.expired) {
      state.expired = false
      state.sessions.delete(token)
      return reply(401, { error: 'session_expired', message: 'Session expirée.' })
    }
    if (path === 'session/close') return state.sessions.delete(token), reply(200, { status: 'ok' })
    if (path === 'client/revoke') return (state.revoked = true), reply(200, { status: 'ok' })
    if (path === 'apps') return reply(200, { apps: [{ id: 'frag-factory', name: 'Frag Factory' }] })
    if (path === 'apps/frag-factory/actions') return reply(200, { action: { state: 'executed', request_id: body.request_id } })
    return reply(404, { error: 'not_found', message: 'route inconnue' })
  }
  return { fetcher, calls, state }
}

function make() {
  const orion = fakeOrion()
  const file = join(mkdtempSync(join(tmpdir(), 'orion-connect-')), 'orion-connect.json')
  return { ...orion, file, client: new OrionConnect(file, box, orion.fetcher) }
}

describe('ORION CONNECT — permission and routes', () => {
  it('is a declared permission whose bridge methods all require it', () => {
    expect(parseModManifest({ id: 'orion-connect', name: 'ORION CONNECT', version: '1.0.0', permissions: ['orion.connect', 'ui.toast'] }).ok).toBe(true)
    for (const method of ['orion.status', 'orion.pair', 'orion.request', 'orion.forget']) {
      expect(BRIDGE_METHOD_PERMISSION[method as keyof typeof BRIDGE_METHOD_PERMISSION]).toBe('orion.connect')
      expect(bridgeRequestSchema.safeParse({ tag: 'aether-mod-bridge', requestId: 1, method }).success).toBe(true)
    }
  })

  it('only lets a mod reach the client routes of ORION APPS', () => {
    expect(orionRouteProblem({ method: 'GET', path: 'apps' })).toBeNull()
    expect(orionRouteProblem({ method: 'GET', path: 'apps/frag-factory/resources/statistics.read', query: { since: '2026-11-07' } })).toBeNull()
    expect(orionRouteProblem({ method: 'POST', path: 'apps/frag-factory/actions', body: { capability: 'analysis.run' } })).toBeNull()
    for (const path of ['pair', 'session', '../modules/apps', 'apps/x/grant', 'client/revoke', 'apps/../../status']) {
      expect(orionRouteProblem({ method: 'POST', path })).not.toBeNull()
    }
    expect(orionRouteProblem({ method: 'GET', path: 'apps/x/actions' })).not.toBeNull()
  })

  it('accepts the address of the Core only', () => {
    expect(orionAddressProblem('http://192.168.1.91:8866')).toBeNull()
    expect(orionAddressProblem('ftp://x')).not.toBeNull()
    expect(orionAddressProblem('http://u:p@x:1')).not.toBeNull()
    expect(orionAddressProblem('http://x:1/api/status')).not.toBeNull()
  })
})

describe('ORION CONNECT — pairing, sessions, requests', () => {
  it('pairs, keeps only the encrypted secret on disk and the session in memory', async () => {
    const { client, file, calls } = make()
    client.configure('http://orion:8866')
    expect((await client.test()).protocol).toBe('orion-connect/1')
    const status = await client.pair('ABCD-EFGH', 'AETHER')
    expect(status.state).toBe('connected')
    expect(status.paired).toBe(true)
    const saved = readFileSync(file, 'utf8')
    expect(saved).not.toContain('secret-du-client')
    expect(saved).not.toContain('session-')
    expect(JSON.stringify(status)).not.toContain('secret-du-client')
    expect(calls.at(-1)?.url).toBe('http://orion:8866/api/connect/v1/session')
  })

  it('reports a refused pairing, an absent ORION and a revoked client', async () => {
    const { client, state } = make()
    client.configure('http://orion:8866')
    await expect(client.pair('MAUV-AISE', 'AETHER')).rejects.toThrow('Code refusé.')
    expect(client.status().state).toBe('auth_refused')
    await client.pair('ABCD-EFGH', 'AETHER')
    state.up = false
    await expect(client.request({ method: 'GET', path: 'apps' })).rejects.toThrow('ORION ne répond pas')
    expect(client.status().state).toBe('unavailable')
    state.up = true
    await client.connect() // reconnexion
    expect(client.status().state).toBe('connected')
    state.revoked = true
    await expect(client.connect()).rejects.toThrow('Révoqué.')
    expect(client.status().state).toBe('auth_refused')
  })

  it('reopens an expired session once, adds an idempotency key to actions, refuses other routes', async () => {
    const { client, state, calls } = make()
    client.configure('http://orion:8866')
    await client.pair('ABCD-EFGH', 'AETHER')
    state.expired = true
    expect(await client.request({ method: 'GET', path: 'apps' })).toEqual({ apps: [{ id: 'frag-factory', name: 'Frag Factory' }] })
    const result = (await client.request({ method: 'POST', path: 'apps/frag-factory/actions', body: { capability: 'analysis.run', params: { clip_id: 4 } } })) as { action: { request_id: string } }
    expect(result.action.request_id).toMatch(/^aether-/)
    const replay = (await client.request({ method: 'POST', path: 'apps/frag-factory/actions', body: { capability: 'analysis.run', request_id: 'mod-000001' } })) as { action: { request_id: string } }
    expect(replay.action.request_id).toBe('mod-000001')
    await expect(client.request({ method: 'POST', path: 'apps/frag-factory/grant' })).rejects.toThrow('Route ORION non permise')
    expect(calls.some((call) => call.url.includes('grant'))).toBe(false)
  })

  it('forgets the pairing when the address changes, and on request (revoked in ORION)', async () => {
    const { client, state, file } = make()
    client.configure('http://orion:8866')
    await client.pair('ABCD-EFGH', 'AETHER')
    expect(client.configure('http://orion:8866/').paired).toBe(true) // même origine
    const forgotten = await client.forget()
    expect(forgotten.paired).toBe(false)
    expect(state.revoked).toBe(true)
    expect(forgotten.lastError).toBeNull()
    await client.pair('ABCD-EFGH', 'AETHER').catch(() => undefined)
    state.revoked = false
    await client.pair('ABCD-EFGH', 'AETHER')
    expect(client.configure('http://autre:8866').paired).toBe(false)
    expect(readFileSync(file, 'utf8')).not.toContain('cli-1')
  })

  it('a slow ORION is a timeout, not an unavailable ORION', async () => {
    const orion = fakeOrion()
    const file = join(mkdtempSync(join(tmpdir(), 'orion-connect-')), 'orion-connect.json')
    const slow: FetchLike = (url, init) =>
      url.endsWith('/apps')
        ? new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
        : orion.fetcher(url, init)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const client = new OrionConnect(file, box, slow)
      client.configure('http://orion:8866')
      await client.pair('ABCD-EFGH', 'AETHER')
      const pending = client.request({ method: 'GET', path: 'apps' })
      const outcome = expect(pending).rejects.toThrow('pas répondu à temps')
      await vi.advanceTimersByTimeAsync(26_000)
      await outcome
      expect(client.status().state).toBe('connected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to pair without OS encryption and keeps preferences across restarts', async () => {
    const orion = fakeOrion()
    const file = join(mkdtempSync(join(tmpdir(), 'orion-connect-')), 'orion-connect.json')
    const plain = new OrionConnect(file, { ...box, available: () => false }, orion.fetcher)
    plain.configure('http://orion:8866')
    await expect(plain.pair('ABCD-EFGH', 'AETHER')).rejects.toThrow('Chiffrement')
    plain.setPreferences({ notifications: true, page: 'rapports' })
    const again = new OrionConnect(file, box, orion.fetcher)
    expect(again.status().preferences).toEqual({ notifications: true, page: 'rapports' })
    expect(again.status().address).toBe('http://orion:8866')
    expect(() => again.setPreferences({ big: 'x'.repeat(5000) })).toThrow()
  })
})
