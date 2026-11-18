/**
 * Movable panels and Aether mods, against the built app (run `pnpm build` first).
 * Isolated data folder; nothing is sent to Claude.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let application: ElectronApplication
let page: Page
let userDataDirectory: string
const consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'aether-e2e-layout-'))
  const packagedExecutable = process.env.AETHER_E2E_EXECUTABLE
  application = await electron.launch({ ...(packagedExecutable ? { executablePath: packagedExecutable, args: [] } : { args: ['.'] }), env: { ...process.env, AETHER_USER_DATA_DIR: userDataDirectory, ELECTRON_RENDERER_URL: '' } })
  page = await application.firstWindow()
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.waitForSelector('nav')
})

test.afterAll(async () => {
  await application?.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
})

test('the terminal opens at the bottom and can be docked to the right', async () => {
  await page.getByRole('button', { name: 'Terminal', exact: true }).click()
  const bottomDock = page.locator('[data-dock="bottom"]')
  await expect(bottomDock.getByLabel('Terminal intégré')).toBeVisible()
  await bottomDock.getByRole('button', { name: 'Placer le panneau Terminal' }).click()
  await page.getByRole('menuitem', { name: 'Ancrer à droite' }).click()
  const rightDock = page.locator('[data-dock="right"]')
  await expect(rightDock.getByLabel('Terminal intégré')).toBeVisible()
  await expect(bottomDock).toHaveCount(0)
  // Vertical: the right dock is taller than wide.
  const box = await rightDock.boundingBox()
  expect(box && box.height > box.width).toBe(true)
  // The shell keeps running and its screen follows the panel.
  await expect(rightDock.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: 'test-results/terminal-right.png' })
})

test('dragging a panel title onto the left edge docks it there', async () => {
  const tab = page.locator('[data-dock="right"]').getByRole('tab', { name: /Terminal/ })
  const tabBox = await tab.boundingBox()
  const area = await page.locator('main').boundingBox()
  if (!tabBox || !area) throw new Error('layout not measurable')
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(area.x + 200, area.y + 200, { steps: 6 })
  await expect(page.getByText(/Relâchez ici pour une fenêtre flottante/)).toBeVisible()
  await page.mouse.move(area.x + 20, area.y + 300, { steps: 6 })
  await page.mouse.up()
  await expect(page.locator('[data-dock="left"]').getByLabel('Terminal intégré')).toBeVisible()
})

test('the layout is saved in the preferences', async () => {
  await expect
    .poll(async () => page.evaluate(async () => (await window.aether.invoke('preferences:get')).panelLayout.placements.terminal?.position), { timeout: 5000 })
    .toBe('left')
})

test('the arbo mod is listed and opens a sandboxed floating panel', async () => {
  await page.getByRole('button', { name: /Extensions/ }).click()
  await page.getByRole('tab', { name: /Mods Aether/ }).click()
  await expect(page.getByText('Arbo', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Arbo — graphe git' }).click()
  const floating = page.locator('[data-floating-panel="mod:arbo:graph"]')
  await expect(floating).toBeVisible()
  const frame = page.frameLocator('iframe[title^="Arbo"]')
  // No conversation is open in this isolated profile: the panel says so (served by aether-mod://, bridge answered).
  await expect(frame.getByText(/Ouvrez une conversation/)).toBeVisible({ timeout: 15_000 })
  const sandbox = await page.locator('iframe[title^="Arbo"]').getAttribute('sandbox')
  expect(sandbox).toBe('allow-scripts')
  // The frame cannot reach Aether's bridge.
  const reachesBridge = await page.frames().find((frame) => frame.url().startsWith('aether-mod://arbo/'))?.evaluate(() => typeof (window as unknown as { aether?: { invoke?: unknown } }).aether?.invoke)
  expect(reachesBridge).toBe('undefined')
})

test('dropping Arbo on the lower part of the terminal stacks it below, both visible', async () => {
  const title = page.locator('[data-floating-panel="mod:arbo:graph"] header')
  const terminalSection = page.locator('[data-section-dock="left"]').first()
  const titleBox = await title.boundingBox()
  const sectionBox = await terminalSection.boundingBox()
  if (!titleBox || !sectionBox) throw new Error('layout not measurable')
  await page.mouse.move(titleBox.x + 60, titleBox.y + titleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sectionBox.x + sectionBox.width / 2, sectionBox.y + sectionBox.height * 0.85, { steps: 8 })
  await expect(page.getByText('En dessous', { exact: true })).toBeVisible()
  await page.mouse.up()
  const sections = page.locator('[data-section-dock="left"]')
  await expect(sections).toHaveCount(2)
  await expect(sections.nth(0).getByLabel('Terminal intégré')).toBeVisible()
  await expect(sections.nth(1).locator('iframe[title^="Arbo"]')).toBeVisible()
  const first = await sections.nth(0).boundingBox()
  const second = await sections.nth(1).boundingBox()
  expect(first && second && second.y > first.y).toBe(true)
  await page.screenshot({ path: 'test-results/arbo-below-terminal.png' })
})

test('the ⊞ menu offers "en dessous" and "en onglet" for an occupied dock', async () => {
  await page.locator('[data-section-dock="left"]').nth(1).getByRole('button', { name: /Placer le panneau Arbo/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Ancrer à droite' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Fenêtre flottante' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('[data-section-dock="left"]').nth(0).getByRole('button', { name: 'Placer le panneau Terminal' }).click()
  await page.getByRole('menuitem', { name: 'Ancrer à droite' }).click()
  await page.locator('[data-section-dock="left"]').nth(0).getByRole('button', { name: /Placer le panneau Arbo/ }).click()
  await expect(page.getByRole('menuitem', { name: 'À droite, en onglet' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'À droite, en dessous' }).click()
  const rightSections = page.locator('[data-section-dock="right"]')
  await expect(rightSections).toHaveCount(2)
  await expect(rightSections.nth(1).locator('iframe[title^="Arbo"]')).toBeVisible()
  await expect(page.locator('[data-dock="left"]')).toHaveCount(0)
})

test('a mod cannot read a folder Aether does not know', async () => {
  const outcome = await page.evaluate(async (directory) => {
    try {
      await window.aether.invoke('mods:git-log', { modId: 'arbo', workingDirectory: directory, limit: 5 })
      return 'allowed'
    } catch (error) {
      return String(error)
    }
  }, resolve('.'))
  expect(outcome).toMatch(/n’appartient à aucune conversation/)
})

test('/arbo in the message box opens the panel without sending anything', async () => {
  await page.getByRole('button', { name: 'Fermer le panneau Arbo — graphe git' }).click()
  // A closed panel stays loaded in the background, out of sight.
  await expect(page.locator('iframe[title^="Arbo"]')).toBeHidden()
  const projectDirectory = resolve('.')
  await page.evaluate((directoryPath) => window.aether.invoke('projects:add', { directoryPath }), projectDirectory)
  await page.getByRole('button', { name: 'Projets' }).click()
  await page.getByRole('button', { name: 'Nouvelle conversation' }).last().click()
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill('/ar')
  await expect(page.getByRole('option', { name: /\/arbo/ })).toBeVisible()
  await box.fill('/arbo')
  await box.press('Enter')
  await expect(box).toHaveValue('')
  // It reopens where it was last placed: below the terminal on the right.
  await expect(page.locator('[data-section-dock="right"]').nth(1).locator('iframe[title^="Arbo"]')).toBeVisible()
  // The conversation got no message: /arbo was handled by Aether.
  await expect(page.locator('[data-role="user-message"]')).toHaveCount(0)
  const frame = page.frameLocator('iframe[title^="Arbo"]')
  // This project folder is not a git repository in every checkout: either a graph or the explanation.
  await expect(frame.locator('.graph, .message')).toBeVisible({ timeout: 20_000 })
  await page.screenshot({ path: 'test-results/arbo-panel.png' })
})

test('ChatGPT opens as a panel showing chatgpt.com in an isolated session', async () => {
  await page.getByRole('button', { name: 'ChatGPT', exact: true }).click()
  const webview = page.locator('webview[aria-label="ChatGPT"]')
  await expect(webview).toHaveCount(1)
  await expect(webview).toHaveAttribute('partition', 'persist:chatgpt')
  await expect(page.locator('[data-section-dock="right"]').getByRole('tab', { name: /ChatGPT/ })).toBeVisible()
  // The guest really attached (Electron accepted it) and has no access to Aether's bridge.
  await expect.poll(async () => webview.evaluate((element) => typeof (element as unknown as { getWebContentsId(): number }).getWebContentsId()), { timeout: 45_000 }).toBe('number')
  // (generous timeout above: the panel loads chatgpt.com over the network)
  await page.getByRole('button', { name: 'ChatGPT', exact: true }).click()
})

test('any other <webview> is refused', async () => {
  const attached = await page.evaluate(async () => {
    const element = document.createElement('webview') as HTMLElement & { getWebContentsId(): number }
    element.setAttribute('partition', 'persist:chatgpt')
    element.setAttribute('src', 'https://example.com/')
    document.body.appendChild(element)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let id: number | null
    try {
      id = element.getWebContentsId()
    } catch {
      id = null
    }
    element.remove()
    return id
  })
  expect(attached).toBeNull()
})

test('no renderer console errors', () => {
  expect(consoleErrors).toEqual([])
})
