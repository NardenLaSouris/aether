/**
 * ChatGPT panel: chatgpt.com in an isolated <webview> (its own session on this PC, no access to Aether).
 * The user signs in on OpenAI's own page; Aether never reads the account, cookies or conversations.
 */
import { ArrowLeft, ArrowRight, ExternalLink, Home, RotateCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorMessage } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { IconButton, Spinner } from './ui'

export const CHATGPT_PANEL_ID = 'chatgpt'
const CHATGPT_HOME = 'https://chatgpt.com/'
const CHATGPT_PARTITION = 'persist:chatgpt'

/** The few <webview> methods used here. */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
}

export function ChatGptPanel() {
  const containerRef = useRef<HTMLDivElement>(null)
  const webviewRef = useRef<WebviewElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [navigation, setNavigation] = useState({ back: false, forward: false })
  const toast = useAppStore((state) => state.toast)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Created by hand so the isolated session is set before the first page loads.
    const webview = document.createElement('webview') as WebviewElement
    webview.setAttribute('partition', CHATGPT_PARTITION)
    webview.setAttribute('allowpopups', '')
    webview.setAttribute('src', CHATGPT_HOME)
    webview.setAttribute('aria-label', 'ChatGPT')
    webview.className = 'absolute inset-0 h-full w-full'
    const refreshNavigation = () => {
      try {
        setNavigation({ back: webview.canGoBack(), forward: webview.canGoForward() })
      } catch {
        // not attached yet
      }
    }
    const onStart = () => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = () => {
      setLoading(false)
      refreshNavigation()
    }
    const onFail = (event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean }
      // -3 = aborted (a redirect, or a link sent to the browser): not an error for the user.
      if (detail.isMainFrame === false || detail.errorCode === -3) return
      setFailure(detail.errorDescription || 'Page indisponible')
      setLoading(false)
    }
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    webview.addEventListener('did-navigate', refreshNavigation)
    webview.addEventListener('did-navigate-in-page', refreshNavigation)
    webview.addEventListener('did-fail-load', onFail)
    container.appendChild(webview)
    webviewRef.current = webview
    return () => {
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', onStop)
      webview.removeEventListener('did-navigate', refreshNavigation)
      webview.removeEventListener('did-navigate-in-page', refreshNavigation)
      webview.removeEventListener('did-fail-load', onFail)
      webview.remove()
      webviewRef.current = null
    }
  }, [])

  const openApp = async () => {
    try {
      const result = await api.invoke('apps:open-chatgpt')
      if (result.openedIn === 'browser') toast({ tone: 'info', title: 'ChatGPT ouvert dans le navigateur', body: 'L’application ChatGPT n’est pas installée.' })
    } catch (error) {
      toast({ tone: 'error', title: 'ChatGPT n’a pas pu être ouvert', body: errorMessage(error) })
    }
  }

  return (
    <div className="flex h-full flex-col bg-[#121513]">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <IconButton label="Page précédente" disabled={!navigation.back} onClick={() => webviewRef.current?.goBack()}>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <IconButton label="Page suivante" disabled={!navigation.forward} onClick={() => webviewRef.current?.goForward()}>
          <ArrowRight className="size-3.5" />
        </IconButton>
        <IconButton label="Recharger" onClick={() => webviewRef.current?.reload()}>
          <RotateCw className="size-3.5" />
        </IconButton>
        <IconButton label="Accueil ChatGPT" onClick={() => void webviewRef.current?.loadURL(CHATGPT_HOME)}>
          <Home className="size-3.5" />
        </IconButton>
        {loading && <Spinner className="ml-1 size-3.5" />}
        <span className="ml-1 min-w-0 flex-1 truncate text-[11px] text-ink-faint" title="Session isolée sur ce PC : Aether n’a pas accès à votre compte OpenAI">
          Session ChatGPT isolée sur ce PC
        </span>
        <IconButton label="Ouvrir dans l’application ChatGPT" onClick={() => void openApp()}>
          <ExternalLink className="size-3.5" />
        </IconButton>
      </div>
      <div ref={containerRef} className="relative min-h-0 flex-1">
        {failure && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[#121513] p-6 text-center text-[13px] text-ink-muted">
            <p>ChatGPT n’a pas pu être chargé : {failure}</p>
            <button type="button" onClick={() => webviewRef.current?.reload()} className="rounded-md border border-line-strong px-3 py-1.5 text-ink hover:bg-white/5">
              Réessayer
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
