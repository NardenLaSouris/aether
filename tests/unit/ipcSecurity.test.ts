import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTrustedSenderUrl, parseIpcPayload, registerIpcHandlers, type IpcHandlers } from '../../src/main/ipc/ipcSecurity'
import { isAllowedExternalUrl, requireExecutableFile, requireExistingDirectory } from '../../src/main/services/pathGuard'
import { INVOKE_CHANNEL_NAMES, PUSH_CHANNEL_NAMES } from '../../src/shared/ipcChannels'
import { ipcSchemas, PUSH_CHANNELS } from '../../src/shared/ipcContract'

describe('IPC whitelist', () => {
  it('the preload channel list matches the validated schemas exactly', () => {
    expect([...INVOKE_CHANNEL_NAMES].sort()).toEqual(Object.keys(ipcSchemas).sort())
    expect([...PUSH_CHANNEL_NAMES].sort()).toEqual([...PUSH_CHANNELS].sort())
  })

  it('only trusts the packaged renderer or the dev server origin', () => {
    const prefix = 'file:///C:/Program%20Files/Aether/resources/app.asar/out/renderer'
    expect(isTrustedSenderUrl(`${prefix}/index.html`, prefix, null)).toBe(true)
    expect(isTrustedSenderUrl('file:///C:/Users/evil/index.html', prefix, null)).toBe(false)
    expect(isTrustedSenderUrl('https://example.com', prefix, null)).toBe(false)
    expect(isTrustedSenderUrl(undefined, prefix, null)).toBe(false)
    expect(isTrustedSenderUrl('http://localhost:5173/', prefix, 'http://localhost:5173')).toBe(true)
    expect(isTrustedSenderUrl('http://localhost:9999/', prefix, 'http://localhost:5173')).toBe(false)
  })
})

describe('payload validation', () => {
  it('accepts valid payloads', () => {
    expect(parseIpcPayload('chat:send', { conversationId: 'abc-123', text: 'Bonjour', clientMessageId: 'id-1' })).toMatchObject({ text: 'Bonjour' })
    expect(parseIpcPayload('sessions:open', { sessionId: '7a2b3c4d-1111-4222-8333-944445555666' })).toBeTruthy()
  })

  it('rejects injection attempts and malformed data', () => {
    expect(() => parseIpcPayload('conversations:rename', { conversationId: '../../etc/passwd', title: 'x' })).toThrow(/invalides/)
    expect(() => parseIpcPayload('chat:send', { conversationId: 'a', text: '', clientMessageId: 'b' })).toThrow()
    expect(() => parseIpcPayload('sessions:open', { sessionId: 'not-a-uuid; rm -rf /' })).toThrow()
    expect(() => parseIpcPayload('conversations:set-model', { conversationId: 'a', model: 'model"; drop table' })).toThrow()
    expect(() => parseIpcPayload('conversations:set-permission-mode', { conversationId: 'a', permissionMode: 'dontAsk' })).toThrow()
    expect(() => parseIpcPayload('preferences:update', { theme: 'neon' })).toThrow()
    expect(() => parseIpcPayload('shell:open-external', { url: 'javascript:alert(1)' })).toThrow()
  })
})

describe('registerIpcHandlers', () => {
  function setup() {
    const registered = new Map<string, (event: { senderFrame: { url: string } | null }, payload: unknown) => Promise<unknown>>()
    const errors: string[] = []
    const handlers = Object.fromEntries(Object.keys(ipcSchemas).map((channel) => [channel, async (input: unknown) => ({ channel, input })])) as unknown as IpcHandlers
    registerIpcHandlers({ handle: (channel, listener) => registered.set(channel, listener) }, handlers, (url) => url === 'app://trusted', (channel) => errors.push(channel))
    return { registered, errors }
  }

  it('registers every channel', () => {
    expect(setup().registered.size).toBe(Object.keys(ipcSchemas).length)
  })

  it('refuses untrusted senders before validation', async () => {
    const handler = setup().registered.get('projects:list')
    await expect(handler?.({ senderFrame: { url: 'https://attacker.example' } }, undefined)).rejects.toThrow(/non autorisé/)
    await expect(handler?.({ senderFrame: null }, undefined)).rejects.toThrow(/non autorisé/)
  })

  it('validates then dispatches for trusted senders', async () => {
    const handler = setup().registered.get('conversations:search')
    await expect(handler?.({ senderFrame: { url: 'app://trusted' } }, { query: 'abc' })).resolves.toMatchObject({ input: { query: 'abc' } })
    await expect(handler?.({ senderFrame: { url: 'app://trusted' } }, { query: 42 })).rejects.toThrow(/invalides/)
  })
})

describe('path guard', () => {
  it('validates directories and executables', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aether-path-'))
    try {
      expect(requireExistingDirectory(directory)).toBe(directory)
      expect(() => requireExistingDirectory('relative\\path')).toThrow(/absolu/)
      expect(() => requireExistingDirectory(join(directory, 'missing'))).toThrow(/introuvable/)
      expect(() => requireExistingDirectory(`${directory}\0evil`)).toThrow()
      const file = join(directory, 'claude.exe')
      writeFileSync(file, '')
      expect(requireExecutableFile(file)).toBe(file)
      expect(() => requireExistingDirectory(file)).toThrow(/pas un dossier/)
      const script = join(directory, 'run.bat')
      writeFileSync(script, '')
      expect(() => requireExecutableFile(script)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('only opens https links to official hosts', () => {
    expect(isAllowedExternalUrl('https://code.claude.com/docs/en/setup')).toBe(true)
    expect(isAllowedExternalUrl('http://code.claude.com')).toBe(false)
    expect(isAllowedExternalUrl('https://evil.example/claude.ai')).toBe(false)
    expect(isAllowedExternalUrl('file:///C:/Windows/system32/calc.exe')).toBe(false)
  })
})
