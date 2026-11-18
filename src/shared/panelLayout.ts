/**
 * Movable panels (terminal, mod panels): where each one sits and how big the docks are.
 * Pure functions, shared by the renderer and the tests; the layout is saved in the preferences.
 *
 * A dock (left, right, bottom) holds one or more sections ("groups"), stacked vertically in the
 * left/right docks and side by side in the bottom dock. Each section shows its panels as tabs.
 * A panel's section is its `slot` number: sections are shown in slot order.
 */
import { z } from 'zod'

export type DockId = 'left' | 'right' | 'bottom'
export type PanelPosition = DockId | 'floating'

export const DOCK_IDS: readonly DockId[] = ['left', 'right', 'bottom']

export interface FloatingRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelPlacement {
  position: PanelPosition
  open: boolean
  floating: FloatingRect
  /** Section of the dock (ignored when floating). */
  slot: number
}

export interface PanelLayout {
  version: 1
  placements: Record<string, PanelPlacement>
  /** Width of the left/right docks and height of the bottom dock, in pixels. */
  sizes: Record<DockId, number>
  /** Visible tab of each section, by section key (`right:0`). */
  active: Record<string, string>
  /** Relative size of each section in its dock, by section key (default 1). */
  weights: Record<string, number>
  /** Stacking order of floating panels, last on top. */
  floatingOrder: string[]
}

export interface PanelDefaults {
  position: PanelPosition
  floating?: Partial<FloatingRect>
}

/** Where a dragged panel lands: a new section at the end of a dock, or relative to an existing section. */
export type DockTarget = { mode: 'new' } | { mode: 'tab' | 'before' | 'after'; slot: number }

export const MIN_DOCK_SIZE: Record<DockId, number> = { left: 220, right: 220, bottom: 120 }
export const MIN_SECTION_SIZE = 90
export const MIN_FLOATING = { width: 240, height: 160 }
const DEFAULT_FLOATING: FloatingRect = { x: 120, y: 90, width: 520, height: 400 }
const MIN_WEIGHT = 0.05

export const DEFAULT_LAYOUT: PanelLayout = {
  version: 1,
  placements: {},
  sizes: { left: 360, right: 460, bottom: 300 },
  active: {},
  weights: {},
  floatingOrder: []
}

export function sectionKey(dock: DockId, slot: number): string {
  return `${dock}:${slot}`
}

const rectSchema = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() })
const positionSchema = z.enum(['left', 'right', 'bottom', 'floating'])
const panelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/)
const keySchema = z.string().min(1).max(40)

export const panelLayoutSchema = z.object({
  version: z.literal(1),
  placements: z.record(panelIdSchema, z.object({ position: positionSchema, open: z.boolean(), floating: rectSchema, slot: z.number().int().min(0).max(100).default(0) })),
  sizes: z.object({ left: z.number().finite(), right: z.number().finite(), bottom: z.number().finite() }),
  active: z.record(keySchema, panelIdSchema).default({}),
  weights: z.record(keySchema, z.number().finite().positive()).default({}),
  floatingOrder: z.array(panelIdSchema).max(200)
})

/** Reads a stored layout; anything unreadable falls back to the defaults (never throws). */
export function normaliseLayout(value: unknown): PanelLayout {
  const parsed = panelLayoutSchema.safeParse(value)
  if (!parsed.success) return structuredClone(DEFAULT_LAYOUT)
  const layout = parsed.data as PanelLayout
  // Layouts saved before sections existed keyed the visible tab by dock only.
  const active: Record<string, string> = {}
  for (const [key, panelId] of Object.entries(layout.active)) active[DOCK_IDS.includes(key as DockId) ? sectionKey(key as DockId, 0) : key] = panelId
  return {
    ...layout,
    active,
    sizes: {
      left: Math.max(MIN_DOCK_SIZE.left, layout.sizes.left),
      right: Math.max(MIN_DOCK_SIZE.right, layout.sizes.right),
      bottom: Math.max(MIN_DOCK_SIZE.bottom, layout.sizes.bottom)
    }
  }
}

