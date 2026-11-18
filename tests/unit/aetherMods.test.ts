import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { embeddedPanels, findModCommand, isModEnabled, modPanelId, parseModManifest, parseModPanelId, type AetherModEntry } from '../../src/shared/aetherMods'
import { parseGitLog, readGitGraph, sanitiseRemoteUrl } from '../../src/main/mods/gitReader'
import { ModRegistry, resolveModFile } from '../../src/main/mods/modRegistry'

const require = createRequire(import.meta.url)
const { layoutGraph } = require('../../resources/mods/arbo/graph.js') as {
  layoutGraph: (commits: { hash: string; parents: string[] }[]) => { rows: { hash: string; column: number; lines: { from: number; to: number }[] }[]; width: number }
}

const projectRoot = join(__dirname, '..', '..')
const temporaryDirectories: string[] = []
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'aether-mods-test-'))
  temporaryDirectories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const validManifest = {
  id: 'demo',
  name: 'Démo',
  version: '1.0.0',
  permissions: ['ui.toast'],
  panels: [{ id: 'main', title: 'Démo', entry: 'index.html' }],
  commands: [{ name: 'demo', opensPanel: 'main' }]
}

function writeMod(root: string, folder: string, manifest: unknown, files: Record<string, string> = { 'index.html': '<p>ok</p>' }): string {
  const directory = join(root, folder)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'aether-mod.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content)
  return directory
}

describe('mod manifests', () => {
  it('accepts the built-in arbo mod', () => {
    const parsed = parseModManifest(JSON.parse(readFileSync(join(projectRoot, 'resources/mods/arbo/aether-mod.json'), 'utf8')))
    expect(parsed.ok).toBe(true)
  })

  it('accepts the built-in limits mod, embedded under the conversation list', () => {
    const parsed = parseModManifest(JSON.parse(readFileSync(join(projectRoot, 'resources/mods/limites/aether-mod.json'), 'utf8')))
    expect(parsed).toMatchObject({ ok: true, manifest: { permissions: ['quota.read'], panels: [{ embed: 'conversation-list', embedHeight: 116 }] } })
    if (!parsed.ok) return
    const mod: AetherModEntry = { manifest: parsed.manifest, source: 'builtin', enabled: true, directoryPath: 'x' }
    expect(embeddedPanels([mod], 'conversation-list').map((item) => item.panel.id)).toEqual(['jauges'])
    expect(embeddedPanels([{ ...mod, enabled: false }], 'conversation-list')).toEqual([])
  })

  it('refuses a command opening an embedded panel', () => {
    expect(parseModManifest({ ...validManifest, panels: [{ ...validManifest.panels[0], embed: 'conversation-list' }] })).toMatchObject({ ok: false })
    expect(parseModManifest({ ...validManifest, commands: [], panels: [{ ...validManifest.panels[0], embed: 'conversation-list', embedHeight: 10 }] }).ok).toBe(false)
  })

  it('applies defaults and checks references', () => {
    const parsed = parseModManifest(validManifest)
    expect(parsed).toMatchObject({ ok: true, manifest: { description: '', panels: [{ defaultPosition: 'floating' }] } })
    expect(parseModManifest({ ...validManifest, commands: [{ name: 'demo', opensPanel: 'missing' }] })).toMatchObject({ ok: false })
    expect(parseModManifest({ ...validManifest, panels: [...validManifest.panels, validManifest.panels[0]] })).toMatchObject({ ok: false })
  })

  it('refuses unknown permissions, reserved ids and entries outside the mod', () => {
    expect(parseModManifest({ ...validManifest, permissions: ['fs.write'] }).ok).toBe(false)
    expect(parseModManifest({ ...validManifest, id: 'sdk' }).ok).toBe(false)
    expect(parseModManifest({ ...validManifest, id: 'Bad Id' }).ok).toBe(false)
    expect(parseModManifest({ ...validManifest, panels: [{ id: 'main', title: 'x', entry: '../outside.html' }] }).ok).toBe(false)
    expect(parseModManifest({ ...validManifest, panels: [{ id: 'main', title: 'x', entry: 'C:/Windows/x.html' }] }).ok).toBe(false)
  })

  it('built-in mods are on by default, installed mods off until switched on', () => {
    expect(isModEnabled('builtin', 'arbo', {})).toBe(true)
    expect(isModEnabled('user', 'demo', {})).toBe(false)
    expect(isModEnabled('user', 'demo', { demo: true })).toBe(true)
    expect(isModEnabled('builtin', 'arbo', { arbo: false })).toBe(false)
  })

  it('panel ids round-trip', () => {
    expect(parseModPanelId(modPanelId('arbo', 'graph'))).toEqual({ modId: 'arbo', panelId: 'graph' })
    expect(parseModPanelId('terminal')).toBeNull()
  })

  it('finds slash commands of enabled mods only', () => {
    const parsed = parseModManifest(validManifest)
    if (!parsed.ok) throw new Error(parsed.error)
    const mod: AetherModEntry = { manifest: parsed.manifest, source: 'user', enabled: true, directoryPath: 'x' }
    expect(findModCommand('/demo', [mod])?.command.opensPanel).toBe('main')
    expect(findModCommand('  /demo  extra words ', [mod])?.argumentsText).toBe('extra words')
    expect(findModCommand('/demonstration', [mod])).toBeNull()
    expect(findModCommand('please /demo', [mod])).toBeNull()
    expect(findModCommand('/demo', [{ ...mod, enabled: false }])).toBeNull()
  })
})

