import type { UiSettings } from '@shared/settings'

export const THEME_EVENT = 'dbc-theme'

/** True when the app is showing the dark palette, whether forced or from the OS. */
export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme
  return forced ? forced === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
}

function mixHex(a: string, b: string, weight: number): string {
  const parse = (h: string) => {
    const x = h.replace('#', '')
    const full = x.length === 3 ? x.split('').map((c) => c + c).join('') : x
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16))
  }
  const [ar, ag, ab] = parse(a)
  const [br, bg, bb] = parse(b)
  const m = (x: number, y: number) => Math.round(x * weight + y * (1 - weight)).toString(16).padStart(2, '0')
  return `#${m(ar, br)}${m(ag, bg)}${m(ab, bb)}`
}

/**
 * Apply appearance settings to the document. The soft accent is computed here rather than
 * with color-mix() because the grid paints on a canvas, which needs a plain color.
 */
export function applyTheme(ui: UiSettings) {
  const root = document.documentElement
  if (ui.theme === 'system') delete root.dataset.theme
  else root.dataset.theme = ui.theme
  const accent = /^#[0-9a-f]{3,6}$/i.test(ui.accent) ? ui.accent : '#2f6fed'
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-soft', mixHex(accent, isDark() ? '#17181b' : '#ffffff', isDark() ? 0.28 : 0.14))
  window.dispatchEvent(new Event(THEME_EVENT))
}

/** Re-apply when the OS switches light/dark while the app follows the system. */
export function watchSystemTheme(get: () => UiSettings | undefined) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    const ui = get()
    if (ui) applyTheme(ui)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

export const ACCENTS = ['#2f6fed', '#7c5cff', '#db2777', '#d93a3a', '#e08a12', '#1f9d55', '#0ea5a4', '#64748b']