export function placementOf(layout: PanelLayout, panelId: string, defaults: PanelDefaults): PanelPlacement {
  return layout.placements[panelId] ?? { position: defaults.position, open: false, floating: { ...DEFAULT_FLOATING, ...defaults.floating }, slot: 0 }
}

function byPanelOrder(left: string, right: string): number {
  return left === 'terminal' ? -1 : right === 'terminal' ? 1 : left.localeCompare(right)
}

/** Open panels of a dock, all sections together. */
export function panelsInDock(layout: PanelLayout, dock: DockId): string[] {
  return Object.entries(layout.placements)
    .filter(([, placement]) => placement.open && placement.position === dock)
    .sort(([leftId, left], [rightId, right]) => left.slot - right.slot || byPanelOrder(leftId, rightId))
    .map(([panelId]) => panelId)
}

/** Sections of a dock that have at least one open panel, in display order. */
export function sectionsOf(layout: PanelLayout, dock: DockId, except?: string): number[] {
  const slots = new Set<number>()
  for (const [panelId, placement] of Object.entries(layout.placements)) {
    if (panelId !== except && placement.open && placement.position === dock) slots.add(placement.slot)
  }
  return [...slots].sort((left, right) => left - right)
}

export function panelsInSection(layout: PanelLayout, dock: DockId, slot: number): string[] {
  return Object.entries(layout.placements)
    .filter(([, placement]) => placement.open && placement.position === dock && placement.slot === slot)
    .map(([panelId]) => panelId)
    .sort(byPanelOrder)
}

/** The tab shown in a section: the remembered one if still there, else the first. */
export function activePanelOf(layout: PanelLayout, dock: DockId, slot = 0): string | null {
  const panels = panelsInSection(layout, dock, slot)
  const remembered = layout.active[sectionKey(dock, slot)]
  return remembered && panels.includes(remembered) ? remembered : (panels[0] ?? null)
}

export function sectionWeight(layout: PanelLayout, dock: DockId, slot: number): number {
  return layout.weights[sectionKey(dock, slot)] ?? 1
}

export function floatingPanels(layout: PanelLayout): string[] {
  const open = Object.entries(layout.placements)
    .filter(([, placement]) => placement.open && placement.position === 'floating')
    .map(([panelId]) => panelId)
  const ordered = layout.floatingOrder.filter((panelId) => open.includes(panelId))
  return [...ordered, ...open.filter((panelId) => !ordered.includes(panelId))]
}

export function isPanelVisible(layout: PanelLayout, panelId: string): boolean {
  const placement = layout.placements[panelId]
  if (!placement?.open) return false
  if (placement.position === 'floating') return true
  return activePanelOf(layout, placement.position, placement.slot) === panelId
}

function bringToFront(order: string[], panelId: string): string[] {
  return [...order.filter((item) => item !== panelId), panelId]
}

/** Renumbers a dock's sections 0..n-1 (keeping their order), with their tabs and sizes. */
function compactDock(layout: PanelLayout, dock: DockId): PanelLayout {
  const slots = [...new Set(Object.values(layout.placements).filter((placement) => placement.position === dock).map((placement) => placement.slot))].sort((left, right) => left - right)
  if (slots.every((slot, index) => slot === index)) return layout
  const renumber = new Map(slots.map((slot, index) => [slot, index]))
  const placements: Record<string, PanelPlacement> = {}
  for (const [panelId, placement] of Object.entries(layout.placements)) {
    placements[panelId] = placement.position === dock ? { ...placement, slot: renumber.get(placement.slot) ?? 0 } : placement
  }
  const remapKeys = <Value>(record: Record<string, Value>): Record<string, Value> => {
    const next: Record<string, Value> = {}
    for (const [key, value] of Object.entries(record)) {
      const [keyDock, keySlot] = key.split(':')
      if (keyDock !== dock) next[key] = value
      else if (renumber.has(Number(keySlot))) next[sectionKey(dock, renumber.get(Number(keySlot)) ?? 0)] = value
    }
    return next
  }
  return { ...layout, placements, active: remapKeys(layout.active), weights: remapKeys(layout.weights) }
}

