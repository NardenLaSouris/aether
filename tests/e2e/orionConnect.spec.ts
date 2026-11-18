/**
 * ORION CONNECT (mod installé à chaud) dans la vraie application, contre un vrai ORION APPS.
 * Ne tourne que si ORION_CONNECT_E2E_URL (adresse du Core), ORION_CONNECT_E2E_CODE (code d'appairage) et
 * ORION_CONNECT_MOD_DIR (dossier du mod) sont donnés. Profil isolé : les données d'Aether ne sont pas touchées.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.ORION_CONNECT_E2E_URL ?? ''
const CODE = process.env.ORION_CONNECT_E2E_CODE ?? ''
const MOD = process.env.ORION_CONNECT_MOD_DIR ?? ''
const SHOTS = process.env.ORION_CONNECT_SHOTS ?? 'test-results'

let application: ElectronApplication
let page: Page
let userDataDirectory: string
const consoleErrors: string[] = []

test.describe.configure({ mode: 'serial' })
test.skip(!URL_ || !CODE || !MOD, 'ORION_CONNECT_E2E_URL, ORION_CONNECT_E2E_CODE et ORION_CONNECT_MOD_DIR requis')

async function frame(): Promise<Frame> {
  await expect.poll(() => page.frames().some((item) => item.url().startsWith('aether-mod://orion-connect/')), { timeout: 15_000 }).toBe(true)
  return page.frames().find((item) => item.url().startsWith('aether-mod://orion-connect/')) as Frame
}

async function tab(name: string): Promise<Frame> {
  const panel = await frame()
  await panel.getByRole("button", { name, exact: true }).first().click()
  return panel
}

test.beforeAll(async () => {
  userDataDirectory = mkdtempSync(join(tmpdir(), 'aether-e2e-orion-'))
  mkdirSync(join(userDataDirectory, 'mods'), { recursive: true })
  cpSync(MOD, join(userDataDirectory, 'mods', 'orion-connect'), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
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

test('the mod installed in the folder is off until switched on, then gets its page', async () => {
  await page.getByRole('button', { name: /Extensions/ }).click()
  await page.getByRole('tab', { name: /Mods Aether/ }).click()
  await expect(page.getByText('ORION CONNECT', { exact: true }).first()).toBeVisible()
  await page.getByRole('switch', { name: 'Activer ORION CONNECT' }).or(page.getByLabel('Activer ORION CONNECT')).first().click()
  const dialog = page.getByRole('dialog')
  if (await dialog.isVisible().catch(() => false)) {
    await expect(dialog).toContainText('Se connecter à ORION')
    await dialog.getByRole('button', { name: /Activer/ }).click()
  }
  await page.screenshot({ path: join(SHOTS, '01-mod-active.png') })
  await page.locator('nav').getByRole('button', { name: 'ORION', exact: true }).click()
  const panel = await frame()
  await expect(panel.locator('#badge')).toHaveText('Déconnecté')
  await page.screenshot({ path: join(SHOTS, '02-connexion.png') })
})

test('a wrong code is refused, the right one pairs and connects', async () => {
  const panel = await tab('Connexion')
  await panel.getByLabel('Adresse du Core').fill(URL_)
  await panel.getByRole('button', { name: 'Tester' }).click()
  await expect(panel.getByRole('status')).toContainText('ORION répond')
  await panel.getByLabel('Code d’appairage').fill('ZZZZ-ZZZZ')
  await panel.getByRole('button', { name: 'Appairer' }).click()
  await expect(panel.locator('#badge')).toHaveText('Authentification refusée')
  await page.screenshot({ path: join(SHOTS, '03-refus.png') })
  await panel.getByLabel('Code d’appairage').fill(CODE)
  await panel.getByRole('button', { name: 'Appairer' }).click()
  await expect(panel.locator('#badge')).toHaveText('Connecté', { timeout: 15_000 })
  const saved = readFileSync(join(userDataDirectory, 'orion-connect.json'), 'utf8')
  expect(saved).not.toMatch(/session/i)
  expect(JSON.parse(saved).secret).toBeTruthy()
  await page.screenshot({ path: join(SHOTS, '04-connecte.png') })
})

test('applications, capabilities and permissions come from ORION APPS', async () => {
  const panel = await tab('Applications')
  await expect(panel.getByText('Carnet d\'exemple').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '05-applications.png') })
  await panel.getByText('Carnet d\'exemple').first().click()
  await expect(panel.getByText('notes.add').first()).toBeVisible()
  await expect(panel.getByText('confirmation à chaque fois').first()).toBeVisible()
  await panel.getByRole('button', { name: 'Lire' }).first().click()
  await expect(panel.locator('pre').first()).toContainText('Note d')
  await page.screenshot({ path: join(SHOTS, '06-fiche.png') })
})

test('an action is requested, authorized and executed; a sensitive one waits for ORION', async () => {
  const panel = await frame()
  const row = panel.locator('tr', { hasText: 'notes.add' })
  await row.getByRole('button', { name: 'Exécuter' }).click()
  await panel.locator('label.field', { hasText: 'text' }).locator('input').fill('Écrite depuis AETHER')
  await panel.getByRole('button', { name: 'Envoyer la demande' }).click()
  await expect(panel.getByText('3. Exécutée (résultat confirmé)')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: join(SHOTS, '07-action-executee.png') })
  await panel.locator('tr', { hasText: 'notes.clear' }).getByRole('button', { name: /Demander/ }).click()
  await panel.getByRole('button', { name: 'Envoyer la demande' }).click()
  await expect(panel.getByText('2. Attend votre confirmation')).toBeVisible({ timeout: 15_000 })
  await page.screenshot({ path: join(SHOTS, '08-attente-confirmation.png') })
})

test('activity distinguishes requested, authorized and executed', async () => {
  const panel = await tab('Activité')
  await expect(panel.getByText('exécutée').first()).toBeVisible()
  await expect(panel.getByText('attend votre confirmation').first()).toBeVisible()
  await expect(panel.getByText('connexion').first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '09-activite.png') })
})

test('a report is produced, listed and opened in full', async () => {
  const panel = await tab('Rapports')
  await panel.getByRole('button', { name: 'Produire' }).click()
  await expect(panel.getByText('Sources utilisées')).toBeVisible({ timeout: 15_000 })
  await expect(panel.getByText('Actions réellement exécutées')).toBeVisible()
  await expect(panel.getByText(/notes\.add/).first()).toBeVisible()
  await page.screenshot({ path: join(SHOTS, '10-rapport.png'), fullPage: true })
})

test('settings persist; the charcoal theme applies', async () => {
  const panel = await tab('Paramètres')
  await panel.getByRole('spinbutton').fill('45')
  await panel.getByRole('button', { name: 'Enregistrer' }).click()
  await expect.poll(() => JSON.parse(readFileSync(join(userDataDirectory, 'orion-connect.json'), 'utf8')).preferences.refreshSeconds).toBe(45)
  await page.screenshot({ path: join(SHOTS, '11-parametres-foret.png') })
  await panel.evaluate(() => document.body.classList.add('charcoal'))
  await page.screenshot({ path: join(SHOTS, '12-parametres-charbon.png') })
})

test('editing the mod on disk reloads it without restarting Aether', async () => {
  const before = (await frame()).url()
  appendFileSync(join(userDataDirectory, 'mods', 'orion-connect', 'panel.css'), '\n/* rechargement à chaud */\n')
  await expect.poll(async () => (await frame()).url(), { timeout: 15_000 }).not.toBe(before)
  const panel = await frame()
  await expect(panel.locator('#badge')).toHaveText('Connecté', { timeout: 15_000 })
})

