import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** Strict CSP injected into the packaged page only (the dev server needs inline HMR scripts). */
const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src aether-mod:; base-uri 'none'; form-action 'none'"

function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'aether-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<!-- aether:csp -->', `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`)
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          engineHost: resolve(__dirname, 'src/engine-host/index.ts')
        }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicyPlugin()]
  }
})
