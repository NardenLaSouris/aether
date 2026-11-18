/**
 * What the message box adds to plain text: pasted images, `@file` mentions and the thinking effort.
 */
import { AtSign, FileText, X } from 'lucide-react'
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type RefObject } from 'react'
import { MAX_IMAGES_PER_MESSAGE, type EffortLevel, type MessageImage } from '../../../shared/domain'
import { findMentionQuery, imageFromDataUrl, insertMention } from '../../../shared/composer'
import { api } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { classNames } from './ui'

export type Attachment = MessageImage & { id: string; preview: string }

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('lecture impossible'))
    reader.readAsDataURL(file)
  })
}

/** Images pasted or dropped in the message box. */
export function useImageAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const toast = useAppStore((state) => state.toast)

  const addFiles = async (files: File[]): Promise<void> => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    for (const file of images) {
      const room = MAX_IMAGES_PER_MESSAGE - attachments.length
      if (room <= 0) {
        toast({ tone: 'warning', title: 'Images', body: `${MAX_IMAGES_PER_MESSAGE} images au plus par message.` })
        return
      }
      try {
        const dataUrl = await readAsDataUrl(file)
        const parsed = imageFromDataUrl(dataUrl)
        if (!parsed.ok) {
          toast({ tone: 'warning', title: `Image « ${file.name || 'collée'} » refusée`, body: parsed.error })
          continue
        }
        setAttachments((previous) => (previous.length >= MAX_IMAGES_PER_MESSAGE ? previous : [...previous, { ...parsed.image, id: crypto.randomUUID(), preview: dataUrl }]))
      } catch {
        toast({ tone: 'warning', title: 'Image illisible', body: file.name })
      }
    }
  }

  return {
    attachments,
    clear: () => setAttachments([]),
    remove: (id: string) => setAttachments((previous) => previous.filter((item) => item.id !== id)),
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...event.clipboardData.items].filter((item) => item.kind === 'file' && item.type.startsWith('image/')).flatMap((item) => item.getAsFile() ?? [])
      if (files.length === 0) return
      event.preventDefault()
      void addFiles(files)
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const files = [...event.dataTransfer.files]
      if (!files.some((file) => file.type.startsWith('image/'))) return
      event.preventDefault()
      void addFiles(files)
    }
  }
}

export function AttachmentStrip({ attachments, onRemove }: { attachments: Attachment[]; onRemove: (id: string) => void }) {
  if (attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <div key={attachment.id} className="group relative size-16 overflow-hidden rounded-md border border-line bg-sunken">
          <img src={attachment.preview} alt="Image jointe" className="size-full object-cover" />
          <button type="button" aria-label="Retirer l’image" onClick={() => onRemove(attachment.id)} className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-full bg-black/70 text-cream opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** `@` mentions: suggestions of the conversation's files while typing `@…`. */
export function useFileMentions(conversationId: string, textareaRef: RefObject<HTMLTextAreaElement | null>, draft: string, setDraft: (text: string) => void) {
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [results, setResults] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const requestRef = useRef(0)

  const refresh = (text: string, caret: number): void => setMention(findMentionQuery(text, caret))

  useEffect(() => {
    if (!mention) {
      setResults([])
      return
    }
    const request = ++requestRef.current
    const timer = window.setTimeout(() => {
      void api
        .invoke('files:search', { conversationId, query: mention.query })
        .then((files) => {
          if (request === requestRef.current) {
            setResults(files)
            setIndex(0)
          }
        })
        .catch(() => setResults([]))
    }, 90)
    return () => window.clearTimeout(timer)
  }, [conversationId, mention])

  const choose = (path: string): void => {
    const element = textareaRef.current
    if (!mention || !element) return
    const next = insertMention(draft, mention.start, element.selectionStart ?? draft.length, path)
    setDraft(next.text)
    setMention(null)
    requestAnimationFrame(() => {
      element.focus()
      element.setSelectionRange(next.caret, next.caret)
    })
  }

  /** Keys the suggestions take; true when the key was handled. */
  const onKeyDown = (key: string): boolean => {
    if (!mention || results.length === 0) return false
    if (key === 'ArrowDown') setIndex((current) => (current + 1) % results.length)
    else if (key === 'ArrowUp') setIndex((current) => (current - 1 + results.length) % results.length)
    else if (key === 'Enter' || key === 'Tab') choose(results[index] as string)
    else if (key === 'Escape') setMention(null)
    else return false
    return true
  }

  return { open: mention !== null && results.length > 0, results, index, choose, refresh, onKeyDown, close: () => setMention(null) }
}

export function MentionList({ results, index, onChoose }: { results: string[]; index: number; onChoose: (path: string) => void }) {
  return (
    <div role="listbox" aria-label="Fichiers" className="mx-auto mb-1.5 max-h-60 max-w-4xl overflow-y-auto rounded-md border border-line-strong bg-raised p-1 shadow-pop">
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-ink-faint">
        <AtSign className="size-3" /> Mentionner un fichier : Claude en recevra le contenu (↑↓, Entrée)
      </div>
      {results.map((path, position) => {
        const slash = path.lastIndexOf('/')
        return (
          <button
            key={path}
            type="button"
            role="option"
            aria-selected={position === index}
            onMouseDown={(event) => {
              event.preventDefault()
              onChoose(path)
            }}
            className={classNames('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12.5px]', position === index ? 'bg-accent-soft text-ink' : 'text-ink-muted hover:bg-white/4')}
          >
            <FileText className="size-3.5 shrink-0 text-ink-faint" />
            <span className="truncate font-medium">{path.slice(slash + 1)}</span>
            {slash > 0 && <span className="truncate font-mono text-[11px] text-ink-faint">{path.slice(0, slash)}</span>}
          </button>
        )
      })}
    </div>
  )
}

const EFFORT_LABELS: Record<EffortLevel, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', xhigh: 'Très élevé', max: 'Maximum' }

export function effortLabel(effort: EffortLevel | null): string {
  return effort ? EFFORT_LABELS[effort] : 'Auto'
}
