/**
 * Modular work area: the page in the middle, panels docked left / right / bottom or floating
 * as small windows. A dock holds one or more sections (stacked in the side docks, side by side
 * at the bottom), each showing its panels as tabs: e.g. Arbo below the terminal on the right.
 *
 * Panels move by dragging their title: over a section, its first third places the panel
 * before it, its last third after it, the middle adds it as a tab; over an edge, it docks there;
 * anywhere else it floats. The ⊞ menu offers the same places. Sizes and places are remembered.
 *
 * Panel contents are rendered once into their own DOM node (React portal) and that node is
 * moved between places, so a terminal keeps its screen when it changes place.
 */
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, LayoutGrid, PictureInPicture2, X } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  activePanelOf,
  clampFloatingRect,
  DOCK_IDS,
  dropZoneAt,
  floatingPanels,
  MIN_FLOATING,
  panelsInSection,
  placementOf,
  sectionDropMode,
  sectionsOf,
  sectionWeight,
  type DockId,
  type FloatingRect
} from '../../../shared/panelLayout'
import { classNames, useContextMenu, type MenuItem } from '../components/ui'
import { useLayoutStore, type DropPreview } from './layoutStore'

export interface PanelDefinition {
  id: string
  title: string
  icon: ReactNode
  render: () => ReactNode
}

type WorkAreaRef = RefObject<HTMLDivElement | null>

const DRAG_THRESHOLD = 5
const MIN_CENTER_WIDTH = 360
const MIN_CENTER_HEIGHT = 180

const DOCK_NAMES: Record<DockId, string> = { left: 'à gauche', right: 'à droite', bottom: 'en bas' }

// ---------------------------------------------------------------------------
// Persistent panel nodes

const panelNodes = new Map<string, HTMLDivElement>()
let parkingNode: HTMLDivElement | null = null

function nodeFor(panelId: string): HTMLDivElement {
  let node = panelNodes.get(panelId)
  if (!node) {
    node = document.createElement('div')
    node.className = 'aether-panel-node h-full w-full'
    node.dataset.panelId = panelId
    panelNodes.set(panelId, node)
    parkingNode?.appendChild(node)
  }
  return node
}

/** Shows a panel's persistent node inside this slot. */
function PanelSlot({ panelId }: { panelId: string }) {
  const slotRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    const node = nodeFor(panelId)
    slot.appendChild(node)
    return () => {
      if (node.parentElement === slot) parkingNode?.appendChild(node)
    }
  }, [panelId])
  return <div ref={slotRef} className="relative min-h-0 flex-1 overflow-hidden" />
}

// ---------------------------------------------------------------------------
// Placement menu

const DOCK_ICONS: Record<DockId, ReactNode> = {
  left: <ArrowLeftToLine className="size-4" />,
  right: <ArrowRightToLine className="size-4" />,
  bottom: <ArrowDownToLine className="size-4" />
}

function placementMenuItems(panelId: string): MenuItem[] {
  const { layout, move, close } = useLayoutStore.getState()
  const current = layout.placements[panelId]
  const items: MenuItem[] = []
  for (const dock of DOCK_IDS) {
    const others = sectionsOf(layout, dock, panelId)
    const alone = current?.open && current.position === dock && others.length === 0
    if (alone) continue
    if (others.length === 0) {
      items.push({ label: `Ancrer ${DOCK_NAMES[dock]}`, icon: DOCK_ICONS[dock], onSelect: () => move(panelId, dock) })
      continue
    }
    const lastSlot = others[others.length - 1] ?? 0
    items.push({ label: dock === 'bottom' ? 'En bas, à côté' : `${dock === 'left' ? 'À gauche' : 'À droite'}, en dessous`, icon: DOCK_ICONS[dock], onSelect: () => move(panelId, dock, undefined, { mode: 'after', slot: lastSlot }) })
    const sameSection = current?.open && current.position === dock && current.slot === lastSlot
    if (!sameSection) items.push({ label: `${dock === 'bottom' ? 'En bas' : dock === 'left' ? 'À gauche' : 'À droite'}, en onglet`, icon: DOCK_ICONS[dock], onSelect: () => move(panelId, dock, undefined, { mode: 'tab', slot: lastSlot }) })
  }
  if (current?.position !== 'floating') items.push({ label: 'Fenêtre flottante', icon: <PictureInPicture2 className="size-4" />, onSelect: () => move(panelId, 'floating') })
  items.push({ label: 'Fermer le panneau', icon: <X className="size-4" />, onSelect: () => close(panelId) })
  return items
}

