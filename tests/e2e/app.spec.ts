/**
 * UI tests against the built Electron app (run `pnpm build` first).
 * They use an isolated data folder and never send a prompt to Claude (no quota is consumed).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let application: ElectronApplication
let page: Page
let userDataDirectory: string
const consoleErrors: string[] = []

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'aether-e2e-'))
  // AETHER_E2E_EXECUTABLE=dist/win-unpacked/Aether.exe runs the same tests against the packaged build.
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

test('window opens with custom title bar and navigation', async () => {
  await expect(page.getByRole('button', { name: 'Fermer', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Aether' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Conversations' })).toBeVisible()
  await page.screenshot({ path: 'test-results/home.png' })
})

test('renderer has no Node.js access', async () => {
  const exposure = await page.evaluate(() => ({ require: typeof (window as unknown as { require?: unknown }).require, process: typeof (window as unknown as { process?: unknown }).process, bridge: typeof window.aether }))
  expect(exposure).toEqual({ require: 'undefined', process: 'undefined', bridge: 'object' })
})

test('preload rejects channels outside the whitelist', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await (window.aether as unknown as { invoke: (channel: string) => Promise<unknown> }).invoke('fs:read-anything')
      return 'accepted'
    } catch (error) {
      return String(error)
    }
  })
  expect(outcome).toContain('non autorisé')
})

test('main process rejects invalid payloads', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await (window.aether as unknown as { invoke: (channel: string, payload: unknown) => Promise<unknown> }).invoke('conversations:rename', { conversationId: '../../etc', title: '' })
      return 'accepted'
    } catch (error) {
      return String(error)
    }
  })
  expect(outcome).toContain('invalides')
})

test('conversation lifecycle: create, rename, archive, delete', async () => {
  await page.getByRole('button', { name: 'Conversations' }).click()
  await page.getByRole('button', { name: 'Nouvelle conversation' }).first().click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Nouvelle conversation' })).toBeVisible()

  await page.getByRole('button', { name: 'Actions' }).last().click()
  await page.getByRole('menuitem', { name: 'Renommer' }).click()
  await page.getByLabel('Titre').fill('Essai E2E')
  await page.getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('heading', { name: 'Essai E2E' })).toBeVisible()

  await page.getByRole('textbox', { name: 'Message' }).fill('ligne 1')
  await page.getByRole('textbox', { name: 'Message' }).press('Shift+Enter')
  await page.getByRole('textbox', { name: 'Message' }).pressSequentially('ligne 2')
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('ligne 1\nligne 2')
  await page.getByRole('textbox', { name: 'Message' }).fill('')
  await page.screenshot({ path: 'test-results/conversation.png' })

  await page.getByRole('button', { name: 'Actions' }).last().click()
  await page.getByRole('menuitem', { name: 'Archiver' }).click()
  await expect(page.getByText('Aucune conversation sélectionnée')).toBeVisible()
  await page.getByLabel('Afficher les archives').check()
  await page.getByText('Essai E2E').click()
  await page.getByRole('button', { name: 'Actions' }).last().click()
  await page.getByRole('menuitem', { name: 'Supprimer' }).click()
  await expect(page.getByText('Supprimer la conversation ?')).toBeVisible()
  await page.getByRole('button', { name: 'Supprimer', exact: true }).click()
  await expect(page.getByText('Essai E2E')).toHaveCount(0)
})

test('pages render: projects, sessions, usage, settings', async () => {
  await page.getByRole('button', { name: 'Projets' }).click()
  await expect(page.getByRole('heading', { name: 'Projets' })).toBeVisible()
  await page.getByRole('button', { name: 'Sessions Claude Code' }).click()
  await expect(page.getByRole('heading', { name: 'Sessions Claude Code' })).toBeVisible()
  await page.screenshot({ path: 'test-results/sessions.png' })
  await page.getByRole('button', { name: 'Consommation' }).click()
  await expect(page.getByRole('heading', { name: 'Consommation et quotas' })).toBeVisible()
  await page.screenshot({ path: 'test-results/usage.png' })
  await page.getByRole('button', { name: 'Paramètres' }).click()
  await expect(page.getByRole('heading', { name: 'Paramètres' })).toBeVisible()
  await page.screenshot({ path: 'test-results/settings.png' })
})

test('no renderer console errors', async () => {
  expect(consoleErrors.filter((text) => !text.includes('Autofill'))).toEqual([])
})
