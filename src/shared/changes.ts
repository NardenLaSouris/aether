/**
 * Changes of a conversation's folder, as the "Modifications" panel shows them (pure parsing, tested).
 */

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface ChangedFile {
  /** Relative to the repository root, forward slashes. */
  path: string
  /** For a rename: the former path. */
  previousPath?: string
  status: ChangeStatus
  insertions: number | null
  deletions: number | null
}

export interface ChangesSummary {
  isRepository: boolean
  repositoryRoot: string | null
  branch: string | null
  files: ChangedFile[]
}

export interface FileContent {
  path: string
  size: number
  truncated: boolean
  binary: boolean
  content: string
}

function unquote(path: string): string {
  return path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : path
}

/** `git status --porcelain=v1` → one entry per changed path. */
export function parseStatusPorcelain(output: string): Omit<ChangedFile, 'insertions' | 'deletions'>[] {
  const files: Omit<ChangedFile, 'insertions' | 'deletions'>[] = []
  for (const line of output.split(/\r?\n/)) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    if (code === '??') {
      files.push({ path: unquote(rest), status: 'untracked' })
      continue
    }
    if (code === '!!') continue
    if (code.includes('U') || code === 'AA' || code === 'DD') {
      files.push({ path: unquote(rest), status: 'conflicted' })
      continue
    }
    if (code.includes('R')) {
      const [from, to] = rest.split(' -> ')
      files.push({ path: unquote(to ?? rest), previousPath: unquote(from ?? ''), status: 'renamed' })
      continue
    }
    const status: ChangeStatus = code.includes('D') ? 'deleted' : code.includes('A') ? 'added' : 'modified'
    files.push({ path: unquote(rest), status })
  }
  return files
}

/** `git diff --numstat` → path → counts (binary files: null). Renames keep their new path. */
export function parseNumstat(output: string): Map<string, { insertions: number | null; deletions: number | null }> {
  const counts = new Map<string, { insertions: number | null; deletions: number | null }>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!match) continue
    let path = match[3] as string
    // "src/{old => new}/file.ts" or "old => new"
    const braces = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path)
    if (braces) path = `${braces[1]}${braces[3]}${braces[4]}`.replace(/\/\//g, '/')
    else if (path.includes(' => ')) path = path.split(' => ')[1] as string
    counts.set(unquote(path), { insertions: match[1] === '-' ? null : Number(match[1]), deletions: match[2] === '-' ? null : Number(match[2]) })
  }
  return counts
}

/** A new file as a diff where every line is added. */
export function syntheticAddedDiff(path: string, content: string): string {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n')
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'hunk' | 'meta'
  text: string
  oldNumber: number | null
  newNumber: number | null
}

/** Unified diff → lines with their old/new numbers, for display. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const raw of diff.replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', text: raw, oldNumber: null, newNumber: null })
      continue
    }
    if (!inHunk) {
      if (raw) lines.push({ kind: 'meta', text: raw, oldNumber: null, newNumber: null })
      continue
    }
    if (raw.startsWith('+')) lines.push({ kind: 'added', text: raw.slice(1), oldNumber: null, newNumber: newLine++ })
    else if (raw.startsWith('-')) lines.push({ kind: 'removed', text: raw.slice(1), oldNumber: oldLine++, newNumber: null })
    else if (raw.startsWith('\\')) lines.push({ kind: 'meta', text: raw, oldNumber: null, newNumber: null })
    else if (raw.startsWith(' ') || raw === '') {
      lines.push({ kind: 'context', text: raw.slice(1), oldNumber: oldLine++, newNumber: newLine++ })
    } else {
      inHunk = false
      lines.push({ kind: 'meta', text: raw, oldNumber: null, newNumber: null })
    }
  }
  return lines
}
