/**
 * Engine host entry point. Runs inside an Electron utilityProcess, isolated from the
 * main process and the renderer: a crash here never closes the application.
 */
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import type { HostCommand, HostMessage } from '../shared/engineProtocol'
import { HostController, type SdkSurface } from './hostController'

interface ParentPortLike {
  on(event: 'message', listener: (messageEvent: { data: unknown }) => void): void
  postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
if (!parentPort) {
  console.error('Engine host must run inside an Electron utilityProcess.')
  process.exit(1)
}

const post = (message: HostMessage): void => parentPort.postMessage(message)

const sdkSurface: SdkSurface = {
  query: (parameters) => query(parameters),
  listSessions: (options) => listSessions(options),
  getSessionMessages: (sessionId, options) => getSessionMessages(sessionId, options)
}

const controller = new HostController(sdkSurface, post)

parentPort.on('message', (messageEvent) => {
  const command = messageEvent.data as HostCommand
  controller.handle(command).catch((error: unknown) => {
    post({ type: 'event', event: { type: 'log', level: 'error', message: `Commande ${command?.type ?? '?'} échouée`, details: error instanceof Error ? (error.stack ?? error.message) : String(error) } })
    if (command && 'conversationId' in command && typeof command.conversationId === 'string') {
      post({ type: 'event', event: { type: 'runner_state', conversationId: command.conversationId, state: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  })
  if (command?.type === 'shutdown') setTimeout(() => process.exit(0), 500)
})

process.on('uncaughtException', (error) => {
  post({ type: 'event', event: { type: 'log', level: 'error', message: 'Exception non gérée dans le moteur', details: error.stack ?? error.message } })
})
process.on('unhandledRejection', (reason) => {
  post({ type: 'event', event: { type: 'log', level: 'error', message: 'Promesse rejetée non gérée dans le moteur', details: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) } })
})

post({ type: 'ready' })
