/**
 * IPC hardening: sender origin check + zod validation of every payload.
 */
import { ipcSchemas, type IpcChannel, type IpcInput, type IpcOutputs } from '../../shared/ipcContract'

export class IpcValidationError extends Error {}

/**
 * Only our own renderer may call IPC: the packaged file:// page, or the Vite dev server origin in development.
 */
export function isTrustedSenderUrl(senderUrl: string | undefined, rendererFileUrlPrefix: string, devServerUrl: string | null): boolean {
  if (!senderUrl) return false
  if (devServerUrl) {
    try {
      const sender = new URL(senderUrl)
      const dev = new URL(devServerUrl)
      if (sender.origin === dev.origin) return true
    } catch {
      return false
    }
  }
  return senderUrl.startsWith(rendererFileUrlPrefix)
}

export function isKnownChannel(channel: string): channel is IpcChannel {
  return Object.prototype.hasOwnProperty.call(ipcSchemas, channel)
}

export function parseIpcPayload<Channel extends IpcChannel>(channel: Channel, payload: unknown): IpcInput<Channel> {
  const schema = ipcSchemas[channel]
  const result = schema.safeParse(payload)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`).join(' ; ')
    throw new IpcValidationError(`Données IPC invalides pour ${channel} — ${issues}`)
  }
  return result.data as IpcInput<Channel>
}

export type IpcHandlers = {
  [Channel in IpcChannel]: (input: IpcInput<Channel>) => Promise<IpcOutputs[Channel]> | IpcOutputs[Channel]
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: { senderFrame: { url: string } | null }, payload: unknown) => Promise<unknown>): void
}

export function registerIpcHandlers(ipcMain: IpcMainLike, handlers: IpcHandlers, isTrusted: (senderUrl: string | undefined) => boolean, onError: (channel: string, error: unknown) => void): void {
  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrusted(event.senderFrame?.url)) throw new Error('Expéditeur IPC non autorisé.')
      const input = parseIpcPayload(channel, payload)
      try {
        const handler = handlers[channel] as (value: unknown) => unknown
        return await handler(input)
      } catch (error) {
        onError(channel, error)
        throw error instanceof Error ? new Error(error.message) : new Error(String(error))
      }
    })
  }
}
