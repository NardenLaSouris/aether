/**
 * Main window with hardened webPreferences, a strict CSP and blocked navigation.
 */
import { BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MOD_PROTOCOL } from '../shared/aetherMods'
import { guardChatGptContents, prepareWebview } from './chatgptView'
import { APP_CONFIG } from '../shared/appConfig'
import { isAllowedExternalUrl } from './services/pathGuard'

export const DEV_SERVER_URL = process.env.ELECTRON_RENDERER_URL ?? null

export function rendererIndexPath(): string {
  return join(__dirname, '../renderer/index.html')
}

export function rendererFileUrlPrefix(): string {
  return pathToFileURL(join(__dirname, '../renderer')).href
}

function contentSecurityPolicy(): string {
  const devSources = DEV_SERVER_URL ? ` ${new URL(DEV_SERVER_URL).origin} ws://${new URL(DEV_SERVER_URL).host}` : ''
  return [
    "default-src 'self'",
    `script-src 'self'${DEV_SERVER_URL ? " 'unsafe-inline'" + devSources : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${devSources}`,
    "object-src 'none'",
    // Mod panels only, from their own sandboxed protocol.
    `frame-src ${MOD_PROTOCOL}:`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export function installSecurityPolicies(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Mod files carry their own, stricter policy (set by the aether-mod protocol).
    if (details.url.startsWith(`${MOD_PROTOCOL}:`)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [contentSecurityPolicy()] } })
  })
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'notifications' || permission === 'clipboard-sanitized-write')
  })
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: false,
    title: APP_CONFIG.name,
    backgroundColor: '#121513',
    // Windows: multi-size .ico, so the taskbar and Alt+Tab use a sharp version of the logo.
    icon: join(__dirname, process.platform === 'win32' ? '../../resources/icon.ico' : '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Only for the ChatGPT panel: every <webview> is checked and hardened in will-attach-webview.
      webviewTag: true
    }
  })

  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith(rendererFileUrlPrefix())
    if (!allowed) {
      event.preventDefault()
      if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    }
  })
  // The only <webview> allowed is the ChatGPT panel (chatgpt.com, isolated session, no preload).
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!prepareWebview(webPreferences, params)) event.preventDefault()
  })
  window.webContents.on('did-attach-webview', (_event, guest) => guardChatGptContents(guest, window))
  // A mod panel frame may only show its own mod's pages.
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (!event.url.startsWith(`${MOD_PROTOCOL}://`)) event.preventDefault()
  })

  if (DEV_SERVER_URL) void window.loadURL(DEV_SERVER_URL)
  else void window.loadFile(rendererIndexPath())
  return window
}
