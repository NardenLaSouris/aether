import { describe, expect, it } from 'vitest'
import {
  activePanelOf,
  clampFloatingRect,
  closePanel,
  DEFAULT_LAYOUT,
  dropZoneAt,
  floatingPanels,
  focusPanel,
  isPanelVisible,
  movePanel,
  normaliseLayout,
  openPanel,
  panelsInDock,
  panelsInSection,
  resizeDock,
  resizeSections,
  sectionDropMode,
  sectionsOf,
  sectionWeight,
  togglePanel,
  type PanelLayout
} from '../../src/shared/panelLayout'

const fresh = (): PanelLayout => structuredClone(DEFAULT_LAYOUT)
const bottom = { position: 'bottom' as const }
const floating = { position: 'floating' as const, floating: { width: 500, height: 400 } }

describe('panel layout', () => {
  it('opens a panel at its default place and shows it', () => {
    const layout = openPanel(fresh(), 'terminal', bottom)
    expect(layout.placements.terminal).toMatchObject({ position: 'bottom', open: true })
    expect(isPanelVisible(layout, 'terminal')).toBe(true)
    expect(panelsInDock(layout, 'bottom')).toEqual(['terminal'])
  })

  it('moves the terminal to the right dock, keeps it there when closed and reopened', () => {
    let layout = openPanel(fresh(), 'terminal', bottom)
    layout = movePanel(layout, 'terminal', 'right', bottom)
    expect(panelsInDock(layout, 'bottom')).toEqual([])
    expect(panelsInDock(layout, 'right')).toEqual(['terminal'])
    layout = closePanel(layout, 'terminal')
    expect(isPanelVisible(layout, 'terminal')).toBe(false)
    layout = openPanel(layout, 'terminal', bottom)
    expect(layout.placements.terminal?.position).toBe('right')
  })

  it('stacks panels of one dock as tabs and remembers the visible one', () => {
    let layout = openPanel(fresh(), 'terminal', bottom)
    layout = openPanel(layout, 'mod:arbo:graph', bottom)
    expect(panelsInDock(layout, 'bottom')).toEqual(['terminal', 'mod:arbo:graph'])
    expect(activePanelOf(layout, 'bottom')).toBe('mod:arbo:graph')
    layout = focusPanel(layout, 'terminal')
    expect(activePanelOf(layout, 'bottom')).toBe('terminal')
    expect(isPanelVisible(layout, 'mod:arbo:graph')).toBe(false)
    layout = closePanel(layout, 'terminal')
    expect(activePanelOf(layout, 'bottom')).toBe('mod:arbo:graph')
  })

  it('floats a panel at a given rectangle and brings the focused window to the front', () => {
    let layout = openPanel(fresh(), 'mod:arbo:graph', floating)
    layout = movePanel(layout, 'terminal', 'floating', bottom, { x: 40, y: 50, width: 600, height: 300 })
    expect(layout.placements.terminal?.floating).toEqual({ x: 40, y: 50, width: 600, height: 300 })
    expect(floatingPanels(layout)).toEqual(['mod:arbo:graph', 'terminal'])
    layout = focusPanel(layout, 'mod:arbo:graph')
    expect(floatingPanels(layout)).toEqual(['terminal', 'mod:arbo:graph'])
  })

  it('toggles a hidden tab to the front instead of closing it', () => {
    let layout = openPanel(fresh(), 'terminal', bottom)
    layout = openPanel(layout, 'mod:arbo:graph', bottom)
    layout = togglePanel(layout, 'terminal', bottom)
    expect(isPanelVisible(layout, 'terminal')).toBe(true)
    layout = togglePanel(layout, 'terminal', bottom)
    expect(layout.placements.terminal?.open).toBe(false)
  })

  it('clamps dock sizes and floating windows', () => {
    expect(resizeDock(fresh(), 'right', 50, 900).sizes.right).toBe(220)
    expect(resizeDock(fresh(), 'right', 5000, 900).sizes.right).toBe(900)
    expect(clampFloatingRect({ x: -50, y: 5000, width: 10, height: 10 }, { width: 1000, height: 700 })).toEqual({ x: 0, y: 664, width: 240, height: 160 })
  })

  it('finds the drop zone under the pointer', () => {
    const area = { width: 1200, height: 800 }
    expect(dropZoneAt({ x: 30, y: 400 }, area)).toBe('left')
    expect(dropZoneAt({ x: 1180, y: 400 }, area)).toBe('right')
    expect(dropZoneAt({ x: 600, y: 780 }, area)).toBe('bottom')
    expect(dropZoneAt({ x: 600, y: 300 }, area)).toBeNull()
    expect(dropZoneAt({ x: -5, y: 300 }, area)).toBeNull()
  })

  it('stacks Arbo below the terminal on the right, each in its own section', () => {
    let layout = openPanel(fresh(), 'terminal', bottom)
    layout = movePanel(layout, 'terminal', 'right', bottom)
    layout = openPanel(layout, 'mod:arbo:graph', floating)
    layout = movePanel(layout, 'mod:arbo:graph', 'right', floating, undefined, { mode: 'after', slot: 0 })
    expect(sectionsOf(layout, 'right')).toEqual([0, 1])
    expect(panelsInSection(layout, 'right', 0)).toEqual(['terminal'])
    expect(panelsInSection(layout, 'right', 1)).toEqual(['mod:arbo:graph'])
    // Both are visible at once (two sections, not two tabs).
    expect(isPanelVisible(layout, 'terminal')).toBe(true)
    expect(isPanelVisible(layout, 'mod:arbo:graph')).toBe(true)
    expect(floatingPanels(layout)).toEqual([])
  })

  it('inserts a section above another and renumbers the sections', () => {
    let layout = movePanel(openPanel(fresh(), 'terminal', bottom), 'terminal', 'right', bottom)
    layout = movePanel(layout, 'mod:a:p', 'right', floating, undefined, { mode: 'after', slot: 0 })
    layout = movePanel(layout, 'mod:b:p', 'right', floating, undefined, { mode: 'before', slot: 0 })
    expect(sectionsOf(layout, 'right').map((slot) => panelsInSection(layout, 'right', slot))).toEqual([['mod:b:p'], ['terminal'], ['mod:a:p']])
    // Leaving a section removes it and the others close the gap.
    layout = movePanel(layout, 'terminal', 'floating', bottom)
    expect(sectionsOf(layout, 'right')).toEqual([0, 1])
    expect(panelsInSection(layout, 'right', 1)).toEqual(['mod:a:p'])
  })

  it('adds a panel as a tab of an existing section', () => {
    let layout = movePanel(openPanel(fresh(), 'terminal', bottom), 'terminal', 'right', bottom)
    layout = movePanel(layout, 'mod:arbo:graph', 'right', floating, undefined, { mode: 'tab', slot: 0 })
    expect(sectionsOf(layout, 'right')).toEqual([0])
    expect(panelsInSection(layout, 'right', 0)).toEqual(['terminal', 'mod:arbo:graph'])
    expect(activePanelOf(layout, 'right', 0)).toBe('mod:arbo:graph')
  })

  it('resizes neighbouring sections and keeps each above its minimum', () => {
    let layout = movePanel(openPanel(fresh(), 'terminal', bottom), 'terminal', 'right', bottom)
    layout = movePanel(layout, 'mod:arbo:graph', 'right', floating, undefined, { mode: 'after', slot: 0 })
    const resized = resizeSections(layout, 'right', 0, 1, { first: 400, second: 400 }, 200)
    expect(sectionWeight(resized, 'right', 0) / sectionWeight(resized, 'right', 1)).toBeCloseTo(600 / 200)
    const squeezed = resizeSections(layout, 'right', 0, 1, { first: 400, second: 400 }, 5000)
    expect((sectionWeight(squeezed, 'right', 1) / 2) * 800).toBeGreaterThanOrEqual(89)
  })

  it('places by thirds over a section', () => {
    const rect = { x: 0, y: 100, width: 300, height: 300 }
    expect(sectionDropMode({ x: 50, y: 120 }, rect, 'right')).toBe('before')
    expect(sectionDropMode({ x: 50, y: 250 }, rect, 'right')).toBe('tab')
    expect(sectionDropMode({ x: 50, y: 390 }, rect, 'right')).toBe('after')
    expect(sectionDropMode({ x: 280, y: 120 }, rect, 'bottom')).toBe('after')
  })

  it('reads layouts saved before sections existed', () => {
    const old = { version: 1, placements: { terminal: { position: 'right', open: true, floating: { x: 0, y: 0, width: 300, height: 200 } } }, sizes: { left: 300, right: 300, bottom: 300 }, active: { right: 'terminal' }, floatingOrder: [] }
    const read = normaliseLayout(old)
    expect(read.placements.terminal?.slot).toBe(0)
    expect(read.active).toEqual({ 'right:0': 'terminal' })
    expect(isPanelVisible(read, 'terminal')).toBe(true)
  })

  it('reads stored layouts defensively', () => {
    expect(normaliseLayout(null)).toEqual(DEFAULT_LAYOUT)
    expect(normaliseLayout({ version: 2 })).toEqual(DEFAULT_LAYOUT)
    const stored = openPanel(fresh(), 'terminal', bottom)
    stored.sizes.left = 10
    const read = normaliseLayout(JSON.parse(JSON.stringify(stored)))
    expect(read.placements.terminal?.open).toBe(true)
    expect(read.sizes.left).toBe(220)
  })
})
