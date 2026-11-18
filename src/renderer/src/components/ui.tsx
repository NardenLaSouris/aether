/**
 * Design-system primitives: buttons, tooltips, dialogs, menus, badges, empty states.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { create } from 'zustand'

export function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle'

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-forest text-cream border border-gold/45 hover:border-gold hover:bg-[#124a37] shadow-[0_0_0_1px_rgba(196,169,106,0.08)]',
  secondary: 'bg-raised text-ink border border-line-strong hover:border-sage/60 hover:bg-[#282c2a]',
  ghost: 'bg-transparent text-ink-muted border border-transparent hover:text-ink hover:bg-white/5',
  danger: 'bg-danger-soft text-danger border border-danger/40 hover:bg-danger/20',
  subtle: 'bg-accent-soft text-gold border border-gold/25 hover:border-gold/60'
}

export function Button({ variant = 'secondary', size = 'md', loading = false, icon, children, className, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      className={classNames(
        'no-drag inline-flex select-none items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        BUTTON_STYLES[variant],
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        className={classNames('no-drag inline-flex size-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-white/6 hover:text-ink disabled:opacity-40', active && 'bg-white/8 text-gold', className)}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={classNames('size-4 animate-spin text-sage', className)} aria-label="Chargement" />
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'gold' | 'sage' | 'danger' | 'warning' | 'info'; children: ReactNode; className?: string }) {
  const tones = {
    neutral: 'bg-white/6 text-ink-muted border-line',
    gold: 'bg-accent-soft text-gold border-gold/30',
    sage: 'bg-sage/12 text-sage border-sage/30',
    danger: 'bg-danger-soft text-danger border-danger/30',
    warning: 'bg-warning/12 text-warning border-warning/30',
    info: 'bg-info/12 text-info border-info/30'
  }
  return <span className={classNames('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4', tones[tone], className)}>{children}</span>
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={classNames('rounded-lg border border-line bg-panel shadow-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h3 className="font-display text-[13px] font-semibold tracking-wide text-ink">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex animate-fade-in flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full border border-gold/25 bg-accent-soft text-gold">{icon}</div>
      <div className="font-display text-[15px] font-semibold">{title}</div>
      {description && <div className="max-w-md text-[13px] text-ink-muted">{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6 py-2">
      <span>
        <span className="block text-[13px] text-ink">{label}</span>
        {description && <span className="block text-xs text-ink-faint">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={classNames('relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors', checked ? 'border-gold/60 bg-forest' : 'border-line-strong bg-sunken')}
      >
        <span className={classNames('absolute top-0.5 size-3.5 rounded-full transition-all', checked ? 'left-[18px] bg-gold' : 'left-0.5 bg-ink-faint')} />
      </button>
    </label>
  )
}

/** Compact on/off switch for dense lists. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={classNames('no-drag relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40', checked ? 'border-gold/60 bg-forest' : 'border-line-strong bg-sunken')}
    >
      <span className={classNames('absolute top-0.5 size-3.5 rounded-full transition-all', checked ? 'left-[18px] bg-gold' : 'left-0.5 bg-ink-faint')} />
    </button>
  )
}

/** Hover tooltip rendered in a portal so it is never clipped. */
export function Tooltip({ content, children, side = 'bottom' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'right' }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const timerRef = useRef<number | null>(null)
  const show = (): void => {
    timerRef.current = window.setTimeout(() => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      if (side === 'right') setPosition({ left: rect.right + 8, top: rect.top + rect.height / 2 })
      else setPosition({ left: rect.left + rect.width / 2, top: side === 'top' ? rect.top - 8 : rect.bottom + 8 })
    }, 350)
  }
  const hide = (): void => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    setPosition(null)
  }
  return (
    <span ref={anchorRef} className="inline-flex" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {position &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            className={classNames(
              'pointer-events-none fixed z-[100] max-w-xs animate-fade-in rounded-md border border-line-strong bg-[#262a28] px-2 py-1 text-xs text-ink shadow-pop',
              side === 'right' ? '-translate-y-1/2' : side === 'top' ? '-translate-x-1/2 -translate-y-full' : '-translate-x-1/2'
            )}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  )
}

