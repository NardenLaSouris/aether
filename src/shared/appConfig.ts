/**
 * Central application identity. Change the name here to rebrand the whole app
 * (window title, title bar, notifications, data folder name).
 * The installer product name lives in electron-builder.yml and package.json "productName".
 */
export const APP_CONFIG = {
  name: 'Aether',
  tagline: 'Client desktop pour Claude Code',
  appId: 'com.aether.desktop',
  /** Folder name used under %APPDATA% for app-owned data (database, logs, backups). */
  dataFolderName: 'Aether',
  databaseFileName: 'aether.sqlite',
  /** Interval for refreshing the list of local Claude Code sessions. */
  sessionRefreshIntervalMs: 60_000,
  /** Minimal interval between two automatic quota checks while waiting for an unknown reset time. */
  quotaPollIntervalMs: 15 * 60_000,
  /** Engine host restart policy. */
  engineMaxRestartsPerWindow: 5,
  engineRestartWindowMs: 60_000,
  /** Timeout for RPC calls to the engine host. */
  engineRpcTimeoutMs: 60_000
} as const

export type AppConfig = typeof APP_CONFIG
