/** A small parser for XML property lists (the format TablePlus stores connections in). */
export type PlistValue = string | number | boolean | Date | PlistValue[] | { [key: string]: PlistValue }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

export function parsePlist(xml: string): PlistValue {
  // Tags and the text between them; comments, the XML declaration and DOCTYPE are dropped.
  const tokens = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .match(/<[^>]+>|[^<]+/g)
  if (!tokens) throw new Error('Not a property list.')
  let i = 0

  const text = (tag: string): string => {
    let out = ''
    while (i < tokens.length && tokens[i] !== `</${tag}>`) out += tokens[i++]
    if (tokens[i] !== `</${tag}>`) throw new Error(`Unclosed <${tag}>.`)
    i++
    return decode(out)
  }

  const value = (): PlistValue => {
    while (i < tokens.length && !tokens[i].startsWith('<')) i++ // whitespace
    const tag = tokens[i++]
    if (tag === undefined) throw new Error('Unexpected end of property list.')
    const name = /^<\s*([a-z]+)/i.exec(tag)?.[1]?.toLowerCase()
    const selfClosing = tag.endsWith('/>')
    switch (name) {
      case 'plist':
        return value()
      case 'dict': {
        const out: Record<string, PlistValue> = {}
        if (selfClosing) return out
        for (;;) {
          while (i < tokens.length && !tokens[i].startsWith('<')) i++
          if (tokens[i] === '</dict>') {
            i++
            return out
          }
          if (tokens[i] !== '<key>') throw new Error(`Expected <key>, found ${tokens[i] ?? 'end of file'}.`)
          i++
          const key = text('key')
          out[key] = value()
        }
      }
      case 'array': {
        const out: PlistValue[] = []
        if (selfClosing) return out
        for (;;) {
          while (i < tokens.length && !tokens[i].startsWith('<')) i++
          if (tokens[i] === '</array>') {
            i++
            return out
          }
          out.push(value())
        }
      }
      case 'string':
        return selfClosing ? '' : text('string')
      case 'integer':
      case 'real':
        return selfClosing ? 0 : Number(text(name))
      case 'true':
        return true
      case 'false':
        return false
      case 'date':
        return new Date(text('date'))
      case 'data':
        return selfClosing ? '' : text('data').replace(/\s+/g, '')
      default:
        throw new Error(`Unexpected ${tag} in property list.`)
    }
  }

  return value()
}
