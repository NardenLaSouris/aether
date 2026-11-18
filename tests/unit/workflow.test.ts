import { describe, expect, it } from 'vitest'
import { buildAnswers, readPlan, readQuestions } from '../../src/shared/claudeRequests'
import { parseNumstat, parseStatusPorcelain, parseUnifiedDiff, syntheticAddedDiff } from '../../src/shared/changes'
import { findMentionQuery, imageFromDataUrl, insertMention } from '../../src/shared/composer'
import { deriveTodos } from '../../src/shared/timeline'
import type { TimelineItem } from '../../src/shared/domain'
import { rankFiles } from '../../src/main/services/fileSearch'
import { resolveInside } from '../../src/main/services/changesService'

describe('Claude’s questions', () => {
  const input = {
    questions: [
      { question: 'Quelle base ?', header: 'Base', multiSelect: false, options: [{ label: 'SQLite', description: 'locale' }, { label: 'Postgres', description: 'serveur', preview: 'docker run postgres' }] },
      { question: 'Quels tests ?', header: 'Tests', multiSelect: true, options: [{ label: 'Unitaires', description: '' }, { label: 'E2E', description: '' }] }
    ]
  }

  it('reads the questions and tolerates a malformed input', () => {
    expect(readQuestions(input)).toHaveLength(2)
    expect(readQuestions(input)[0]?.options[1]).toEqual({ label: 'Postgres', description: 'serveur', preview: 'docker run postgres' })
    expect(readQuestions({ questions: 'oops' })).toEqual([])
    expect(readQuestions(null)).toEqual([])
  })

  it('builds one answer per question, joining several choices and free text', () => {
    const questions = readQuestions(input)
    expect(buildAnswers(questions, { 0: ['SQLite'] }, {})).toBeNull()
    expect(buildAnswers(questions, { 0: ['SQLite'], 1: ['Unitaires', 'E2E'] }, {})).toEqual({ 'Quelle base ?': 'SQLite', 'Quels tests ?': 'Unitaires, E2E' })
    expect(buildAnswers(questions, { 0: ['SQLite'], 1: ['E2E'] }, { 0: 'MongoDB', 1: 'charge' })).toEqual({ 'Quelle base ?': 'MongoDB', 'Quels tests ?': 'E2E, charge' })
    expect(buildAnswers(questions, { 0: ['Inventé'], 1: ['E2E'] }, {})).toBeNull()
  })

  it('reads the plan text', () => {
    expect(readPlan({ plan: '# Plan\n1. Faire' })).toBe('# Plan\n1. Faire')
    expect(readPlan({})).toBe('')
  })
})

describe('Claude’s task list', () => {
  const assistant = (blocks: { toolUseId: string; toolName: string; input: unknown }[], parentToolUseId: string | null = null): TimelineItem => ({ kind: 'assistant', id: blocks[0]?.toolUseId ?? 'x', blocks: blocks.map((block) => ({ kind: 'tool_use', ...block })), model: null, timestamp: 0, streaming: false, parentToolUseId })

  it('keeps the last TodoWrite list of the main conversation', () => {
    const items: TimelineItem[] = [
      assistant([{ toolUseId: 't1', toolName: 'TodoWrite', input: { todos: [{ content: 'Lire', status: 'completed', activeForm: 'Lecture' }, { content: 'Écrire', status: 'in_progress', activeForm: 'Écriture' }] } }]),
      assistant([{ toolUseId: 't2', toolName: 'TodoWrite', input: { todos: [{ content: 'Sous-agent', status: 'pending', activeForm: 'x' }] } }], 'parent')
    ]
    expect(deriveTodos(items)).toEqual([
      { id: '1', content: 'Lire', activeForm: 'Lecture', status: 'completed' },
      { id: '2', content: 'Écrire', activeForm: 'Écriture', status: 'in_progress' }
    ])
    expect(deriveTodos([])).toBeNull()
  })

  it('follows TaskCreate and TaskUpdate', () => {
    const items: TimelineItem[] = [
      assistant([{ toolUseId: 'c1', toolName: 'TaskCreate', input: { subject: 'Tests', activeForm: 'Tests en cours' } }]),
      { kind: 'tool_result', id: 'r1', toolUseId: 'c1', content: 'Task #7 created successfully', isError: false, timestamp: 0 },
      assistant([{ toolUseId: 'c2', toolName: 'TaskCreate', input: { subject: 'Doc' } }]),
      assistant([{ toolUseId: 'u1', toolName: 'TaskUpdate', input: { taskId: '7', status: 'in_progress' } }]),
      assistant([{ toolUseId: 'u2', toolName: 'TaskUpdate', input: { taskId: '2', status: 'deleted' } }])
    ]
    expect(deriveTodos(items)).toEqual([{ id: '7', content: 'Tests', activeForm: 'Tests en cours', status: 'in_progress' }])
  })
})