function PanelActions({ panelId, title }: { panelId: string; title: string }) {
  const close = useLayoutStore((state) => state.close)
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        aria-label={`Placer le panneau ${title}`}
        title="Placer le panneau (glissez aussi son titre)"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          useContextMenu.getState().open({ x: rect.left, y: rect.bottom + 4 }, placementMenuItems(panelId))
        }}
        className="no-drag rounded p-1 text-ink-faint hover:bg-white/8 hover:text-ink"
      >
        <LayoutGrid className="size-3.5" />
      </button>
      <button type="button" aria-label={`Fermer le panneau ${title}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => close(panelId)} className="no-drag rounded p-1 text-ink-faint hover:bg-white/8 hover:text-ink">
        <X className="size-3.5" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dragging panels

/**
 * Keeps receiving the pointer during a drag or resize. Mod panels are frames from another origin,
 * which would swallow the pointer events: they ignore the pointer until the button is released.
 */
function capturePointer(event: ReactPointerEvent): void {
  event.preventDefault()
  document.body.classList.add('aether-dragging')
  const release = () => {
    document.body.classList.remove('aether-dragging')
    window.removeEventListener('pointerup', release, true)
    window.removeEventListener('pointercancel', release, true)
  }
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  try {
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
  } catch {
    // capture unavailable: the frames ignoring the pointer is enough
  }
}

function relativeRect(element: Element, area: DOMRect): FloatingRect {
  const rect = element.getBoundingClientRect()
  return { x: rect.left - area.left, y: rect.top - area.top, width: rect.width, height: rect.height }
}

/** Where the dragged panel would land at this point, or null (it then floats). */
function dropPreviewAt(point: { x: number; y: number }, workArea: HTMLElement, panelId: string): DropPreview | null {
  const area = workArea.getBoundingClientRect()
  const layout = useLayoutStore.getState().layout
  for (const element of workArea.querySelectorAll<HTMLElement>('[data-section]')) {
    const dock = element.dataset.sectionDock as DockId
    const slot = Number(element.dataset.slot)
    const panels = panelsInSection(layout, dock, slot)
    if (panels.length === 1 && panels[0] === panelId) continue
    const rect = relativeRect(element, area)
    if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) continue
    const mode = sectionDropMode(point, rect, dock)
    const vertical = dock !== 'bottom'
    if (mode === 'tab') return { position: dock, target: { mode, slot }, rect, label: 'En onglet' }
    const half = vertical ? { ...rect, height: rect.height / 2, y: mode === 'before' ? rect.y : rect.y + rect.height / 2 } : { ...rect, width: rect.width / 2, x: mode === 'before' ? rect.x : rect.x + rect.width / 2 }
    const label = vertical ? (mode === 'before' ? 'Au-dessus' : 'En dessous') : mode === 'before' ? 'À gauche' : 'À droite'
    return { position: dock, target: { mode, slot }, rect: half, label }
  }
  const size = { width: area.width, height: area.height }
  const zone = dropZoneAt(point, size)
  if (!zone) return null
  const edge = Math.min(120, area.width * 0.18)
  const bottomEdge = Math.min(110, area.height * 0.22)
  const rect = zone === 'left' ? { x: 6, y: 6, width: edge - 12, height: area.height - 12 } : zone === 'right' ? { x: area.width - edge + 6, y: 6, width: edge - 12, height: area.height - 12 } : { x: edge, y: area.height - bottomEdge + 6, width: area.width - 2 * edge, height: bottomEdge - 12 }
  const hasSections = sectionsOf(layout, zone, panelId).length > 0
  return { position: zone, target: { mode: 'new' }, rect, label: hasSections ? `Nouvelle section ${DOCK_NAMES[zone]}` : `Ancrer ${DOCK_NAMES[zone]}` }
}

/**
 * Starts dragging a panel from its title. A click (no movement) only focuses it.
 * A floating window follows the pointer; dropping on a section or an edge docks the panel there.
 */
function startPanelDrag(event: ReactPointerEvent, panelId: string, workArea: HTMLElement | null): void {
  if (event.button !== 0 || !workArea) return
  capturePointer(event)
  const store = useLayoutStore.getState()
  store.focus(panelId)
  const startX = event.clientX
  const startY = event.clientY
  const placement = store.layout.placements[panelId]
  const startRect = placement?.floating
  const isFloating = placement?.position === 'floating'
  let dragging = false

  const relative = (clientX: number, clientY: number) => {
    const area = workArea.getBoundingClientRect()
    return { point: { x: clientX - area.left, y: clientY - area.top }, size: { width: area.width, height: area.height } }
  }

  const onMove = (moveEvent: PointerEvent) => {
    if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_THRESHOLD) return
    dragging = true
    const { point, size } = relative(moveEvent.clientX, moveEvent.clientY)
    useLayoutStore.getState().setDrag({ panelId, pointer: point, drop: dropPreviewAt(point, workArea, panelId) })
    if (isFloating && startRect) {
      useLayoutStore.getState().setFloating(panelId, clampFloatingRect({ ...startRect, x: startRect.x + moveEvent.clientX - startX, y: startRect.y + moveEvent.clientY - startY }, size), false)
    }
  }
  const onUp = (upEvent: PointerEvent) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    const current = useLayoutStore.getState()
    current.setDrag(null)
    if (!dragging) return
    const { point, size } = relative(upEvent.clientX, upEvent.clientY)
    const drop = dropPreviewAt(point, workArea, panelId)
    if (drop) {
      current.move(panelId, drop.position, isFloating && startRect ? startRect : undefined, drop.target)
    } else if (!isFloating) {
      const base = placementOf(current.layout, panelId, { position: 'floating' }).floating
      current.move(panelId, 'floating', clampFloatingRect({ ...base, x: point.x - 80, y: point.y - 14 }, size))
    } else {
      current.persist()
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// ---------------------------------------------------------------------------
// Docks and their sections

function Section({ dock, slot, definitions, workAreaRef }: { dock: DockId; slot: number; definitions: Map<string, PanelDefinition>; workAreaRef: WorkAreaRef }) {
  const layout = useLayoutStore((state) => state.layout)
  const focus = useLayoutStore((state) => state.focus)
  const panelIds = panelsInSection(layout, dock, slot).filter((panelId) => definitions.has(panelId))
  const activeId = activePanelOf(layout, dock, slot)
  const shown = activeId && definitions.has(activeId) ? activeId : panelIds[0]
  if (!shown) return null
  return (
    <div data-section="" data-section-dock={dock} data-slot={slot} className="flex min-h-0 min-w-0 flex-col" style={{ flex: `${sectionWeight(layout, dock, slot)} 1 0px` }}>
      <header className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel/60 pr-1 pl-1.5">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {panelIds.map((panelId) => {
            const definition = definitions.get(panelId)
            if (!definition) return null
            return (
              <button
                key={panelId}
                type="button"
                role="tab"
                aria-selected={panelId === shown}
                title="Glissez pour déplacer le panneau"
                onPointerDown={(event) => startPanelDrag(event, panelId, workAreaRef.current)}
                onClick={() => focus(panelId)}
                className={classNames('flex shrink-0 cursor-grab items-center gap-1.5 rounded px-2 py-1 text-[12px] active:cursor-grabbing', panelId === shown ? 'bg-white/6 text-ink' : 'text-ink-muted hover:text-ink')}
              >
                <span className="text-gold [&>svg]:size-3.5">{definition.icon}</span>
                {definition.title}
              </button>
            )
          })}
        </div>
        <PanelActions panelId={shown} title={definitions.get(shown)?.title ?? ''} />
      </header>
      <PanelSlot panelId={shown} />
    </div>
  )
}

/** Handle between two sections of a dock. */
function SectionSplitter({ dock, firstSlot, secondSlot, workAreaRef }: { dock: DockId; firstSlot: number; secondSlot: number; workAreaRef: WorkAreaRef }) {
  const vertical = dock !== 'bottom'
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workArea = workAreaRef.current
    const first = workArea?.querySelector(`[data-section-dock="${dock}"][data-slot="${firstSlot}"]`)
    const second = workArea?.querySelector(`[data-section-dock="${dock}"][data-slot="${secondSlot}"]`)
    if (!first || !second) return
    capturePointer(event)
    const sizes = vertical ? { first: first.getBoundingClientRect().height, second: second.getBoundingClientRect().height } : { first: first.getBoundingClientRect().width, second: second.getBoundingClientRect().width }
    const startLayout = useLayoutStore.getState().layout
    const startX = event.clientX
    const startY = event.clientY
    const move = (moveEvent: PointerEvent) => {
      const delta = vertical ? moveEvent.clientY - startY : moveEvent.clientX - startX
      useLayoutStore.setState({ layout: startLayout })
      useLayoutStore.getState().resizeSections(dock, firstSlot, secondSlot, sizes, delta, false)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      useLayoutStore.getState().persist()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label="Redimensionner les sections"
      onPointerDown={start}
      className={classNames('relative z-10 shrink-0 transition-colors hover:bg-gold/30', vertical ? 'h-[5px] cursor-row-resize border-y border-black/40 bg-black/20' : 'w-[5px] cursor-col-resize border-x border-black/40 bg-black/20')}
    />
  )
}

function Dock({ dock, definitions, workAreaRef }: { dock: DockId; definitions: Map<string, PanelDefinition>; workAreaRef: WorkAreaRef }) {
  const layout = useLayoutStore((state) => state.layout)
  const slots = sectionsOf(layout, dock).filter((slot) => panelsInSection(layout, dock, slot).some((panelId) => definitions.has(panelId)))
  if (slots.length === 0) return null
  const size = layout.sizes[dock]
  const vertical = dock !== 'bottom'
  return (
    <section
      aria-label={`Panneaux ${DOCK_NAMES[dock]}`}
      data-dock={dock}
      className={classNames('flex shrink-0 bg-[#121513]', vertical ? 'flex-col' : 'flex-row', dock === 'left' && 'border-r border-black/40', dock === 'right' && 'border-l border-black/40', dock === 'bottom' && 'border-t border-black/40')}
      style={vertical ? { width: size } : { height: size }}
    >
      {slots.map((slot, index) => (
        <Fragment key={slot}>
          {index > 0 && <SectionSplitter dock={dock} firstSlot={slots[index - 1] ?? 0} secondSlot={slot} workAreaRef={workAreaRef} />}
          <Section dock={dock} slot={slot} definitions={definitions} workAreaRef={workAreaRef} />
        </Fragment>
      ))}
    </section>
  )
}

function Splitter({ dock, workAreaRef }: { dock: DockId; workAreaRef: WorkAreaRef }) {
  const resize = useLayoutStore((state) => state.resizeDock)
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    const workArea = workAreaRef.current
    if (!workArea) return
    capturePointer(event)
    const area = workArea.getBoundingClientRect()
    const layout = useLayoutStore.getState().layout
    const startSize = layout.sizes[dock]
    const startX = event.clientX
    const startY = event.clientY
    const otherSide = dock === 'left' ? 'right' : 'left'
    const otherOpen = sectionsOf(layout, otherSide).length > 0 ? layout.sizes[otherSide] : 0
    const maximum = dock === 'bottom' ? area.height - MIN_CENTER_HEIGHT : area.width - otherOpen - MIN_CENTER_WIDTH
    const sizeAt = (moveEvent: PointerEvent) => (dock === 'left' ? startSize + moveEvent.clientX - startX : dock === 'right' ? startSize - (moveEvent.clientX - startX) : startSize - (moveEvent.clientY - startY))
    const move = (moveEvent: PointerEvent) => resize(dock, sizeAt(moveEvent), maximum, false)
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      useLayoutStore.getState().persist()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  const vertical = dock !== 'bottom'
  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label="Redimensionner le panneau"
      onPointerDown={start}
      className={classNames('relative z-10 shrink-0 bg-transparent transition-colors hover:bg-gold/30', vertical ? '-mx-[3px] w-[6px] cursor-col-resize' : '-my-[3px] h-[6px] cursor-row-resize')}
    />
  )
}

// ---------------------------------------------------------------------------
// Floating windows

function FloatingWindow({ panelId, definition, zIndex, workAreaRef }: { panelId: string; definition: PanelDefinition; zIndex: number; workAreaRef: WorkAreaRef }) {
  const placement = useLayoutStore((state) => state.layout.placements[panelId])
  const setFloating = useLayoutStore((state) => state.setFloating)
  const focus = useLayoutStore((state) => state.focus)
  const beingDragged = useLayoutStore((state) => state.drag?.panelId === panelId)
  if (!placement) return null
  const area = workAreaRef.current?.getBoundingClientRect()
  const rect: FloatingRect = area ? clampFloatingRect(placement.floating, { width: area.width, height: area.height }) : placement.floating

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    capturePointer(event)
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    const start = rect
    const move = (moveEvent: PointerEvent) => {
      const bounds = workAreaRef.current?.getBoundingClientRect()
      const wantedWidth = start.width + moveEvent.clientX - startX
      const wantedHeight = start.height + moveEvent.clientY - startY
      const width = Math.round(Math.max(MIN_FLOATING.width, bounds ? Math.min(wantedWidth, bounds.width - start.x) : wantedWidth))
      const height = Math.round(Math.max(MIN_FLOATING.height, bounds ? Math.min(wantedHeight, bounds.height - start.y) : wantedHeight))
      setFloating(panelId, { ...start, width, height }, false)
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      useLayoutStore.getState().persist()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <section
      role="dialog"
      aria-label={definition.title}
      data-floating-panel={panelId}
      onPointerDownCapture={() => focus(panelId)}
      className={classNames('absolute flex flex-col overflow-hidden rounded-lg border border-line-strong bg-[#121513] shadow-pop', beingDragged && 'opacity-60')}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 30 + zIndex }}
    >
      <header onPointerDown={(event) => startPanelDrag(event, panelId, workAreaRef.current)} title="Glissez pour déplacer, ou déposez sur un bord ou une section pour ancrer" className="flex h-8 shrink-0 cursor-grab items-center gap-1.5 border-b border-line bg-panel pr-1 pl-2.5 active:cursor-grabbing">
        <span className="text-gold [&>svg]:size-3.5">{definition.icon}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{definition.title}</span>
        <PanelActions panelId={panelId} title={definition.title} />
      </header>
      <PanelSlot panelId={panelId} />
      <div role="separator" aria-label="Redimensionner la fenêtre" onPointerDown={startResize} className="absolute right-0 bottom-0 size-3.5 cursor-nwse-resize" />
    </section>
  )
}

function DropOverlay() {
  const drag = useLayoutStore((state) => state.drag)
  if (!drag) return null
  const drop = drag.drop
  return (
    <div className="pointer-events-none absolute inset-0 z-[200]">
      {drop ? (
        <div className="absolute flex items-center justify-center rounded-lg border-2 border-dashed border-gold bg-gold/20 text-[12px] font-medium text-cream" style={{ left: drop.rect.x, top: drop.rect.y, width: drop.rect.width, height: drop.rect.height }}>
          {drop.label}
        </div>
      ) : (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-[#232725] px-3 py-1 text-[11.5px] text-ink-muted">Relâchez ici pour une fenêtre flottante · bords et sections pour ancrer</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function DockLayout({ definitions, children }: { definitions: Map<string, PanelDefinition>; children: ReactNode }) {
  const layout = useLayoutStore((state) => state.layout)
  const workAreaRef = useRef<HTMLDivElement>(null)
  const parkingRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    parkingNode = parkingRef.current
    for (const node of panelNodes.values()) if (!node.parentElement) parkingNode?.appendChild(node)
  }, [])

  // Floating windows are re-clamped when the window gets smaller.
  useEffect(() => {
    const onResize = () => useLayoutStore.setState((state) => ({ layout: { ...state.layout } }))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const docked = Object.fromEntries(DOCK_IDS.map((dock) => [dock, sectionsOf(layout, dock).some((slot) => panelsInSection(layout, dock, slot).some((panelId) => definitions.has(panelId)))])) as Record<DockId, boolean>
  const floating = floatingPanels(layout).filter((panelId) => definitions.has(panelId))
  // Every panel opened at least once keeps its content mounted (a terminal keeps running and its screen).
  const mounted = [...definitions.values()].filter((definition) => layout.placements[definition.id])

  return (
    <div ref={workAreaRef} className="relative flex min-h-0 min-w-0 flex-1">
      {docked.left && <Dock dock="left" definitions={definitions} workAreaRef={workAreaRef} />}
      {docked.left && <Splitter dock="left" workAreaRef={workAreaRef} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 bg-canvas">{children}</main>
        {docked.bottom && <Splitter dock="bottom" workAreaRef={workAreaRef} />}
        {docked.bottom && <Dock dock="bottom" definitions={definitions} workAreaRef={workAreaRef} />}
      </div>
      {docked.right && <Splitter dock="right" workAreaRef={workAreaRef} />}
      {docked.right && <Dock dock="right" definitions={definitions} workAreaRef={workAreaRef} />}
      {floating.map((panelId, index) => {
        const definition = definitions.get(panelId)
        return definition ? <FloatingWindow key={panelId} panelId={panelId} definition={definition} zIndex={index} workAreaRef={workAreaRef} /> : null
      })}
      <DropOverlay />
      <div ref={parkingRef} hidden aria-hidden="true" />
      {mounted.map((definition) => createPortal(definition.render(), nodeFor(definition.id), definition.id))}
    </div>
  )
}
