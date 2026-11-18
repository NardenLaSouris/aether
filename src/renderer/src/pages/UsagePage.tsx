import { AlertTriangle, Gauge, Hourglass, Info, RefreshCw, ShieldAlert, Unlock } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { SubscriptionWindow, TokenUsageTotals } from '../../../shared/domain'
import type { UsageSummary } from '../../../shared/ipcContract'
import { LIMIT_LABELS, evaluateBlock, formatDuration, statusLabel } from '../../../shared/quota'
import { useNow } from '../components/workspace'
import { Badge, Button, Card, classNames, confirmAction, Spinner } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, formatRelative, formatSeconds, formatTokens, formatUsd } from '../lib/format'
import { useAppStore } from '../stores/appStore'

function WindowMeter({ window, now }: { window: SubscriptionWindow; now: number }) {
  const percent = window.utilizationPercent
  const tone = percent === null ? 'bg-ink-faint' : percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-sage'
  return (
    <div className="rounded-md border border-line bg-sunken px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{LIMIT_LABELS[window.kind]}</span>
        <Badge tone={window.status === 'rejected' ? 'danger' : window.status === 'allowed_warning' ? 'warning' : 'neutral'}>{statusLabel(window.status)}</Badge>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-2xl">{percent === null ? '—' : `${Math.round(percent)} %`}</span>
        <span className="text-[11px] text-ink-faint">{percent === null ? 'utilisation non communiquée' : 'de la limite utilisée'}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/6" role="meter" aria-valuenow={percent ?? undefined} aria-valuemin={0} aria-valuemax={100}>
        <div className={classNames('h-full rounded-full transition-all', tone)} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </div>
      <div className="mt-2 text-[11.5px] text-ink-faint">
        {window.resetsAt ? (
          <>
            Réinitialisation {formatDateTime(window.resetsAt)}
            {window.resetsAt > now && <> · dans {formatDuration(window.resetsAt - now)}</>}
          </>
        ) : (
          'Heure de réinitialisation non communiquée'
        )}
      </div>
      <div className="mt-1 text-[10.5px] text-ink-faint/80">
        Source : {window.source === 'usage_api' ? 'API d’usage du SDK (expérimentale)' : window.source === 'rate_limit_event' ? 'événement rate_limit du moteur' : 'message d’erreur'} · {formatRelative(window.observedAt)}
      </div>
    </div>
  )
}

function TotalsTile({ label, totals }: { label: string; totals: TokenUsageTotals }) {
  return (
    <div className="rounded-md border border-line bg-sunken px-4 py-3">
      <div className="text-[11px] tracking-wide text-ink-faint uppercase">{label}</div>
      <div className="mt-1 font-display text-xl">{formatTokens(totals.inputTokens + totals.outputTokens)} <span className="text-xs text-ink-faint">tokens</span></div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11.5px] text-ink-muted">
        <span>Entrée : {formatTokens(totals.inputTokens)}</span>
        <span>Sortie : {formatTokens(totals.outputTokens)}</span>
        <span>Cache lu : {formatTokens(totals.cacheReadInputTokens)}</span>
        <span>Cache écrit : {formatTokens(totals.cacheCreationInputTokens)}</span>
      </div>
      <div className="mt-1 text-[11px] text-ink-faint">
        {totals.turns} tour{totals.turns > 1 ? 's' : ''} · coût estimé {formatUsd(totals.estimatedCostUsd)}
      </div>
    </div>
  )
}