test('a mod cannot reach ORION Control routes, even through the bridge', async () => {
  const panel = await frame()
  const answer = await panel.evaluate(async () => {
    const bridge = (window as unknown as { aether: { call: (m: string, p: unknown) => Promise<unknown> } }).aether
    try {
      await bridge.call('orion.request', { method: 'POST', path: 'apps/sample-notes/grant', body: { capability: 'notes.clear' } })
      return 'passé'
    } catch (error) {
      return (error as Error).message
    }
  })
  expect(answer).toContain('Route ORION non permise')
  const network = await panel.evaluate(async () => {
    try {
      await fetch('http://127.0.0.1:8896/api/connect/v1/info')
      return 'réseau'
    } catch {
      return 'bloqué'
    }
  })
  expect(network).toBe('bloqué')
})

test('another mod never gets the ORION rights, not even by asking the main process directly', async () => {
  const refused = await page.evaluate(async () => {
    const bridge = (window as unknown as { aether: { invoke: (channel: string, payload: unknown) => Promise<unknown> } }).aether
    try {
      await bridge.invoke('mods:orion', { modId: 'arbo', operation: 'request', params: { method: 'GET', path: 'apps' } })
      return 'passé'
    } catch (error) {
      return (error as Error).message
    }
  })
  expect(refused).toContain('orion.connect')
  const saved = readFileSync(join(userDataDirectory, 'orion-connect.json'), 'utf8')
  const panel = await frame()
  const seen = await panel.evaluate(async () => JSON.stringify(await (window as unknown as { aether: { call: (m: string) => Promise<unknown> } }).aether.call('orion.status')))
  const secret = JSON.parse(saved).secret as string
  expect(seen).not.toContain(secret)
  expect(seen).not.toMatch(/session-|client_secret/)
})

test('disabling the mod removes its page; ORION is unaffected', async () => {
  await page.getByRole('button', { name: /Extensions/ }).click()
  await page.getByRole('tab', { name: /Mods Aether/ }).click()
  await page.getByLabel('Désactiver ORION CONNECT').first().click()
  await expect(page.locator('nav').getByRole('button', { name: 'ORION', exact: true })).toHaveCount(0)
  const response = await fetch(`${URL_}/api/connect/v1/info`)
  expect(response.status).toBe(200)
  writeFileSync(join(SHOTS, 'console-errors.txt'), consoleErrors.join('\n'))
  expect(consoleErrors.filter((line) => !/Content Security Policy|net::ERR/i.test(line))).toEqual([])
})
