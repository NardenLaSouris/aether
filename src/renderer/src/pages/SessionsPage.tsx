import { FolderX, GitBranch, History, Info, Link2, Play, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, Button, EmptyState, Spinner } from '../components/ui'
import { formatDateTime, formatRelative } from '../lib/format'
import { useAppStore } from '../stores/appStore'

export function SessionsPage() {
  const sessions = useAppStore((state) => state.sessions)
  const loading = useAppStore((state) => state.sessionsLoading)
  const error = useAppStore((state) => state.sessionsError)
  const refreshedAt = useAppStore((state) => state.sessionsRefreshedAt)
  const loadSessions = useAppStore((state) => state.loadSessions)
  const openSession = useAppStore((state) => state.openSession)
  const openConversation = useAppStore((state) => state.openConversation)
  const installation = useAppStore((state) => state.installation)
  const [query, setQuery] = useState('')
  const [directoryFilter, setDirectoryFilter] = useState<string>('')

  const directories = useMemo(() => [...new Set(sessions.map((session) => session.cwd).filter((cwd): cwd is string => Boolean(cwd)))].sort(), [sessions])
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return sessions.filter((session) => {
      if (directoryFilter && session.cwd !== directoryFilter) return false
      if (!needle) return true
      return [session.summary, session.customTitle, session.firstPrompt, session.cwd, session.gitBranch, session.sessionId].some((value) => value?.toLowerCase().includes(needle))
    })
  }, [sessions, query, directoryFilter])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-8 pt-7 pb-4">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold">Sessions Claude Code</h1>
          <Badge>{sessions.length}</Badge>
          <div className="flex-1" />
          {refreshedAt > 0 && <span className="text-[11px] text-ink-faint">Actualisé {formatRelative(refreshedAt)}</span>}
          <Button variant="secondary" icon={loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} onClick={() => void loadSessions(true)} disabled={loading || !installation?.found}>
            Actualiser
          </Button>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-md border border-info/20 bg-info/6 px-3 py-2 text-xs text-ink-muted">
          <Info className="mt-0.5 size-3.5 shrink-0 text-info" />
          <span>
            Sessions lues en lecture seule dans le stockage local de Claude Code via l’API officielle du SDK (<code className="font-mono">listSessions</code>). La reprise utilise le mécanisme officiel <code className="font-mono">resume</code> : le contexte complet est conservé par Claude Code, et les fichiers d’origine ne sont jamais modifiés par Aether. Les conversations de l’application Claude Desktop ou de claude.ai (hors Claude Code) ne sont pas accessibles par ces interfaces et n’apparaissent pas ici.
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <div className="flex flex-1 items-center gap-2 rounded-md border border-line bg-sunken px-2.5 focus-within:border-gold/40">
            <Search className="size-3.5 text-ink-faint" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher par titre, dossier, branche, identifiant…" className="h-8 w-full bg-transparent text-[13px] outline-none placeholder:text-ink-faint" />
          </div>
          <select value={directoryFilter} onChange={(event) => setDirectoryFilter(event.target.value)} className="h-8.5 max-w-72 rounded-md border border-line bg-sunken px-2 text-[12.5px] text-ink outline-none">
            <option value="">Tous les dossiers</option>
            {directories.map((directory) => (
              <option key={directory} value={directory}>
                {directory}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-8 py-4">
        {error && <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">Découverte impossible : {error}</div>}
        {loading && sessions.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-16 text-xs text-ink-faint">
            <Spinner /> Lecture des sessions locales…
          </div>
        )}
        {!loading && filtered.length === 0 && <EmptyState icon={<History className="size-5" />} title={sessions.length === 0 ? 'Aucune session trouvée' : 'Aucun résultat'} description={sessions.length === 0 ? 'Aucune session Claude Code n’a été trouvée dans le stockage local de ce compte Windows.' : undefined} />}
        <ul className="space-y-1.5">
          {filtered.map((session) => (
            <li key={session.sessionId} className="group flex items-center gap-4 rounded-md border border-line bg-panel/70 px-4 py-2.5 hover:border-line-strong">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{session.customTitle || session.summary}</span>
                  {session.linkedConversationId && (
                    <Badge tone="sage">
                      <Link2 className="size-3" /> liée
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-[11.5px] text-ink-faint">
                  <span className="truncate font-mono" title={session.cwd}>
                    {session.cwd ?? 'dossier inconnu'}
                  </span>
                  {session.gitBranch && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="size-3" />
                      {session.gitBranch}
                    </span>
                  )}
                  {!session.cwdExists && (
                    <span className="flex items-center gap-1 text-warning">
                      <FolderX className="size-3" /> dossier absent
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right text-[11px] text-ink-faint" title={formatDateTime(session.lastModified)}>
                <div>{formatRelative(session.lastModified)}</div>
                <div className="selectable font-mono opacity-60">{session.sessionId.slice(0, 8)}</div>
              </div>
              {session.linkedConversationId ? (
                <Button size="sm" variant="secondary" onClick={() => void openConversation(session.linkedConversationId ?? '')}>
                  Ouvrir
                </Button>
              ) : (
                <Button size="sm" variant="subtle" icon={<Play className="size-3" />} disabled={!session.cwdExists} title={session.cwdExists ? 'Reprendre cette session' : 'Le dossier de travail n’existe plus : reprise impossible'} onClick={() => void openSession(session.sessionId)}>
                  Reprendre
                </Button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
