import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** A small floating menu that closes on outside click, Escape, scroll or resize. */
export default function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: (MenuItem | 'separator')[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Keep the menu on screen near the window edges.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ x: Math.min(x, window.innerWidth - width - 8), y: Math.min(y, window.innerHeight - height - 8) })
  }, [x, y])

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-48 rounded-lg border border-line bg-bg py-1 text-xs shadow-xl"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={item.label}
            disabled={item.disabled}
            className={`flex w-full items-center gap-6 px-3 py-1.5 text-left hover:bg-accent hover:text-white disabled:opacity-40 disabled:hover:bg-transparent ${
              item.danger ? 'text-danger' : ''
            } ${item.disabled ? 'disabled:hover:text-inherit' : ''}`}
            onClick={() => {
              item.onSelect()
              onClose()
            }}
          >
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <span className="text-faint">{item.shortcut}</span>}
          </button>
        )
      )}
    </div>
  )
}