export function UsagePage() {
  const quota = useAppStore((state) => state.quota)
  const auth = useAppStore((state) => state.auth)
  const toast = useAppStore((state) => state.toast)
  const now = useNow(1000)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [checking, setChecking] = useState(false)

  const load = useCallback(async () => {
    setSummary(await api.invoke('usage:get-summary'))
  }, [])

  useEffect(() => {
    void load()
  }, [load, quota])

  const checkNow = async (): Promise<void> => {
    setChecking(true)
    try {
      await api.invoke('usage:check-now')
      await load()
    } catch (error) {
      toast({ tone: 'error', title: 'Vérification impossible', body: errorMessage(error) })
    } finally {
      setChecking(false)
    }
  }

  const evaluation = evaluateBlock(quota.block, now)
  const isApiKey = auth?.authMethod && auth.authMethod !== 'claude.ai'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-8 py-8">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-semibold">Consommation et quotas</h1>
          {summary?.subscriptionType && <Badge tone="gold">Abonnement {summary.subscriptionType}</Badge>}
          <div className="flex-1" />
          {quota.lastUsageCheckAt && <span className="text-[11px] text-ink-faint">Dernière vérification {formatRelative(quota.lastUsageCheckAt)}</span>}
          <Button variant="secondary" icon={checking ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} disabled={checking} onClick={() => void checkNow()}>
            Vérifier maintenant
          </Button>
        </div>

        {quota.block && evaluation.blocked && (
          <div className="flex items-start gap-3 rounded-lg border border-warning/35 bg-warning/8 px-5 py-4">
            <Hourglass className="mt-0.5 size-5 text-warning" />
            <div className="flex-1">
              <div className="font-display text-[15px] font-semibold text-warning">Envois suspendus — {LIMIT_LABELS[quota.block.limitKind]}</div>
              <div className="selectable mt-1 text-[13px] text-ink-muted">{quota.block.message}</div>
              <div className="mt-2 text-[13px]">
                {evaluation.millisecondsRemaining !== null ? (
                  <>
                    Reprise automatique dans <span className="font-mono text-lg text-cream">{formatDuration(evaluation.millisecondsRemaining)}</span> — {formatDateTime(quota.block.resetsAt ?? 0)}
                  </>
                ) : (
                  <>
                    Heure de réinitialisation inconnue.{' '}
                    {quota.nextAutomaticCheckAt ? `Vérification automatique ${formatDateTime(quota.nextAutomaticCheckAt)} via l’interface officielle (sans envoyer de requête au modèle).` : ''}
                  </>
                )}
              </div>
              <div className="mt-1 text-[11px] text-ink-faint">Détecté {formatRelative(quota.block.detectedAt)} · source : {quota.block.source}. Les conversations restent consultables. Aucune requête refusée n’est renvoyée automatiquement.</div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon={<Unlock className="size-3.5" />}
              onClick={async () => {
                const confirmed = await confirmAction({ title: 'Réactiver les envois ?', message: 'Les envois seront réautorisés sans confirmation officielle de la réinitialisation. Si la limite est toujours active, Claude Code refusera la prochaine requête.', confirmLabel: 'Réactiver' })
                if (confirmed) await api.invoke('usage:clear-block')
              }}
            >
              Réactiver manuellement
            </Button>
          </div>
        )}

        <Card title={<span className="flex items-center gap-2"><Gauge className="size-4 text-sage" />Limites de l’abonnement Claude</span>}>
          {quota.windows.filter((window) => window.kind !== 'api_rate_limit').length > 0 ? (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {quota.windows
                .filter((window) => window.kind !== 'api_rate_limit')
                .map((window) => (
                  <WindowMeter key={window.kind} window={window} now={now} />
                ))}
            </div>
          ) : (
            <div className="flex items-start gap-2 text-[13px] text-ink-muted">
              <Info className="mt-0.5 size-4 shrink-0 text-info" />
              <div>
                {quota.rateLimitsAvailable === false || isApiKey ? (
                  <>Quota non disponible via l’interface officielle pour ce compte (les limites d’abonnement ne s’appliquent pas aux clés API, Bedrock ou Vertex).</>
                ) : (
                  <>Quota non disponible via l’interface officielle pour le moment. Les valeurs apparaîtront dès que Claude Code les communiquera (événements de limite pendant une conversation, ou « Vérifier maintenant »).</>
                )}
                {quota.usageApiError && <div className="mt-1 font-mono text-[11px] text-ink-faint">Erreur de lecture : {quota.usageApiError}</div>}
              </div>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-faint">Les pourcentages proviennent exclusivement de Claude Code. Ils ne sont jamais calculés à partir du nombre de tokens. La lecture « Vérifier maintenant » utilise une API du SDK marquée expérimentale par Anthropic et peut évoluer.</p>
        </Card>

        <Card title={<span className="flex items-center gap-2"><ShieldAlert className="size-4 text-sage" />Tokens consommés par les requêtes (mesurés par {useAppStore.getState().appName})</span>}>
          {summary ? (
            <div className="grid grid-cols-3 gap-3">
              <TotalsTile label="Aujourd’hui" totals={summary.totals.today} />
              <TotalsTile label="7 derniers jours" totals={summary.totals.sevenDays} />
              <TotalsTile label="Total" totals={summary.totals.allTime} />
            </div>
          ) : (
            <Spinner />
          )}
          <p className="mt-3 text-[11px] text-ink-faint">Totaux des tours exécutés depuis Aether, d’après les messages « result » de Claude Code (boucle principale). Le coût est une estimation de Claude Code, pas une facture, et n’est pas connu pour le premier tour d’une session reprise. Ces nombres sont indépendants des limites d’abonnement ci-dessus.</p>
        </Card>

        <div className="grid grid-cols-2 gap-5">
          <Card title="Derniers tours">
            {summary && summary.recentUsage.length === 0 && <div className="text-xs text-ink-faint">Aucun tour enregistré.</div>}
            <table className="w-full text-left text-[12px]">
              <tbody>
                {summary?.recentUsage.slice(0, 25).map((event) => (
                  <tr key={event.id} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5 pr-2 text-ink-faint">{formatRelative(event.createdAt)}</td>
                    <td className="max-w-40 truncate py-1.5 pr-2 font-mono text-[11px]">{event.model ?? '—'}</td>
                    <td className="py-1.5 pr-2">{formatTokens(event.inputTokens)} / {formatTokens(event.outputTokens)}</td>
                    <td className="py-1.5 pr-2 text-ink-faint">{formatSeconds(event.durationMs)}</td>
                    <td className="py-1.5">{event.isError ? <AlertTriangle className="size-3.5 text-danger" /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="Historique des événements de quota">
            {summary && summary.quotaEvents.length === 0 && <div className="text-xs text-ink-faint">Aucun événement.</div>}
            <ul className="space-y-1.5 text-[12px]">
              {summary?.quotaEvents.slice(0, 25).map((event) => (
                <li key={event.id} className="flex gap-2 border-b border-line/60 pb-1.5 last:border-0">
                  <span className="w-24 shrink-0 text-ink-faint">{formatRelative(event.createdAt)}</span>
                  <span className="flex-1">
                    {{ limit_detected: 'Limite atteinte', warning: 'Avertissement', reset_confirmed: 'Réinitialisation confirmée', reset_time_reached: 'Heure de reprise atteinte', check: 'Vérification', cleared_manually: 'Réactivation manuelle' }[event.eventType]}
                    {event.limitKind && <span className="text-ink-faint"> · {LIMIT_LABELS[event.limitKind as keyof typeof LIMIT_LABELS] ?? event.limitKind}</span>}
                    {event.resetsAt && <span className="text-ink-faint"> · reprise {formatDateTime(event.resetsAt)}</span>}
                    {event.eventType === 'check' && event.status === 'not_available' && <span className="text-ink-faint"> · non disponible</span>}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
