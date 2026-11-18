/**
 * Hosts one mod panel in a sandboxed frame (opaque origin: no access to Aether, its storage or Node)
 * and answers its bridge requests, within the permissions the mod declared.
 */
import { useEffect, useMemo, useRef } from 'react'
import { BRIDGE_METHOD_PERMISSION, BRIDGE_TAG, bridgeRequestSchema, MOD_PROTOCOL, modPanelId, OPENABLE_BUILTIN_PANELS, slashCommandProblem, type AetherModEntry, type BridgeRequest, type ModConversation, type ModQuota, type PanelContext } from '../../../shared/aetherMods'
import { confirmAction } from '../components/ui'
import { useLayoutStore } from '../layout/layoutStore'
import { api, errorMessage } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { useComposerInsertStore } from './composerInsertStore'
import { recentModEvents, subscribeModEvents } from './modEventsStore'
import { useModsStore } from './modsStore'
import { useTokenUsageStore } from './tokenUsageStore'
import { LIMIT_LABELS } from '../../../shared/quota'
import type { QuotaState } from '../../../shared/domain'
import type { OrionOperation } from '../../../shared/orionConnect'

/** The limits as mods see them. */
function modQuota(quota: QuotaState): ModQuota {
  return {
    now: Date.now(),
    windows: quota.windows.map((window) => ({ kind: window.kind, label: LIMIT_LABELS[window.kind] ?? window.kind, utilizationPercent: window.utilizationPercent, resetsAt: window.resetsAt, status: window.status, observedAt: window.observedAt, source: window.source })),
    block: quota.block ? { kind: quota.block.limitKind, label: LIMIT_LABELS[quota.block.limitKind] ?? quota.block.limitKind, resetsAt: quota.block.resetsAt } : null,
    rateLimitsAvailable: quota.rateLimitsAvailable,
    lastCheckAt: quota.lastUsageCheckAt,
    error: quota.usageApiError ?? null
  }
}

/** Mods may ask Claude Code for fresh figures at most once a minute (all mods together). */
const QUOTA_REFRESH_MIN_MS = 60_000
let lastQuotaRefresh = 0

const DEFAULT_GIT_LIMIT = 300
const MAX_TOAST_LENGTH = 300
const MAX_INSERT_LENGTH = 20_000

function useActiveContext(mod: AetherModEntry, panelId: string): PanelContext {
  // Primitive selections, so the context only changes when what the panel sees changes.
  const conversationId = useAppStore((state) => state.activeConversationId)
  const title = useAppStore((state) => state.conversations.find((item) => item.id === state.activeConversationId)?.title ?? null)
  const workingDirectory = useAppStore((state) => state.conversations.find((item) => item.id === state.activeConversationId)?.workingDirectory ?? null)
  const theme = useAppStore((state) => (state.preferences?.theme === 'charcoal' ? 'charcoal' : 'forest'))
  const canRead = mod.manifest.permissions.includes('context.read') || mod.manifest.permissions.includes('git.read')
  return useMemo(
    () => ({
      modId: mod.manifest.id,
      panelId,
      conversation: canRead && conversationId && workingDirectory ? { id: conversationId, title: title ?? '', workingDirectory } : null,
      workingDirectory: canRead ? workingDirectory : null,
      theme
    }),
    [mod.manifest.id, panelId, conversationId, title, workingDirectory, canRead, theme]
  )
}

function listConversations(): ModConversation[] {
  const { conversations, runtimes } = useAppStore.getState()
  return conversations.map((conversation) => {
    const state = runtimes[conversation.id]?.runnerState
    return { id: conversation.id, title: conversation.title, workingDirectory: conversation.workingDirectory, busy: state === 'running' || state === 'starting', updatedAt: conversation.updatedAt }
  })
}

