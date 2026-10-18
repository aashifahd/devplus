import type { editor } from 'monaco-editor'

/** Open query editors by tab id, so commands outside a QueryView can reach the active one. */
const editors = new Map<string, editor.IStandaloneCodeEditor>()

export function registerEditor(tabId: string, ed: editor.IStandaloneCodeEditor) {
  editors.set(tabId, ed)
  return () => {
    if (editors.get(tabId) === ed) editors.delete(tabId)
  }
}

export const editorFor = (tabId: string | null) => (tabId ? editors.get(tabId) : undefined)

/** Insert at the cursor (replacing any selection), as one undoable edit. */
export function insertIntoEditor(ed: editor.IStandaloneCodeEditor, text: string) {
  const sel = ed.getSelection()
  if (!sel) return
  ed.pushUndoStop()
  ed.executeEdits('insert', [{ range: sel, text, forceMoveMarkers: true }])
  ed.pushUndoStop()
  ed.focus()
}

export function selectedText(ed: editor.IStandaloneCodeEditor | undefined): string {
  const model = ed?.getModel()
  const sel = ed?.getSelection()
  return model && sel && !sel.isEmpty() ? model.getValueInRange(sel) : ''
}
