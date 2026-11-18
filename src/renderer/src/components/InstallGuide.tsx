import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { Button } from './ui'

/** Shown when the Claude Code CLI cannot be found. Aether never installs it silently. */
export function InstallGuide({ compact = false }: { compact?: boolean }) {
  const refresh = useAppStore((state) => state.refreshEnvironment)
  const navigate = useAppStore((state) => state.navigate)
  const installation = useAppStore((state) => state.installation)
  return (
    <div className="space-y-3 text-[13px]">
      <div className="flex items-start gap-2 text-warning">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>Claude Code n’a pas été trouvé sur cette machine. Aether utilise le moteur officiel et ne fonctionne pas sans lui.</span>
      </div>
      {installation?.error && <div className="font-mono text-[11px] text-ink-faint">{installation.error}</div>}
      <ol className="list-decimal space-y-1.5 pl-5 text-ink-muted">
        <li>
          Ouvrez PowerShell et lancez l’installateur officiel :
          <pre className="selectable mt-1 rounded bg-sunken px-2.5 py-1.5 font-mono text-[12px] text-cream">irm https://claude.ai/install.ps1 | iex</pre>
        </li>
        {!compact && <li>Vérifiez l’installation avec <code className="font-mono text-cream">claude --version</code> dans un nouveau terminal.</li>}
        <li>Revenez ici et cliquez sur « Détecter à nouveau ». Si Claude Code est installé ailleurs, indiquez son chemin dans Paramètres › Moteur.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />} onClick={() => void refresh()}>
          Détecter à nouveau
        </Button>
        <Button size="sm" variant="ghost" icon={<ExternalLink className="size-3.5" />} onClick={() => void api.invoke('shell:open-external', { url: 'https://code.claude.com/docs/en/setup' })}>
          Documentation officielle
        </Button>
        {compact && (
          <Button size="sm" variant="ghost" onClick={() => navigate('settings')}>
            Chemin personnalisé
          </Button>
        )}
      </div>
    </div>
  )
}