export function Dialog({ open, onClose, title, children, footer, width = 'max-w-lg', dismissible = true }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string; dismissible?: boolean }) {
  useEffect(() => {
    if (!open || !dismissible) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, dismissible])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[90] flex animate-fade-in items-center justify-center bg-black/55 p-6 backdrop-blur-[2px]" onMouseDown={(event) => dismissible && event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={classNames('w-full animate-rise rounded-lg border border-line-strong bg-panel shadow-pop', width)}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-display text-[15px] font-semibold">{title}</h2>
          {dismissible && (
            <button type="button" aria-label="Fermer" onClick={onClose} className="rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink">
              <X className="size-4" />
            </button>
          )}
        </header>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// Confirmation dialog (promise based)
// ---------------------------------------------------------------------------

interface ConfirmRequest {
  title: string
  message: ReactNode
  confirmLabel: string
  danger: boolean
  resolve: (confirmed: boolean) => void
}

const useConfirmStore = create<{ request: ConfirmRequest | null; setRequest: (request: ConfirmRequest | null) => void }>((set) => ({ request: null, setRequest: (request) => set({ request }) }))

export function confirmAction(options: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.getState().setRequest({ title: options.title, message: options.message, confirmLabel: options.confirmLabel ?? 'Confirmer', danger: options.danger ?? false, resolve }))
}

export function ConfirmHost() {
  const request = useConfirmStore((state) => state.request)
  const setRequest = useConfirmStore((state) => state.setRequest)
  const finish = (confirmed: boolean): void => {
    request?.resolve(confirmed)
    setRequest(null)
  }
  return (
    <Dialog
      open={request !== null}
      onClose={() => finish(false)}
      title={request?.title ?? ''}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(false)}>
            Annuler
          </Button>
          <Button variant={request?.danger ? 'danger' : 'primary'} onClick={() => finish(true)} autoFocus>
            {request?.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-ink-muted">{request?.message}</div>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Prompt dialog (rename etc.)
// ---------------------------------------------------------------------------

interface PromptRequest {
  title: string
  label: string
  initialValue: string
  resolve: (value: string | null) => void
}

const usePromptStore = create<{ request: PromptRequest | null; setRequest: (request: PromptRequest | null) => void }>((set) => ({ request: null, setRequest: (request) => set({ request }) }))

export function promptText(options: { title: string; label: string; initialValue?: string }): Promise<string | null> {
  return new Promise((resolve) => usePromptStore.getState().setRequest({ title: options.title, label: options.label, initialValue: options.initialValue ?? '', resolve }))
}

export function PromptHost() {
  const request = usePromptStore((state) => state.request)
  const setRequest = usePromptStore((state) => state.setRequest)
  const [value, setValue] = useState('')
  useEffect(() => setValue(request?.initialValue ?? ''), [request])
  const finish = (result: string | null): void => {
    request?.resolve(result)
    setRequest(null)
  }
  return (
    <Dialog
      open={request !== null}
      onClose={() => finish(null)}
      title={request?.title ?? ''}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={() => finish(null)}>
            Annuler
          </Button>
          <Button variant="primary" disabled={value.trim().length === 0} onClick={() => finish(value.trim())}>
            Enregistrer
          </Button>
        </>
      }
    >
      <label className="block text-xs text-ink-muted">
        {request?.label}
        <input
          autoFocus
          value={value}
          maxLength={200}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && value.trim()) finish(value.trim())
          }}
          className="mt-1.5 w-full rounded-md border border-line-strong bg-sunken px-3 py-2 text-[13px] text-ink outline-none focus:border-gold/60"
        />
      </label>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

interface ContextMenuState {
  position: { x: number; y: number } | null
  items: MenuItem[]
  open: (position: { x: number; y: number }, items: MenuItem[]) => void
  close: () => void
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  position: null,
  items: [],
  open: (position, items) => set({ position, items }),
  close: () => set({ position: null, items: [] })
}))

export function ContextMenuHost() {
  const { position, items, close } = useContextMenu()
  const menuRef = useRef<HTMLDivElement>(null)
  const [adjusted, setAdjusted] = useState<{ x: number; y: number } | null>(null)
  useLayoutEffect(() => {
    if (!position || !menuRef.current) {
      setAdjusted(null)
      return
    }
    const rect = menuRef.current.getBoundingClientRect()
    setAdjusted({ x: Math.min(position.x, window.innerWidth - rect.width - 8), y: Math.min(position.y, window.innerHeight - rect.height - 8) })
  }, [position])
  useEffect(() => {
    if (!position) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', close)
    }
  }, [position, close])
  if (!position) return null
  const place = adjusted ?? position
  return createPortal(
    <div className="fixed inset-0 z-[95]" onMouseDown={close} onContextMenu={(event) => (event.preventDefault(), close())}>
      <div ref={menuRef} role="menu" style={{ left: place.x, top: place.y }} className="fixed min-w-48 animate-rise rounded-md border border-line-strong bg-[#232725] p-1 shadow-pop" onMouseDown={(event) => event.stopPropagation()}>
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              close()
              item.onSelect()
            }}
            className={classNames('flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-[13px] disabled:opacity-40', item.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-white/6')}
          >
            <span className="flex size-4 items-center justify-center text-ink-faint">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </div>,
    document.body
  )
}
