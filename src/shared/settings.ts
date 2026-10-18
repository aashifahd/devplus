import type { ToolName } from './types'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface UiSettings {
  theme: ThemeMode
  /** Accent color as #rrggbb. */
  accent: string
  editorFontSize: number
  gridFontSize: number
  density: 'compact' | 'regular' | 'comfortable'
}

export type AiProvider = 'anthropic' | 'openai' | 'compatible'

export interface AiSettings {
  provider: AiProvider
  model: string
  /** OpenAI-compatible servers (Ollama, LM Studio, vLLM…); ignored for the hosted providers. */
  baseUrl: string
  /** Send a few sample rows along with the schema. Off by default: only names and types leave the machine. */
  includeSampleRows: boolean
}

/** Every rebindable action. Scope says where the shortcut is live. */
export type ActionId =
  | 'app.commandPalette'
  | 'app.settings'
  | 'tab.newQuery'
  | 'tab.close'
  | 'query.run'
  | 'query.runAll'
  | 'query.explain'
  | 'query.save'
  | 'query.format'
  | 'query.ai'
  | 'table.reload'
  | 'table.filter'
  | 'table.commit'
  | 'table.addRow'

export interface ActionInfo {
  id: ActionId
  label: string
  /** "Mod" is Ctrl on Windows and Linux, Cmd on macOS. */
  defaultKey: string
  scope: 'global' | 'editor' | 'table'
}

export const ACTIONS: ActionInfo[] = [
  { id: 'app.commandPalette', label: 'Command palette', defaultKey: 'Mod+Shift+P', scope: 'global' },
  { id: 'app.settings', label: 'Settings', defaultKey: 'Mod+,', scope: 'global' },
  { id: 'tab.newQuery', label: 'New SQL query', defaultKey: 'Mod+T', scope: 'global' },
  { id: 'tab.close', label: 'Close tab', defaultKey: 'Mod+W', scope: 'global' },
  { id: 'query.run', label: 'Run statement', defaultKey: 'Mod+Enter', scope: 'editor' },
  { id: 'query.runAll', label: 'Run all', defaultKey: 'Mod+Shift+Enter', scope: 'editor' },
  { id: 'query.explain', label: 'Explain statement', defaultKey: 'Mod+E', scope: 'editor' },
  { id: 'query.save', label: 'Save query', defaultKey: 'Mod+S', scope: 'editor' },
  { id: 'query.format', label: 'Format SQL', defaultKey: 'Shift+Alt+F', scope: 'editor' },
  { id: 'query.ai', label: 'Ask AI', defaultKey: 'Mod+L', scope: 'editor' },
  { id: 'table.reload', label: 'Reload table', defaultKey: 'Mod+R', scope: 'table' },
  { id: 'table.filter', label: 'Filter rows', defaultKey: 'Mod+F', scope: 'table' },
  { id: 'table.commit', label: 'Commit changes', defaultKey: 'Mod+S', scope: 'table' },
  { id: 'table.addRow', label: 'Add row', defaultKey: 'Mod+I', scope: 'table' }
]

export interface AppSettings {
  toolPaths: Partial<Record<ToolName, string>>
  ui: UiSettings
  /** Only the actions the user rebound; everything else uses ActionInfo.defaultKey. */
  keymap: Partial<Record<ActionId, string>>
  ai: AiSettings
  plugins: { disabled: string[] }
  /** Installed builds: check GitHub Releases in the background and download new versions. */
  updates: { auto: boolean }
}

export const DEFAULT_UI: UiSettings = { theme: 'system', accent: '#2f6fed', editorFontSize: 13, gridFontSize: 12, density: 'regular' }

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  compatible: 'llama3.1'
}

export const DEFAULT_AI: AiSettings = { provider: 'anthropic', model: DEFAULT_MODELS.anthropic, baseUrl: 'http://localhost:11434/v1', includeSampleRows: false }

export const DEFAULT_SETTINGS: AppSettings = { toolPaths: {}, ui: DEFAULT_UI, keymap: {}, ai: DEFAULT_AI, plugins: { disabled: [] }, updates: { auto: true } }

/** Fill in anything missing from a saved (possibly older) settings file. */
export function withDefaults(s: Partial<AppSettings> | undefined): AppSettings {
  return {
    toolPaths: { ...(s?.toolPaths ?? {}) },
    ui: { ...DEFAULT_UI, ...(s?.ui ?? {}) },
    keymap: { ...(s?.keymap ?? {}) },
    ai: { ...DEFAULT_AI, ...(s?.ai ?? {}) },
    plugins: { disabled: [...(s?.plugins?.disabled ?? [])] },
    updates: { auto: s?.updates?.auto ?? true }
  }
}

export const keyFor = (settings: AppSettings | null, id: ActionId) =>
  settings?.keymap[id] ?? ACTIONS.find((a) => a.id === id)!.defaultKey

/** Deep-ish merge for settings updates: each section merges, arrays and scalars replace. */
export function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  return withDefaults({
    toolPaths: { ...base.toolPaths, ...(patch.toolPaths ?? {}) } as AppSettings['toolPaths'],
    ui: { ...base.ui, ...(patch.ui ?? {}) } as UiSettings,
    keymap: (patch.keymap ? { ...base.keymap, ...patch.keymap } : base.keymap) as AppSettings['keymap'],
    ai: { ...base.ai, ...(patch.ai ?? {}) } as AiSettings,
    plugins: { disabled: (patch.plugins?.disabled as string[] | undefined) ?? base.plugins.disabled },
    updates: { auto: patch.updates?.auto ?? base.updates.auto }
  })
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] }
