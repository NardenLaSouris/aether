/**
 * ChatGPT inside Aether: a <webview> showing chatgpt.com in its own isolated session
 * (persist:chatgpt), separate from Aether's renderer and from the mod panels.
 *
 * - The user signs in on OpenAI's own pages; Aether never reads credentials, cookies or page content.
 * - The view may only show chatgpt.com and the official sign-in pages; any other link opens in the
 *   user's browser. It gets no preload, no Node.js, no permission besides writing to the clipboard.
 */
import { app, session, shell, type BrowserWindow, type Session, type WebContents, type WebPreferences } from 'electron'

export const CHATGPT_PARTITION = 'persist:chatgpt'
export const CHATGPT_HOME = 'https://chatgpt.com/'

const CHATGPT_HOSTS = ['chatgpt.com', 'openai.com']
/** Official sign-in pages ChatGPT may send the user to (OpenAI account, or "continue with Google/Microsoft/Apple"). */
const SIGN_IN_HOSTS = ['accounts.google.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com']

function hostMatches(hostname: string, allowed: string[]): boolean {
  return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

/** Pages the ChatGPT view may display itself. */
export function isChatGptViewUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (hostMatches(parsed.hostname, CHATGPT_HOSTS) || hostMatches(parsed.hostname, SIGN_IN_HOSTS))
  } catch {
    return url === 'about:blank'
  }
}

/** The only address a ChatGPT <webview> may be created with. */
export function isChatGptStartUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'chatgpt.com'
  } catch {
    return false
  }
}

function chatGptSession(): Session {
  return session.fromPartition(CHATGPT_PARTITION)
}

/** Once at startup: permissions and a regular browser user agent for the ChatGPT session. */
export function configureChatGptSession(): void {
  const chatSession = chatGptSession()
  chatSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
  chatSession.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write')
  // Sign-in pages refuse unknown embedded browsers: present the Chromium the view really is, without the Electron/Aether tokens.
  const userAgent = chatSession.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(new RegExp(`\\s?${app.getName()}\\/\\S+`, 'i'), '')
  chatSession.setUserAgent(userAgent)
}

/** Hardens a ChatGPT <webview> before it attaches; refuses any other <webview>. */
export function prepareWebview(webPreferences: WebPreferences, params: Record<string, string>): boolean {
  if (!isChatGptStartUrl(params.src ?? '') || params.partition !== CHATGPT_PARTITION) return false
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.partition = CHATGPT_PARTITION
  return true
}

/** Navigation rules for the attached ChatGPT view (and its sign-in pop-ups). */
export function guardChatGptContents(contents: WebContents, parent: BrowserWindow | null): void {
  const openOutside = (url: string) => {
    try {
      if (new URL(url).protocol === 'https:') void shell.openExternal(url)
    } catch {
      // not a URL: ignored
    }
  }
  contents.on('will-navigate', (event, url) => {
    if (isChatGptViewUrl(url)) return
    event.preventDefault()
    openOutside(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isChatGptViewUrl(url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    // "Continue with Google/Microsoft/Apple" pop-ups stay in the same isolated session.
    if (isChatGptViewUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(parent ? { parent } : {}),
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#121513',
          webPreferences: { partition: CHATGPT_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }
        }
      }
    }
    openOutside(url)
    return { action: 'deny' }
  })
  contents.on('did-create-window', (child) => guardChatGptContents(child.webContents, parent))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}
