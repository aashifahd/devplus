import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Monaco's main entry registers the CSS/HTML/JSON/TypeScript language services,
 * which drag in ~16 MB of workers. A SQL editor needs none of them.
 */
function monacoSqlOnly(): Plugin {
  const EMPTY = '\0monaco-empty-language'
  return {
    name: 'monaco-sql-only',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('monaco-editor') && /languages\/features\/(css|html|json|typescript)\/register\.js$/.test(source)) {
        return EMPTY
      }
      return null
    },
    load(id) {
      return id === EMPTY ? 'export {}' : null
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') } },
    plugins: [monacoSqlOnly(), react(), tailwindcss()]
  }
})
