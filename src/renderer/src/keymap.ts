import { useEffect, useRef } from 'react'
import { keyFor, type ActionId } from '@shared/settings'
import { useApp } from './store'

const IS_MAC = navigator.platform.toLowerCase().includes('mac')

export interface Combo {
  mod: boolean
  shift: boolean
  alt: boolean
  /** Lower-case key name: "enter", "p", ",", "f5"… */
  key: string
}

export function parseCombo(text: string): Combo | null {
  if (!text) return null
  const parts = text.split('+').map((p) => p.trim().toLowerCase())
  const key = parts.pop() ?? ''
  if (!key) return null
  return { mod: parts.includes('mod') || parts.includes('ctrl') || parts.includes('cmd'), shift: parts.includes('shift'), alt: parts.includes('alt'), key }
}

/** Canonical text for a combo, e.g. "Mod+Shift+P". */
export function comboText(c: Combo): string {
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)
  return [c.mod && 'Mod', c.shift && 'Shift', c.alt && 'Alt', key].filter(Boolean).join('+')
}

/** How a combo reads on this platform: "Ctrl+Shift+P" or "⌘⇧P". */
export function displayCombo(text: string): string {
  const c = parseCombo(text)
  if (!c) return ''
  const key = c.key.length === 1 ? c.key.toUpperCase() : c.key[0].toUpperCase() + c.key.slice(1)
  if (IS_MAC) return `${c.mod ? '⌘' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${key}`
  return [c.mod && 'Ctrl', c.shift && 'Shift', c.alt && 'Alt', key].filter(Boolean).join('+')
}

const eventKey = (e: KeyboardEvent) => (e.key === ' ' ? 'space' : e.key.toLowerCase())

export function matches(e: KeyboardEvent, c: Combo): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  return mod === c.mod && e.shiftKey === c.shift && e.altKey === c.alt && eventKey(e) === c.key
}

/** The combo a key press describes, for capturing a new binding (null for lone modifiers). */
export function comboFromEvent(e: KeyboardEvent): Combo | null {
  const key = eventKey(e)
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return null
  return { mod: IS_MAC ? e.metaKey : e.ctrlKey, shift: e.shiftKey, alt: e.altKey, key }
}

/** The combo currently bound to an action. */
export function useActionKey(id: ActionId): string {
  return useApp((s) => keyFor(s.settings, id))
}

/**
 * Run `handler` when the action's shortcut is pressed. Only one handler is live per action
 * at a time in practice because inactive tabs pass enabled = false.
 */
export function useShortcut(id: ActionId, handler: (e: KeyboardEvent) => void, enabled = true) {
  const combo = parseCombo(useActionKey(id))
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!enabled || !combo) return
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, combo)) {
        e.preventDefault()
        ref.current(e)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, combo?.key, combo?.mod, combo?.shift, combo?.alt]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** Monaco keybinding number for a combo, given Monaco's KeyMod/KeyCode enums. */
export function toMonacoKey(
  text: string,
  KeyMod: { CtrlCmd: number; Shift: number; Alt: number },
  KeyCode: Record<string, number>
): number | null {
  const c = parseCombo(text)
  if (!c) return null
  const special: Record<string, string> = {
    enter: 'Enter',
    escape: 'Escape',
    space: 'Space',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '-': 'Minus',
    '=': 'Equal',
    arrowup: 'UpArrow',
    arrowdown: 'DownArrow',
    arrowleft: 'LeftArrow',
    arrowright: 'RightArrow'
  }
  let name = special[c.key]
  if (!name && /^[a-z]$/.test(c.key)) name = `Key${c.key.toUpperCase()}`
  if (!name && /^[0-9]$/.test(c.key)) name = `Digit${c.key}`
  if (!name && /^f\d{1,2}$/.test(c.key)) name = c.key.toUpperCase()
  const code = name ? KeyCode[name] : undefined
  if (code === undefined) return null
  return (c.mod ? KeyMod.CtrlCmd : 0) | (c.shift ? KeyMod.Shift : 0) | (c.alt ? KeyMod.Alt : 0) | code
}
