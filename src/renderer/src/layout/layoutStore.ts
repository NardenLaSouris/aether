/**
 * Where the movable panels sit. The pure rules live in shared/panelLayout.ts;
 * this store applies them and saves the result in the preferences (debounced).
 */
import { create } from 'zustand'
import {
  closePanel,
  DEFAULT_LAYOUT,
  focusPanel,
  movePanel,
  normaliseLayout,
  openPanel,
  resizeDock,
  resizeSections,
  setFloatingRect,
  togglePanel,
  type DockId,
  type DockTarget,
  type FloatingRect,
  type PanelDefaults,
  type PanelLayout,
  type PanelPosition
} from '../../../shared/panelLayout'
import { api } from '../lib/api'

const SAVE_DELAY_MS = 400

/** Default place of each panel, registered by whoever provides the panel (terminal, mods). */
const panelDefaults = new Map<string, PanelDefaults>()

export function registerPanelDefaults(panelId: string, defaults: PanelDefaults): void {
  panelDefaults.set(panelId, defaults)
}

function defaultsOf(panelId: string): PanelDefaults {
  return panelDefaults.get(panelId) ?? { position: 'floating' }
}

export interface DropPreview {
  position: DockId
  target: DockTarget
  /** Highlighted area, relative to the work area. */
  rect: FloatingRect
  label: string
}

interface LayoutState {
  layout: PanelLayout
  /** Panel being dragged, the pointer position relative to the work area, and where it would land. */
  drag: { panelId: string; pointer: { x: number; y: number }; drop: DropPreview | null } | null
  load(stored: unknown): void
  open(panelId: string): void
  close(panelId: string): void
  toggle(panelId: string): void
  move(panelId: string, position: PanelPosition, floating?: FloatingRect, target?: DockTarget): void
  resizeSections(dock: DockId, firstSlot: number, secondSlot: number, sizes: { first: number; second: number }, delta: number, persist?: boolean): void
  focus(panelId: string): void
  setFloating(panelId: string, rect: FloatingRect, persist?: boolean): void
  resizeDock(dock: DockId, size: number, maximum: number, persist?: boolean): void
  setDrag(drag: LayoutState['drag']): void
  persist(): void
}

let saveTimer: number | undefined

export const useLayoutStore = create<LayoutState>((set, get) => {
  const apply = (change: (layout: PanelLayout) => PanelLayout, persist = true): void => {
    const current = get().layout
    const next = change(current)
    if (next === current) return
    set({ layout: next })
    if (persist) get().persist()
  }
  return {
    layout: structuredClone(DEFAULT_LAYOUT),
    drag: null,
    load(stored) {
      set({ layout: normaliseLayout(stored) })
    },
    open: (panelId) => apply((layout) => openPanel(layout, panelId, defaultsOf(panelId))),
    close: (panelId) => apply((layout) => closePanel(layout, panelId)),
    toggle: (panelId) => apply((layout) => togglePanel(layout, panelId, defaultsOf(panelId))),
    move: (panelId, position, floating, target) => apply((layout) => movePanel(layout, panelId, position, defaultsOf(panelId), floating, target)),
    resizeSections: (dock, firstSlot, secondSlot, sizes, delta, persist = true) => apply((layout) => resizeSections(layout, dock, firstSlot, secondSlot, sizes, delta), persist),
    focus: (panelId) => apply((layout) => focusPanel(layout, panelId)),
    setFloating: (panelId, rect, persist = true) => apply((layout) => setFloatingRect(layout, panelId, rect), persist),
    resizeDock: (dock, size, maximum, persist = true) => apply((layout) => resizeDock(layout, dock, size, maximum), persist),
    setDrag: (drag) => set({ drag }),
    persist() {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        void api.invoke('preferences:update', { panelLayout: get().layout }).catch(() => undefined)
      }, SAVE_DELAY_MS)
    }
  }
})