/** Answers one bridge request; throws a readable error. Permissions are already checked. */
async function answer(mod: AetherModEntry, request: BridgeRequest, current: PanelContext): Promise<unknown> {
  const params = request.params
  if (request.method.startsWith('orion.')) {
    // ORION CONNECT: the main process checks the permission again and talks to ORION; the frame never does.
    return api.invoke('mods:orion', { modId: mod.manifest.id, operation: request.method.slice('orion.'.length) as OrionOperation, params })
  }
  switch (request.method) {
    case 'context.get':
      return current
    case 'usage.get':
      return useTokenUsageStore.getState().snapshot()
    case 'quota.get':
      return modQuota(useAppStore.getState().quota)
    case 'quota.refresh': {
      if (Date.now() - lastQuotaRefresh >= QUOTA_REFRESH_MIN_MS) {
        lastQuotaRefresh = Date.now()
        const state = await api.invoke('usage:check-now')
        useAppStore.setState({ quota: state })
      }
      return modQuota(useAppStore.getState().quota)
    }
    case 'events.recent': {
      const limit = Number(params.limit)
      return recentModEvents(Number.isInteger(limit) && limit > 0 ? limit : 200)
    }
    case 'conversations.list':
      return listConversations()
    case 'git.log': {
      if (!current.workingDirectory) throw new Error('Aucune conversation ouverte.')
      const requested = Number(params.limit)
      const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 1000) : DEFAULT_GIT_LIMIT
      return api.invoke('mods:git-log', { modId: mod.manifest.id, workingDirectory: current.workingDirectory, limit })
    }
    case 'ui.toast': {
      const text = String(params.text ?? '').slice(0, MAX_TOAST_LENGTH)
      if (text.trim()) useAppStore.getState().toast({ tone: 'info', title: mod.manifest.name, body: text })
      return null
    }
    case 'composer.insert': {
      const conversationId = useAppStore.getState().activeConversationId
      if (!conversationId) throw new Error('Aucune conversation ouverte.')
      const text = String(params.text ?? '').slice(0, MAX_INSERT_LENGTH)
      if (!text) throw new Error('Texte vide.')
      useComposerInsertStore.getState().insert(conversationId, text, params.replace === true)
      return null
    }
    case 'panel.open': {
      const target = String(params.panel ?? '')
      const own = mod.manifest.panels.find((panel) => panel.id === target)
      if (own?.embed === 'page') {
        useAppStore.getState().navigate(`mod:${mod.manifest.id}:${own.id}`)
        return null
      }
      if (own?.embed) throw new Error('Ce panneau est intégré : il est déjà visible à son emplacement.')
      const panelId = own ? modPanelId(mod.manifest.id, own.id) : (OPENABLE_BUILTIN_PANELS as readonly string[]).includes(target) ? target : null
      if (!panelId) throw new Error(`Panneau inconnu : « ${target} » (les siens, ou ${OPENABLE_BUILTIN_PANELS.join(', ')}).`)
      const layout = useLayoutStore.getState()
      layout.open(panelId)
      layout.focus(panelId)
      return null
    }
    case 'command.run': {
      const text = String(params.text ?? '').trim()
      const problem = slashCommandProblem(text)
      if (problem) throw new Error(problem)
      // An Aether mod command (e.g. /arbo) only opens a panel: no confirmation needed.
      if (useModsStore.getState().runCommand(text)) return { sent: false, handledByAether: true }
      const state = useAppStore.getState()
      const conversationId = state.activeConversationId
      if (!conversationId) throw new Error('Aucune conversation ouverte.')
      const runnerState = state.runtimes[conversationId]?.runnerState
      if (runnerState === 'running' || runnerState === 'starting') throw new Error('Claude travaille déjà dans cette conversation : réessayez à la fin du tour.')
      const title = state.conversations.find((item) => item.id === conversationId)?.title ?? 'la conversation'
      const confirmed = await confirmAction({
        title: `Le mod « ${mod.manifest.name} » veut envoyer une commande`,
        message: (
          <span>
            Envoyer <code className="selectable rounded bg-sunken px-1 py-0.5 font-mono text-[12px] text-ink">{text}</code> à Claude dans « {title} » ?
          </span>
        ),
        confirmLabel: 'Envoyer'
      })
      if (!confirmed) return { sent: false, handledByAether: false }
      return { sent: await state.sendMessage(conversationId, text), handledByAether: false }
    }
  }
}

export function ModPanelFrame({ mod, panelId }: { mod: AetherModEntry; panelId: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const panel = mod.manifest.panels.find((item) => item.id === panelId)
  const context = useActiveContext(mod, panelId)
  const contextRef = useRef(context)
  contextRef.current = context
  // Bumped when the mod's files change on disk: the frame reloads with the new version.
  const version = useModsStore((state) => state.versions[mod.manifest.id] ?? 0)

  const post = (message: Record<string, unknown>): void => frameRef.current?.contentWindow?.postMessage({ tag: BRIDGE_TAG, ...message }, '*')

  // Live token usage and activity, for the panels allowed to read them.
  const readsUsage = mod.manifest.permissions.includes('usage.read')
  const readsEvents = mod.manifest.permissions.includes('events.read')
  useEffect(() => (readsUsage ? useTokenUsageStore.getState().subscribe((sample) => post({ event: 'usage', data: sample })) : undefined), [readsUsage])
  useEffect(() => (readsEvents ? subscribeModEvents((event) => post({ event: 'events', data: event })) : undefined), [readsEvents])
  const readsQuota = mod.manifest.permissions.includes('quota.read')
  useEffect(() => (readsQuota ? useAppStore.subscribe((state, previous) => state.quota !== previous.quota && post({ event: 'quota', data: modQuota(state.quota) })) : undefined), [readsQuota])

  // Tell the panel when the user switches conversation.
  useEffect(() => {
    post({ event: 'context', data: context })
  }, [context])

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const frameWindow = frameRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow) return
      const parsed = bridgeRequestSchema.safeParse(event.data)
      if (!parsed.success) return
      const request = parsed.data
      const reply = (payload: { ok: true; result: unknown } | { ok: false; error: string }) => frameWindow.postMessage({ tag: BRIDGE_TAG, requestId: request.requestId, ...payload }, '*')
      const permission = BRIDGE_METHOD_PERMISSION[request.method]
      if (permission && !mod.manifest.permissions.includes(permission)) {
        reply({ ok: false, error: `Permission « ${permission} » non déclarée par le mod.` })
        return
      }
      try {
        reply({ ok: true, result: (await answer(mod, request, contextRef.current)) ?? null })
      } catch (error) {
        reply({ ok: false, error: errorMessage(error) })
      }
    }
    const listener = (event: MessageEvent) => void onMessage(event)
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [mod])

  if (!panel) return <div className="p-4 text-[13px] text-danger">Panneau introuvable dans le mod {mod.manifest.name}.</div>
  return (
    <iframe
      key={version}
      ref={frameRef}
      title={`${mod.manifest.name} — ${panel.title}`}
      src={`${MOD_PROTOCOL}://${mod.manifest.id}/${panel.entry}${version ? `?v=${version}` : ''}`}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block h-full w-full border-0 bg-[#121513]"
      onLoad={() => post({ event: 'context', data: contextRef.current })}
    />
  )
}
