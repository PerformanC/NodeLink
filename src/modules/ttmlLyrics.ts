import type { LyricsLine } from '../typings/lyrics/musixmatch.types.ts'

type Element = {
  name: string
  attrs: Record<string, string>
  children: Array<Element | string>
}

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity: string, token: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'"
      }
      if (!token.startsWith('#')) return named[token.toLowerCase()] ?? entity
      const code =
        token[1]?.toLowerCase() === 'x'
          ? Number.parseInt(token.slice(2), 16)
          : Number.parseInt(token.slice(1), 10)
      return Number.isInteger(code) &&
        code >= 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : entity
    }
  )
}

/** Supported TTML clock and offset times in milliseconds; no guessed frame rates. */
export function parseTtmlTime(value?: string): number | undefined {
  if (!value) return undefined
  const raw = value.trim()
  const offset = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i)
  if (offset) {
    const factors: Record<string, number> = {
      ms: 1,
      s: 1000,
      m: 60000,
      h: 3600000
    }
    const ms =
      Number(offset[1]) * (factors[offset[2]?.toLowerCase() ?? ''] ?? NaN)
    return Number.isSafeInteger(Math.round(ms)) ? Math.round(ms) : undefined
  }
  if (!/^\d+:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(raw)) return undefined
  const parts = raw.split(':').map(Number)
  if (parts.slice(1).some((part) => part >= 60)) return undefined
  const ms = Math.round(
    parts.reduce((total, part) => total * 60 + part, 0) * 1000
  )
  return Number.isSafeInteger(ms) ? ms : undefined
}

/** Bounded parser for the TTML subset returned by Unison. No external entities. */
function parseTree(xml: string): Element | undefined {
  if (xml.length > 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    return undefined
  const root: Element = { name: '', attrs: {}, children: [] }
  const stack = [root]
  const tokens =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:[^"'<>]|"[^"]*"|'[^']*')+>|[^<]+/g
  let cursor = 0
  let count = 0
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== cursor || ++count > 50000) return undefined
    const token = match[0]
    cursor += token.length
    const parent = stack[stack.length - 1]
    if (!parent) return undefined
    if (token.startsWith('<!--') || token.startsWith('<?')) continue
    if (token.startsWith('<![CDATA[')) {
      parent.children.push(token.slice(9, -3))
      continue
    }
    if (!token.startsWith('<')) {
      parent.children.push(decodeXml(token))
      continue
    }
    const closing = token.match(/^<\/([\w:.-]+)\s*>$/)
    if (closing) {
      if (stack.length === 1 || parent.name !== closing[1]) return undefined
      stack.pop()
      continue
    }
    const opening = token.match(/^<([\w:.-]+)([\s\S]*?)\/?>$/)
    if (!opening?.[1]) return undefined
    const attrs: Record<string, string> = Object.create(null)
    for (const attr of (opening[2] ?? '').matchAll(
      /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    )) {
      if (attr[1]) attrs[attr[1]] = decodeXml(attr[2] ?? attr[3] ?? '')
    }
    const element: Element = { name: opening[1], attrs, children: [] }
    parent.children.push(element)
    if (!token.endsWith('/>')) {
      if (stack.length >= 64) return undefined
      stack.push(element)
    }
  }
  return cursor === xml.length && stack.length === 1 ? root : undefined
}

function localName(element: Element): string {
  return element.name.split(':').at(-1) ?? ''
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

type Context = { section?: string; agent?: string; isBackground?: boolean }

function inherit(element: Element, context: Context): Context {
  const role = element.attrs['ttm:role']?.split(/\s+/) ?? []
  return {
    section: element.attrs['itunes:songPart']?.trim() || context.section,
    agent: element.attrs['ttm:agent']?.trim() || context.agent,
    isBackground: context.isBackground || role.includes('x-bg')
  }
}

export function parseTtmlLyrics(xml: string): {
  lines: LyricsLine[]
  synced: boolean
} {
  const root = parseTree(xml)
  if (!root) return { lines: [], synced: false }
  const result: Array<{ line: LyricsLine; timed: boolean }> = []

  function collectLine(
    element: Element,
    context: Context,
    inheritedStart?: number,
    inheritedEnd?: number
  ): void {
    const ownStart = parseTtmlTime(element.attrs.begin)
    const ownEnd = parseTtmlTime(element.attrs.end)
    const start = ownStart ?? inheritedStart
    const end = ownEnd ?? inheritedEnd
    const words: NonNullable<LyricsLine['words']> = []
    const alternatives: NonNullable<LyricsLine['alternatives']> = []

    function collect(node: Element): string {
      let text = ''
      for (const child of node.children) {
        if (typeof child === 'string') {
          text += child
          continue
        }
        if (localName(child) === 'br') {
          text += ' '
          continue
        }
        const next = inherit(child, context)
        const role = child.attrs['ttm:role']?.split(/\s+/) ?? []
        // Keep alternate text separate and preserve its declared language.
        const kind = role.includes('x-translation')
          ? 'translation'
          : role.includes('x-romanization')
            ? 'romanization'
            : undefined
        if (kind) {
          const plain = (node: Element): string =>
            node.children
              .map((part) =>
                typeof part === 'string'
                  ? part
                  : localName(part) === 'br'
                    ? ' '
                    : plain(part)
              )
              .join('')
          const text = normalizeText(plain(child))
          const language = child.attrs['xml:lang']?.trim()
          if (text)
            alternatives.push({ kind, text, ...(language ? { language } : {}) })
          continue
        }
        if (
          (!context.isBackground && next.isBackground) ||
          (next.agent && next.agent !== context.agent)
        ) {
          collectLine(child, next, start, end)
          continue
        }
        const before = words.length
        const childText = collect(child)
        const childStart = parseTtmlTime(child.attrs.begin)
        const childEnd = parseTtmlTime(child.attrs.end)
        const token = normalizeText(childText)
        // Nested timed leaves take precedence; do not duplicate their parent span.
        if (words.length === before && token && childStart !== undefined) {
          words.push({
            text: token,
            time: childStart,
            duration:
              childEnd !== undefined && childEnd >= childStart
                ? childEnd - childStart
                : 0
          })
        }
        text += childText
      }
      return text
    }

    const text = normalizeText(collect(element))
    if (!text) return
    const tokenStarts = words.flatMap((word) =>
      typeof word.time === 'number' ? [word.time] : []
    )
    const lineStart =
      start ?? (tokenStarts.length ? Math.min(...tokenStarts) : undefined)
    result.push({
      timed: lineStart !== undefined,
      line: {
        text,
        time: lineStart ?? 0,
        duration:
          end !== undefined && lineStart !== undefined && end >= lineStart
            ? end - lineStart
            : 0,
        ...(words.length ? { words } : {}),
        ...(alternatives.length ? { alternatives } : {}),
        ...(context.section ? { section: context.section } : {}),
        ...(context.agent ? { agent: context.agent } : {}),
        ...(context.isBackground ? { isBackground: true } : {})
      }
    })
  }

  function visit(element: Element, context: Context): void {
    const next = inherit(element, context)
    if (localName(element) === 'p') {
      collectLine(element, next)
      return
    }
    for (const child of element.children)
      if (typeof child !== 'string') visit(child, next)
  }

  visit(root, {})
  // Put primary lines before simultaneous background voices.
  result.sort(
    (a, b) =>
      a.line.time - b.line.time ||
      Number(!!a.line.isBackground) - Number(!!b.line.isBackground)
  )
  return {
    lines: result.map(({ line }) => line),
    synced: result.length > 0 && result.every(({ timed }) => timed)
  }
}