function withPlacement(layout: PanelLayout, panelId: string, placement: PanelPlacement): PanelLayout {
  const next: PanelLayout = { ...layout, placements: { ...layout.placements, [panelId]: placement }, active: { ...layout.active } }
  if (placement.open && placement.position !== 'floating') next.active[sectionKey(placement.position, placement.slot)] = panelId
  next.floatingOrder = placement.open && placement.position === 'floating' ? bringToFront(layout.floatingOrder, panelId) : layout.floatingOrder.filter((item) => item !== panelId)
  return next
}

/** Opens a panel where it was last placed (or at its default place) and shows it. */
export function openPanel(layout: PanelLayout, panelId: string, defaults: PanelDefaults): PanelLayout {
  return withPlacement(layout, panelId, { ...placementOf(layout, panelId, defaults), open: true })
}

export function closePanel(layout: PanelLayout, panelId: string): PanelLayout {
  const placement = layout.placements[panelId]
  if (!placement?.open) return layout
  const next = withPlacement(layout, panelId, { ...placement, open: false })
  if (placement.position !== 'floating') {
    const key = sectionKey(placement.position, placement.slot)
    if (next.active[key] === panelId) delete next.active[key]
  }
  return next
}

export function togglePanel(layout: PanelLayout, panelId: string, defaults: PanelDefaults): PanelLayout {
  return isPanelVisible(layout, panelId) ? closePanel(layout, panelId) : openPanel(layout, panelId, defaults)
}

/**
 * Moves a panel to a dock or makes it float (optionally at a given rectangle); it stays open.
 * In a dock, `target` says where: a new section at the end (default), a tab of a section,
 * or a new section before/after one.
 */
export function movePanel(layout: PanelLayout, panelId: string, position: PanelPosition, defaults: PanelDefaults, floating?: FloatingRect, target: DockTarget = { mode: 'new' }): PanelLayout {
  const current = placementOf(layout, panelId, defaults)
  if (position === 'floating') {
    const moved = withPlacement(layout, panelId, { ...current, position, open: true, floating: floating ?? current.floating })
    return current.position === 'floating' ? moved : compactDock(moved, current.position)
  }
  const sections = sectionsOf(layout, position, panelId)
  let slot: number
  let shiftFrom: number | null = null
  if (target.mode === 'new' || sections.length === 0) {
    slot = sections.length ? (sections[sections.length - 1] ?? 0) + 1 : 0
  } else if (target.mode === 'tab') {
    slot = target.slot
  } else {
    slot = target.mode === 'before' ? target.slot : target.slot + 1
    shiftFrom = slot
  }
  let next = layout
  if (shiftFrom !== null) {
    const placements: Record<string, PanelPlacement> = {}
    for (const [otherId, placement] of Object.entries(layout.placements)) {
      placements[otherId] = otherId !== panelId && placement.position === position && placement.slot >= shiftFrom ? { ...placement, slot: placement.slot + 1 } : placement
    }
    const shiftKeys = <Value>(record: Record<string, Value>): Record<string, Value> => {
      const shifted: Record<string, Value> = {}
      for (const [key, value] of Object.entries(record)) {
        const [keyDock, keySlot] = key.split(':')
        const number = Number(keySlot)
        shifted[keyDock === position && number >= (shiftFrom ?? 0) ? sectionKey(position, number + 1) : key] = value
      }
      return shifted
    }
    next = { ...layout, placements, active: shiftKeys(layout.active), weights: shiftKeys(layout.weights) }
    const weights = { ...next.weights }
    delete weights[sectionKey(position, slot)]
    next = { ...next, weights }
  }
  next = withPlacement(next, panelId, { ...current, position, open: true, slot, floating: floating ?? current.floating })
  next = compactDock(next, position)
  return current.position !== 'floating' && current.position !== position ? compactDock(next, current.position) : next
}

