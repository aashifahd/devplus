import { useEffect, useRef, type ReactNode } from 'react'

export default function Modal({
  title,
  width = 520,
  onClose,
  children,
  footer
}: {
  title: string
  width?: number
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // Take focus from whatever is behind (e.g. the SQL editor, which swallows Escape),
  // unless a field inside already grabbed it with autoFocus.
  useEffect(() => {
    if (boxRef.current && !boxRef.current.contains(document.activeElement)) boxRef.current.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40" onMouseDown={onClose}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className="flex max-h-[90vh] flex-col rounded-xl border border-line bg-bg shadow-2xl outline-none"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="border-b border-line px-5 py-3 text-sm font-semibold">{title}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex items-center gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}
