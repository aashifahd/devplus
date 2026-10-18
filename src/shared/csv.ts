/**
 * RFC 4180 parsing: quoted fields, doubled quotes, embedded newlines, CRLF or LF.
 * Stops after `limit` rows when given (for previews).
 */
export function parseDelimited(text: string, delimiter: string, limit = Infinity): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  const endField = () => {
    row.push(field)
    field = ''
  }
  const endRow = () => {
    endField()
    // A trailing blank line is not a row of one empty field.
    if (!(row.length === 1 && row[0] === '')) rows.push(row)
    row = []
  }

  while (i < text.length && rows.length < limit) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
      i++
    } else if (ch === delimiter) {
      endField()
      i++
    } else if (ch === '\r' || ch === '\n') {
      endRow()
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
    } else {
      field += ch
      i++
    }
  }
  if (rows.length < limit && (field !== '' || row.length > 0)) endRow()
  return rows
}

const CANDIDATES = [',', ';', '\t', '|']

/** Pick the delimiter that splits the first lines into the most consistent column count. */
export function detectDelimiter(sample: string): string {
  let best = ','
  let bestScore = 0
  for (const d of CANDIDATES) {
    const rows = parseDelimited(sample, d, 20)
    if (rows.length === 0) continue
    const counts = rows.map((r) => r.length)
    const width = counts[0]
    if (width < 2) continue
    const consistent = counts.filter((c) => c === width).length / counts.length
    const score = width * consistent
    if (score > bestScore) {
      bestScore = score
      best = d
    }
  }
  return best
}
