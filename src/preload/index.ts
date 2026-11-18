/**
 * Minimal preload: exposes a single `window.aether` object with a whitelisted
 * invoke/on bridge. No Node.js API reaches the renderer.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { INVOKE_CHANNEL_NAMES, PUSH_CHANNEL_NAMES } from '../shared/ipcChannels'

const invokeChannels = new Set<string>(INVOKE_CHANNEL_NAMES)
const pushChannels = new Set<string>(PUSH_CHANNEL_NAMES)

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error(`Canal IPC non autorisé : ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!pushChannels.has(channel)) throw new Error(`Canal d’événement non autorisé : ${channel}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('aether', api)