describe('message box', () => {
  it('finds the @query before the caret and inserts the mention', () => {
    expect(findMentionQuery('regarde @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' })
    expect(findMentionQuery('mail@exemple.fr', 15)).toBeNull()
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, query: '' })
    expect(insertMention('regarde @src/ma et', 8, 15, 'src/main.ts')).toEqual({ text: 'regarde @src/main.ts et', caret: 20 })
    expect(insertMention('@do', 0, 3, 'docs/mon fichier.md').text).toBe('@"docs/mon fichier.md" ')
  })

  it('accepts the image formats Claude reads and refuses the others', () => {
    expect(imageFromDataUrl('data:image/png;base64,AAAA')).toEqual({ ok: true, image: { mediaType: 'image/png', data: 'AAAA' } })
    expect(imageFromDataUrl('data:image/bmp;base64,AAAA').ok).toBe(false)
    expect(imageFromDataUrl('pas une image').ok).toBe(false)
  })

  it('ranks the files for an @ mention', () => {
    const files = ['src/main/index.ts', 'src/renderer/App.tsx', 'README.md', 'tests/app.test.ts', 'src/app/deep/nested/thing.ts']
    expect(rankFiles(files, 'app', 3)).toEqual(['tests/app.test.ts', 'src/renderer/App.tsx', 'src/app/deep/nested/thing.ts'])
    expect(rankFiles(files, 'rdme')).toEqual(['README.md'])
    expect(rankFiles(files, '')[0]).toBe('README.md')
  })
})

describe('changes', () => {
  it('parses git status and numstat, renames included', () => {
    const status = parseStatusPorcelain(' M src/a.ts\n?? new file.txt\nR  old.ts -> renamed.ts\n D gone.ts\nUU conflict.ts\n')
    expect(status).toEqual([
      { path: 'src/a.ts', status: 'modified' },
      { path: 'new file.txt', status: 'untracked' },
      { path: 'renamed.ts', previousPath: 'old.ts', status: 'renamed' },
      { path: 'gone.ts', status: 'deleted' },
      { path: 'conflict.ts', status: 'conflicted' }
    ])
    const counts = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timage.png\n2\t0\tsrc/{old => new}/b.ts\n')
    expect(counts.get('src/a.ts')).toEqual({ insertions: 3, deletions: 1 })
    expect(counts.get('image.png')).toEqual({ insertions: null, deletions: null })
    expect(counts.get('src/new/b.ts')).toEqual({ insertions: 2, deletions: 0 })
  })

  it('numbers the lines of a unified diff', () => {
    const lines = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n un\n-deux\n+DEUX\n+trois\n')
    expect(lines.filter((line) => line.kind !== 'meta').map((line) => [line.kind, line.oldNumber, line.newNumber, line.text])).toEqual([
      ['hunk', null, null, '@@ -3,2 +3,3 @@'],
      ['context', 3, 3, 'un'],
      ['removed', 4, null, 'deux'],
      ['added', null, 4, 'DEUX'],
      ['added', null, 5, 'trois']
    ])
    expect(syntheticAddedDiff('n.txt', 'a\nb\n')).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b')
  })

  it('refuses files outside the conversation folder', () => {
    expect(resolveInside('C:/projet', 'src/a.ts').replace(/\\/g, '/')).toMatch(/projet\/src\/a\.ts$/)
    expect(() => resolveInside('C:/projet', '../secret.txt')).toThrow()
    expect(() => resolveInside('C:/projet', 'C:/autre/x.txt')).toThrow()
  })
})
