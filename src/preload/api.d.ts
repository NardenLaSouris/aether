import type { AetherApi } from '../shared/ipcContract'

declare global {
  interface Window {
    aether: AetherApi
  }
}

export {}