describe('mod registry', () => {
  it('lists built-in and installed mods, reports broken ones and duplicates', () => {
    const builtin = temporaryDirectory()
    const user = temporaryDirectory()
    writeMod(builtin, 'demo', validManifest)
    writeMod(user, 'copy', validManifest)
    writeMod(user, 'broken', { id: 'broken' })
    writeMod(user, 'missing-file', { ...validManifest, id: 'missing' }, {})
    mkdirSync(join(user, 'not-a-mod'))
    const registry = new ModRegistry({ builtinDirectory: builtin, userDirectory: user, getChoices: () => ({}) })
    const catalog = registry.catalog()
    expect(catalog.mods.map((mod) => [mod.manifest.id, mod.source, mod.enabled])).toEqual([['demo', 'builtin', true]])
    expect(catalog.errors.map((error) => error.error).join('\n')).toMatch(/déjà l’identifiant[\s\S]*name|name[\s\S]*déjà l’identifiant/)
    expect(catalog.errors.some((error) => /introuvable/.test(error.error))).toBe(true)
  })

  it('serves only regular files inside the mod folder', () => {
    const root = temporaryDirectory()
    const directory = writeMod(root, 'demo', validManifest, { 'index.html': 'x', 'panel.js': 'y' })
    mkdirSync(join(directory, 'sub'))
    writeFileSync(join(directory, 'sub', 'a.css'), 'z')
    writeFileSync(join(root, 'secret.txt'), 'secret')
    expect(resolveModFile(directory, '/index.html')).toBe(join(directory, 'index.html'))
    expect(resolveModFile(directory, '/sub/a.css')).toBe(join(directory, 'sub', 'a.css'))
    expect(resolveModFile(directory, '/../secret.txt')).toBeNull()
    expect(resolveModFile(directory, '/%2e%2e/secret.txt')).toBeNull()
    expect(resolveModFile(directory, '/sub/..%5C..%5Csecret.txt')).toBeNull()
    expect(resolveModFile(directory, '/C:/Windows/win.ini')).toBeNull()
    expect(resolveModFile(directory, '/sub')).toBeNull()
    expect(resolveModFile(directory, '/')).toBeNull()
    expect(resolveModFile(directory, '/nope.html')).toBeNull()
    expect(resolveModFile(directory, '/%E0%A4%A')).toBeNull()
  })
})

