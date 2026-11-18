/**
 * The aether-mod:// protocol: serves the files of enabled mods to their sandboxed panel frames,
 * each with a strict Content Security Policy (no network, scripts only from the mod itself and the bridge).
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { MOD_PROTOCOL, MOD_SDK_HOST } from '../../shared/aetherMods'
import type { ModRegistry } from './modRegistry'
import { resolveModFile } from './modRegistry'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
}

/** Must run before the app is ready. */
export function registerModScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MOD_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } }])
}

export function modContentSecurityPolicy(modId: string): string {
  const self = `${MOD_PROTOCOL}://${modId}`
  const sdk = `${MOD_PROTOCOL}://${MOD_SDK_HOST}`
  return [
    "default-src 'none'",
    `script-src ${self} ${sdk}`,
    `style-src ${self} 'unsafe-inline'`,
    `img-src ${self} data:`,
    `font-src ${self}`,
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

function notFound(): Response {
  return new Response('Introuvable', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export function handleModProtocol(registry: ModRegistry, sdkDirectory: string, onError: (message: string, error: unknown) => void): void {
  protocol.handle(MOD_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method !== 'GET') return new Response('Méthode refusée', { status: 405 })
      const host = url.hostname
      let filePath: string | null
      let policy: string
      if (host === MOD_SDK_HOST) {
        filePath = resolveModFile(sdkDirectory, url.pathname)
        policy = "default-src 'none'"
      } else {
        const mod = registry.find(host)
        if (!mod?.enabled) return notFound()
        filePath = resolveModFile(mod.directoryPath, url.pathname)
        policy = modContentSecurityPolicy(mod.manifest.id)
      }
      if (!filePath) return notFound()
      const contentType = CONTENT_TYPES[extname(filePath).toLowerCase()]
      if (!contentType) return notFound()
      const body = await readFile(filePath)
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': contentType, 'Content-Security-Policy': policy, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
      })
    } catch (error) {
      onError(`aether-mod: ${request.url}`, error)
      return notFound()
    }
  })
}

export function sdkDirectoryFrom(resourcesDirectory: string): string {
  return join(resourcesDirectory, 'mods-sdk')
}
