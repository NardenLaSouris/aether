/**
 * Claude's own requests to the user, drawn the way Claude Code draws them:
 * its questions (AskUserQuestion) and the approval of its plan (ExitPlanMode).
 */
import { ClipboardList, MessageCircleQuestion } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { PermissionRequest } from '../../../shared/domain'
import { useAppStore } from '../stores/appStore'
import { buildAnswers, readPlan, readQuestions } from '../../../shared/claudeRequests'
import { Markdown } from './Markdown'
import { Badge, Button, classNames, Dialog } from './ui'

function RequestHeader({ request }: { request: PermissionRequest }) {
  const conversation = useAppStore((state) => state.conversations.find((candidate) => candidate.id === request.conversationId))
  const openConversation = useAppStore((state) => state.openConversation)
  if (!conversation) return null
  return (
    <button type="button" className="text-xs text-ink-faint hover:text-ink" onClick={() => void openConversation(conversation.id)}>
      Conversation : <span className="text-ink-muted">{conversation.title}</span>
    </button>
  )
}

export function QuestionDialog({ request, waiting }: { request: PermissionRequest; waiting: number }) {
  const decide = useAppStore((state) => state.decidePermission)
  const questions = useMemo(() => readQuestions(request.input), [request.input])
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [focused, setFocused] = useState<Record<number, string>>({})
  useEffect(() => {
    setSelected({})
    setOther({})
    setFocused({})
  }, [request.requestId])
  const answers = buildAnswers(questions, selected, other)

  const pick = (index: number, label: string, multi: boolean): void => {
    setFocused((previous) => ({ ...previous, [index]: label }))
    setSelected((previous) => {
      const current = previous[index] ?? []
      if (!multi) return { ...previous, [index]: [label] }
      return { ...previous, [index]: current.includes(label) ? current.filter((item) => item !== label) : [...current, label] }
    })
    if (!multi) setOther((previous) => ({ ...previous, [index]: '' }))
  }

  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => undefined}
      width="max-w-2xl"
      title={
        <span className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-gold" />
          Claude vous pose {questions.length > 1 ? `${questions.length} questions` : 'une question'}
          {waiting > 0 && <Badge tone="gold">+{waiting} en attente</Badge>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={() => void decide(request.requestId, false, 'L’utilisateur a préféré ne pas répondre à ces questions. Continue sans ces réponses ou demande-lui autrement.')}>
            Ne pas répondre
          </Button>
          <Button variant="primary" disabled={!answers} onClick={() => answers && void decide(request.requestId, true, undefined, answers)}>
            Répondre
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-[13px]">
        <RequestHeader request={request} />
        {questions.length === 0 && <p className="text-danger">Question illisible : Claude a envoyé un format inattendu. Répondez « Ne pas répondre » puis écrivez-lui directement.</p>}
        {questions.map((question, index) => {
          const chosen = selected[index] ?? []
          const preview = question.options.find((option) => option.label === (focused[index] ?? chosen[0]))?.preview
          return (
            <section key={question.question} className="space-y-2">
              <div className="flex items-start gap-2">
                {question.header && <Badge tone="gold">{question.header}</Badge>}
                <span className="selectable font-medium text-ink">{question.question}</span>
              </div>
              {question.multiSelect && <div className="text-[11.5px] text-ink-faint">Plusieurs choix possibles.</div>}
              <div className="grid gap-1.5">
                {question.options.map((option) => {
                  const active = chosen.includes(option.label)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={question.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={active}
                      onClick={() => pick(index, option.label, question.multiSelect)}
                      onFocus={() => setFocused((previous) => ({ ...previous, [index]: option.label }))}
                      onMouseEnter={() => setFocused((previous) => ({ ...previous, [index]: option.label }))}
                      className={classNames('flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors', active ? 'border-gold/60 bg-accent-soft' : 'border-line bg-sunken hover:border-line-strong')}
                    >
                      <span className={classNames('mt-0.5 flex size-3.5 shrink-0 items-center justify-center border', question.multiSelect ? 'rounded-[3px]' : 'rounded-full', active ? 'border-gold bg-gold' : 'border-ink-faint')}>{active && <span className={classNames('bg-charcoal', question.multiSelect ? 'size-1.5 rounded-[1px]' : 'size-1.5 rounded-full')} />}</span>
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{option.label}</span>
                        {option.description && <span className="block text-[12px] text-ink-muted">{option.description}</span>}
                      </span>
                    </button>
                  )
                })}
                <input
                  value={other[index] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    setOther((previous) => ({ ...previous, [index]: value }))
                    if (!question.multiSelect && value.trim()) setSelected((previous) => ({ ...previous, [index]: [] }))
                  }}
                  placeholder="Autre réponse…"
                  aria-label={`Autre réponse à : ${question.question}`}
                  className="h-9 rounded-md border border-line bg-sunken px-3 text-[13px] outline-none placeholder:text-ink-faint focus:border-gold/50"
                />
              </div>
              {preview && <pre className="selectable max-h-56 overflow-auto rounded-md border border-line bg-black/25 p-2.5 font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{preview}</pre>}
            </section>
          )
        })}
      </div>
    </Dialog>
  )
}

export function PlanDialog({ request, waiting }: { request: PermissionRequest; waiting: number }) {
  const decide = useAppStore((state) => state.decidePermission)
  const setMode = useAppStore((state) => state.setConversationPermissionMode)
  const [feedback, setFeedback] = useState('')
  useEffect(() => setFeedback(''), [request.requestId])
  const plan = readPlan(request.input)
  const approve = async (autoAcceptEdits: boolean): Promise<void> => {
    await decide(request.requestId, true)
    if (autoAcceptEdits) await setMode(request.conversationId, 'acceptEdits')
  }
  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => undefined}
      width="max-w-3xl"
      title={
        <span className="flex items-center gap-2">
          <ClipboardList className="size-4 text-gold" />
          Claude propose un plan
          {waiting > 0 && <Badge tone="gold">+{waiting} en attente</Badge>}
        </span>
      }
      footer={
        <>
          <input value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Ce qu’il faut changer dans le plan…" aria-label="Changements demandés" className="mr-auto h-9 min-w-0 flex-1 rounded-md border border-line bg-sunken px-2.5 text-[12.5px] outline-none focus:border-gold/50" />
          <Button variant="subtle" disabled={!feedback.trim()} onClick={() => void decide(request.requestId, false, `L’utilisateur veut que tu continues à planifier. Ses remarques : ${feedback.trim()}`)}>
            Revoir le plan
          </Button>
          <Button variant="subtle" onClick={() => void approve(true)} title="Approuve le plan et passe la conversation en « Accepter les modifications »">
            Approuver + modifs auto
          </Button>
          <Button variant="primary" autoFocus onClick={() => void approve(false)}>
            Approuver
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <RequestHeader request={request} />
        <div className="selectable max-h-[55vh] overflow-auto rounded-md border border-line bg-sunken px-4 py-3">{plan ? <Markdown text={plan} /> : <p className="text-ink-muted">Claude n’a pas joint le texte du plan (il est peut-être dans un fichier de plan). Approuvez pour qu’il commence, ou demandez-lui des changements.</p>}</div>
      </div>
    </Dialog>
  )
}