describe('git reader', () => {
  const field = '\x1f'
  const record = '\x1e'
  const sample = [
    ['c3'.padEnd(40, 'c'), `${'b2'.padEnd(40, 'b')} ${'a1'.padEnd(40, 'a')}`, 'HEAD -> main, origin/main, tag: v1.0', 'Ada', '1700000300', 'Merge branch feature'].join(field),
    ['b2'.padEnd(40, 'b'), 'a1'.padEnd(40, 'a'), '', 'Bob', '1700000200', 'Feature | with, punctuation'].join(field),
    ['a1'.padEnd(40, 'a'), '', '', 'Ada', '1700000100', 'Initial'].join(field)
  ]
    .map((line) => line + record + '\n')
    .join('')

  it('parses git log records', () => {
    const commits = parseGitLog(sample)
    expect(commits).toHaveLength(3)
    expect(commits[0]).toMatchObject({ parents: ['b2'.padEnd(40, 'b'), 'a1'.padEnd(40, 'a')], refs: ['HEAD -> main', 'origin/main', 'tag: v1.0'], author: 'Ada', timestamp: 1_700_000_300_000 })
    expect(commits[1]?.subject).toBe('Feature | with, punctuation')
    expect(commits[2]?.parents).toEqual([])
  })

  it('only runs read commands and reports what it found', async () => {
    const calls: string[][] = []
    const graph = await readGitGraph('C:\\repo', 2, async (args) => {
      calls.push(args)
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return 'C:/repo\n'
      if (args[0] === 'rev-parse') return 'main\n'
      if (args[0] === 'remote') return 'https://user:secret-token@github.com/owner/repo.git\n'
      return sample
    })
    expect(calls.map((args) => args[0])).toEqual(expect.arrayContaining(['rev-parse', 'log', 'remote']))
    expect(calls.every((args) => ['rev-parse', 'log', 'remote'].includes(args[0] ?? ''))).toBe(true)
    expect(calls.find((args) => args[0] === 'log')).toContain('--max-count=3')
    expect(graph).toMatchObject({ repositoryRoot: 'C:/repo', currentBranch: 'main', truncated: true, remoteUrl: 'https://github.com/owner/repo.git' })
    expect(graph.commits).toHaveLength(2)
  })

  it('explains a folder that is not a repository', async () => {
    await expect(
      readGitGraph('C:\\nope', 10, async () => {
        throw new Error('fatal: not a git repository (or any of the parent directories): .git')
      })
    ).rejects.toThrow('Ce dossier n’est pas un dépôt git.')
  })

  it('strips credentials from remote URLs', () => {
    expect(sanitiseRemoteUrl('https://x:token@github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(sanitiseRemoteUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(sanitiseRemoteUrl('')).toBeNull()
  })
})

describe('arbo graph layout', () => {
  it('keeps a straight history in one lane', () => {
    const layout = layoutGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(layout.rows.map((row) => row.column)).toEqual([0, 0, 0])
    expect(layout.rows[0]?.lines).toEqual([{ from: 0, to: 0 }])
    expect(layout.rows[2]?.lines).toEqual([])
    expect(layout.width).toBe(1)
  })

  it('opens a lane for a merged branch and closes it where the branches meet', () => {
    // m merges f into main; f and b both come from a.
    const layout = layoutGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    expect(layout.rows.map((row) => row.column)).toEqual([0, 1, 0, 0])
    expect(layout.rows[0]?.lines).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 1 }
    ])
    // f's lane bends into a, under the main lane.
    expect(layout.rows[2]?.lines).toEqual([{ from: 0, to: 0 }, { from: 1, to: 0 }])
    expect(layout.width).toBe(2)
  })

  it('draws a merge into a lane that already follows the merged parent', () => {
    const layout = layoutGraph([
      { hash: 't', parents: ['a'] },
      { hash: 'm', parents: ['x', 'a'] },
      { hash: 'x', parents: ['a'] },
      { hash: 'a', parents: [] }
    ])
    // t sits in lane 0 waiting for a; m (lane 1) merges a: it joins lane 0.
    expect(layout.rows[1]?.column).toBe(1)
    expect(layout.rows[1]?.lines).toEqual(expect.arrayContaining([{ from: 0, to: 0 }, { from: 1, to: 1 }, { from: 1, to: 0 }]))
  })
})