export function focusPanel(layout: PanelLayout, panelId: string): PanelLayout {
  const placement = layout.placements[panelId]
  if (!placement?.open) return layout
  if (placement.position === 'floating') return layout.floatingOrder.at(-1) === panelId ? layout : { ...layout, floatingOrder: bringToFront(layout.floatingOrder, panelId) }
  const key = sectionKey(placement.position, placement.slot)
  return layout.active[key] === panelId ? layout : { ...layout, active: { ...layout.active, [key]: panelId } }
}

export function setFloatingRect(layout: PanelLayout, panelId: string, rect: FloatingRect): PanelLayout {
  const placement = layout.placements[panelId]
  if (!placement) return layout
  return { ...layout, placements: { ...layout.placements, [panelId]: { ...placement, floating: rect } } }
}

export function resizeDock(layout: PanelLayout, dock: DockId, size: number, maximum: number): PanelLayout {
  const clamped = Math.round(Math.min(Math.max(MIN_DOCK_SIZE[dock], size), Math.max(MIN_DOCK_SIZE[dock], maximum)))
  return layout.sizes[dock] === clamped ? layout : { ...layout, sizes: { ...layout.sizes, [dock]: clamped } }
}

/**
 * Moves the boundary between two neighbouring sections by `delta` pixels.
 * `sizes` are the current pixel sizes of the two sections; each keeps at least MIN_SECTION_SIZE.
 */
export function resizeSections(layout: PanelLayout, dock: DockId, firstSlot: number, secondSlot: number, sizes: { first: number; second: number }, delta: number): PanelLayout {
  const total = sizes.first + sizes.second
  if (total <= 0) return layout
  const first = Math.min(Math.max(MIN_SECTION_SIZE, sizes.first + delta), Math.max(MIN_SECTION_SIZE, total - MIN_SECTION_SIZE))
  const weightTotal = sectionWeight(layout, dock, firstSlot) + sectionWeight(layout, dock, secondSlot)
  const firstWeight = Math.max(MIN_WEIGHT, (weightTotal * first) / total)
  const secondWeight = Math.max(MIN_WEIGHT, weightTotal - firstWeight)
  return { ...layout, weights: { ...layout.weights, [sectionKey(dock, firstSlot)]: firstWeight, [sectionKey(dock, secondSlot)]: secondWeight } }
}

/** Keeps a floating window reachable: at least its title bar stays inside the work area. */
export function clampFloatingRect(rect: FloatingRect, area: { width: number; height: number }): FloatingRect {
  const width = Math.round(Math.min(Math.max(MIN_FLOATING.width, rect.width), Math.max(MIN_FLOATING.width, area.width)))
  const height = Math.round(Math.min(Math.max(MIN_FLOATING.height, rect.height), Math.max(MIN_FLOATING.height, area.height)))
  const x = Math.round(Math.min(Math.max(0, rect.x), Math.max(0, area.width - Math.min(width, 120))))
  const y = Math.round(Math.min(Math.max(0, rect.y), Math.max(0, area.height - 36)))
  return { x, y, width, height }
}

/** Which edge zone the pointer is over while a panel is dragged (relative to the work area). */
export function dropZoneAt(point: { x: number; y: number }, area: { width: number; height: number }): DockId | null {
  const edge = Math.min(120, area.width * 0.18)
  const bottomEdge = Math.min(110, area.height * 0.22)
  if (point.x < 0 || point.y < 0 || point.x > area.width || point.y > area.height) return null
  if (point.x <= edge) return 'left'
  if (point.x >= area.width - edge) return 'right'
  if (point.y >= area.height - bottomEdge) return 'bottom'
  return null
}

/**
 * Over an existing section: its first third places the panel before it (above, or to the left in
 * the bottom dock), its last third after it, the middle adds it as a tab.
 */
export function sectionDropMode(point: { x: number; y: number }, rect: FloatingRect, dock: DockId): 'before' | 'after' | 'tab' {
  const along = dock === 'bottom' ? (point.x - rect.x) / rect.width : (point.y - rect.y) / rect.height
  if (along < 1 / 3) return 'before'
  if (along > 2 / 3) return 'after'
  return 'tab'
}
