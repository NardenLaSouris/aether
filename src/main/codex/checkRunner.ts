/**
 * Runs the checks the user listed for a pilot (their own command lines, e.g. `pnpm test`)
 * in the conversation's folder, without a window, and keeps the end of the output.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { CheckResult } from '../../shared/pilot'
import { killTree } from './codexCli'

export const CHECK_TIMEOUT_MS = 20 * 60_000
const OUTPUT_TAIL = 6000

export interface RunningChecks {
  done: Promise<CheckResult[]>
  cancel: () => void
}

export type CheckSpawner = (command: string, workingDirectory: string) => ChildProcess

const defaultSpawner: CheckSpawner = (command, workingDirectory) =>
  spawn(command, { cwd: workingDirectory, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } })

export function runChecks(commands: string[], workingDirectory: string, spawner: CheckSpawner = defaultSpawner, timeoutMs = CHECK_TIMEOUT_MS): RunningChecks {
  let cancelled = false
  let current: ChildProcess | null = null
  const runOne = (command: string): Promise<CheckResult> =>
    new Promise((resolve) => {
      const startedAt = Date.now()
      let output = ''
      let timedOut = false
      let child: ChildProcess
      try {
        child = spawner(command, workingDirectory)
      } catch (error) {
        resolve({ command, exitCode: null, passed: false, durationMs: 0, outputTail: error instanceof Error ? error.message : String(error), timedOut: false })
        return
      }
      current = child
      const append = (chunk: Buffer | string): void => {
        output = (output + chunk.toString()).slice(-OUTPUT_TAIL * 2)
      }
      child.stdout?.on('data', append)
      child.stderr?.on('data', append)
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
      const finish = (exitCode: number | null, error?: Error): void => {
        clearTimeout(timer)
        current = null
        // eslint-disable-next-line no-control-regex
        const clean = (error ? `${output}\n${error.message}` : output).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(-OUTPUT_TAIL)
        resolve({ command, exitCode, passed: !timedOut && !error && exitCode === 0, durationMs: Date.now() - startedAt, outputTail: clean.trim(), timedOut })
      }
      child.once('error', (error) => finish(null, error))
      child.once('close', (exitCode) => finish(exitCode))
    })
  const done = (async () => {
    const results: CheckResult[] = []
    for (const command of commands) {
      if (cancelled) break
      results.push(await runOne(command))
    }
    return results
  })()
  return {
    done,
    cancel: () => {
      cancelled = true
      if (current) killTree(current)
    }
  }
}
