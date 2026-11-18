/**
 * LIVE integration test against the real Claude Code engine.
 * Opt-in only: set AETHER_E2E_LIVE=1. It sends a handful of very short prompts
 * (consumes a small amount of your Claude usage) and requires `claude` to be installed and logged in.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.skip(!process.env.AETHER_E2E_LIVE, 'Set AETHER_E2E_LIVE=1 to run the live engine test.')
test.describe.configure({ mode: 'serial' })

const RESPONSE_TIMEOUT = 150_000
let userDataDirectory: string
let projectDirectory: string
let application: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  application = await electron.launch({ args: ['.'], env: { ...process.env, AETHER_USER_DATA_DIR: userDataDirectory, ELECTRON_RENDERER_URL: '' } })
  page = await application.firstWindow()
  await page.waitForSelector('nav')
  await expect(page.getByText(/Connecté/).first()).toBeVisible({ timeout: 60_000 })
}

async function send(text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: 'Message' })
  await box.fill(text)
  await box.press('Enter')
}

async function waitForIdle(): Promise<void> {
  await expect(page.getByRole('button', { name: 'Arrêter' })).toHaveCount(0, { timeout: RESPONSE_TIMEOUT })
}

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'aether-live-'))
  projectDirectory = mkdtempSync(join(tmpdir(), 'aether-live-project-'))
  await launch()
})

test.afterAll(async () => {
  await application?.close()
  rmSync(userDataDirectory, { recursive: true, force: true })
  rmSync(projectDirectory, { recursive: true, force: true })
})

test('creates a conversation in a project, picks a model and streams a real reply', async () => {
  await page.evaluate((directoryPath) => window.aether.invoke('projects:add', { directoryPath }), projectDirectory)
  await page.getByRole('button', { name: 'Projets' }).click()
  await page.getByRole('button', { name: 'Nouvelle conversation' }).last().click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()

  // Model list comes from Claude Code itself.
  await page.locator('button', { hasText: /Par défaut|Modèle par défaut/ }).first().click()
  const options = page.locator('div.fixed button').filter({ hasNotText: 'Par défaut' })
  await expect(options.first()).toBeVisible({ timeout: 60_000 })
  const haiku = options.filter({ hasText: /Haiku/i })
  if ((await haiku.count()) > 0) await haiku.first().click()
  else await options.first().click()

  await send('Réponds uniquement par le mot PONG, sans rien d’autre.')
  await expect(page.getByRole('button', { name: 'Arrêter' })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.prose-aether', { hasText: 'PONG' }).first()).toBeVisible({ timeout: RESPONSE_TIMEOUT })
  await waitForIdle()
  // The Claude session id is shown once system/init has been received.
  await expect(page.locator('header span.font-mono').first()).toHaveText(/^[0-9a-f-]{36}$/)
  await page.screenshot({ path: 'test-results/live-reply.png' })
})

test('asks for permission before writing, and honours a refusal', async () => {
  await send('Utilise l’outil Write pour créer le fichier refuse.txt contenant "non" dans le dossier courant. Ne fais rien d’autre.')
  await expect(page.getByText('Autorisation requise')).toBeVisible({ timeout: RESPONSE_TIMEOUT })
  await expect(page.getByRole('dialog')).toContainText('Write')
  await page.screenshot({ path: 'test-results/live-permission.png' })
  await page.getByRole('button', { name: 'Refuser' }).click()
  await waitForIdle()
  expect(existsSync(join(projectDirectory, 'refuse.txt'))).toBe(false)
})

test('executes the tool once allowed', async () => {
  await send('Utilise l’outil Write pour créer le fichier accepte.txt contenant "oui" dans le dossier courant. Ne fais rien d’autre.')
  await expect(page.getByText('Autorisation requise')).toBeVisible({ timeout: RESPONSE_TIMEOUT })
  await page.getByRole('button', { name: 'Autoriser' }).click()
  await waitForIdle()
  expect(existsSync(join(projectDirectory, 'accepte.txt'))).toBe(true)
})

test('interrupts a generation', async () => {
  await send('Écris les nombres de 1 à 400 en toutes lettres, un par ligne.')
  await expect(page.getByRole('button', { name: 'Arrêter' })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(2500)
  await page.getByRole('button', { name: 'Arrêter' }).click()
  await waitForIdle()
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeEnabled()
})

test('resumes the session after an application restart with its context', async () => {
  await application.close()
  await launch()
  await page.getByRole('button', { name: 'Conversations' }).click()
  await page.locator('aside button', { hasText: /PONG|Réponds/ }).first().click()
  // History is read back from Claude Code's transcript through the SDK.
  await expect(page.locator('[data-role="user-message"]', { hasText: 'PONG' }).first()).toBeVisible({ timeout: 30_000 })
  await send('Quel mot exact as-tu répondu à mon tout premier message ? Réponds par ce seul mot.')
  await expect(page.locator('.prose-aether', { hasText: 'PONG' }).last()).toBeVisible({ timeout: RESPONSE_TIMEOUT })
  await waitForIdle()
  const assistantTexts = await page.locator('.prose-aether').allTextContents()
  expect(assistantTexts.filter((text) => text.includes('PONG')).length).toBeGreaterThanOrEqual(2)
})

test('reads the official usage data without sending a prompt', async () => {
  await page.getByRole('button', { name: 'Consommation' }).click()
  await page.getByRole('button', { name: 'Vérifier maintenant' }).click()
  await expect(page.getByText(/Dernière vérification/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText(/Aujourd’hui/)).toBeVisible()
  await page.screenshot({ path: 'test-results/live-usage.png' })
})
