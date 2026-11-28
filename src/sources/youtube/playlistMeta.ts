/**
 * Playlist metadata (author + thumbnail + description) extracted from a YouTube playlist page.
 * @public
 */
export interface YouTubePlaylistMeta {
  /** Playlist owner display name, or an empty string when unavailable. */
  author: string
  /** Playlist owner channel URL, or an empty string when unavailable. */
  authorUrl?: string
  /** Playlist thumbnail URL, or an empty string when unavailable. */
  thumbnail: string
  /** Total number of tracks in the playlist, when known from page metadata. */
  totalTracks?: number
}

const GENERIC_YOUTUBE_DESCRIPTIONS = [
  'share your videos with friends, family, and the world',
  'share your videos with friends, family and the world',
  'enjoy the videos and music you love, upload original content, and share it all with friends, family, and the world on youtube'
]

/**
 * Checks whether a playlist description matches generic YouTube placeholder text.
 * @public
 */
export function isGenericDescription(desc: string | null | undefined): boolean {
  if (!desc || typeof desc !== 'string') return true
  const normalized = desc.trim().toLowerCase().replace(/[.\s]+$/, '')
  return GENERIC_YOUTUBE_DESCRIPTIONS.some((generic) =>
    normalized === generic || normalized.includes('share your videos with friends, family, and the world')
  )
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&lt;': '<',
  '&gt;': '>'
}

/** Decodes the handful of entities YouTube emits inside meta attributes. */
function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|quot|#39|#x27|lt|gt);/g,
    (entity) => HTML_ENTITIES[entity] ?? entity
  )
}

/**
 * Reads `og:image` from the page and returns a clean URL.
 * `days_since_epoch` is a cache-buster that changes daily, so it is dropped to
 * keep the URL stable between requests.
 */
function extractThumbnail(html: string): string {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []

  for (const tag of metaTags) {
    if (!/\bproperty=["']og:image["']/i.test(tag)) continue

    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1]
    if (!content) continue

    return decodeHtmlEntities(content)
      .replace(/([?&])days_since_epoch=[^&#]*&?/, '$1')
      .replace(/[?&]$/, '')
  }

  return ''
}

/**
 * Reads `og:description` or meta description from the HTML.
 */
function extractDescriptionFromHtml(html: string): string {
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? []

  for (const tag of metaTags) {
    if (!/\b(?:property=["']og:description["']|name=["']description["'])/i.test(tag)) continue

    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1]
    if (!content) continue

    const decoded = decodeHtmlEntities(content).trim()
    if (!isGenericDescription(decoded)) {
      return decoded
    }
  }

  return ''
}

/**
 * Depth-first search for the first object stored under `key`.
 * Iterative so a deeply nested `ytInitialData` cannot overflow the stack.
 */
function findKey(root: unknown, key: string): unknown {
  const stack: unknown[] = [root]

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue

    const record = node as Record<string, unknown>
    if (key in record && record[key] && typeof record[key] === 'object') {
      return record[key]
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === 'object') stack.push(value)
    }
  }

  return undefined
}

/** Joins the text of a YouTube `{ runs: [...] }` / `{ simpleText }` object. */
function textOf(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  const text = value as {
    simpleText?: unknown
    runs?: Array<{ text?: unknown }>
  }

  if (typeof text.simpleText === 'string') return text.simpleText
  if (Array.isArray(text.runs)) {
    return text.runs
      .map((run) => (typeof run?.text === 'string' ? run.text : ''))
      .join('')
  }
  return ''
}

/**
 * Extracts author, authorUrl, description, and thumbnail from playlist page HTML and ytInitialData.
 */
export function parsePlaylistMeta(html: string): YouTubePlaylistMeta {
  const thumbnail = extractThumbnail(html)
  let author = ''
  let authorUrl = ''
  let totalTracks: number | undefined

  const match = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/)
  if (match?.[1]) {
    try {
      const data = JSON.parse(match[1])

      const sidebar = findKey(data, 'playlistSidebarSecondaryInfoRenderer') as
        | {
            videoOwner?: {
              videoOwnerRenderer?: {
                title?: unknown
                navigationEndpoint?: {
                  commandMetadata?: {
                    webCommandMetadata?: { url?: string }
                  }
                }
              }
            }
          }
        | undefined

      const fromSidebar = textOf(sidebar?.videoOwner?.videoOwnerRenderer?.title)
      if (fromSidebar) {
        author = fromSidebar.trim()
        const navUrl =
          sidebar?.videoOwner?.videoOwnerRenderer?.navigationEndpoint
            ?.commandMetadata?.webCommandMetadata?.url
        if (typeof navUrl === 'string' && navUrl) {
          authorUrl = navUrl.startsWith('/') ? `https://www.youtube.com${navUrl}` : navUrl
        }
      }

      if (!author) {
        const header = findKey(data, 'playlistHeaderRenderer') as
          | {
              ownerText?: {
                runs?: Array<{
                  text?: unknown
                  navigationEndpoint?: {
                    commandMetadata?: { webCommandMetadata?: { url?: string } }
                  }
                }>
              }
              subtitle?: unknown
              ownerEndpoint?: {
                commandMetadata?: { webCommandMetadata?: { url?: string } }
              }
            }
          | undefined

        author = textOf(header?.ownerText).trim()
        const navUrl =
          header?.ownerEndpoint?.commandMetadata?.webCommandMetadata?.url ??
          header?.ownerText?.runs?.[0]?.navigationEndpoint?.commandMetadata
            ?.webCommandMetadata?.url
        if (typeof navUrl === 'string' && navUrl) {
          authorUrl = navUrl.startsWith('/') ? `https://www.youtube.com${navUrl}` : navUrl
        }

        // For YouTube Music albums, ownerText may be missing, but subtitle contains e.g. "Artist • Album"
        if (!author && header?.subtitle) {
          const subText = textOf(header.subtitle).trim()
          if (subText) {
            const parts = subText.split('•').map((s) => s.trim())
            if (parts.length > 0 && parts[0]) {
              author = parts[0]
            }
          }
        }
      }

      const primarySidebar = findKey(data, 'playlistSidebarPrimaryInfoRenderer') as
        | {
            description?: unknown
            stats?: unknown[]
          }
        | undefined



      const statsArray = Array.isArray(primarySidebar?.stats) ? primarySidebar.stats : []
      for (const stat of statsArray) {
        const str = textOf(stat)
        const statMatch = str.match(/([\d,]+)\s*(?:video|track|song)s?/i)
        if (statMatch?.[1]) {
          const num = parseInt(statMatch[1].replace(/,/g, ''), 10)
          if (!Number.isNaN(num) && num >= 0) {
            totalTracks = num
            break
          }
        }
      }

      if (totalTracks == null) {
        const header = (findKey(data, 'playlistHeaderRenderer') ??
          findKey(data, 'musicResponsiveHeaderRenderer') ??
          findKey(data, 'musicDetailHeaderRenderer')) as Record<string, unknown> | undefined

        const numVideos =
          textOf(header?.numVideosText) ||
          textOf((header?.briefStats as unknown[])?.[0]) ||
          textOf((header?.stats as unknown[])?.[0]) ||
          textOf(header?.secondSubtitle) ||
          textOf(header?.subtitle)

        const statMatch = numVideos.match(/([\d,]+)\s*(?:video|track|song)s?/i)
        if (statMatch?.[1]) {
          const num = parseInt(statMatch[1].replace(/,/g, ''), 10)
          if (!Number.isNaN(num) && num >= 0) {
            totalTracks = num
          }
        }
      }
    } catch {}
  }

  return {
    author,
    authorUrl: authorUrl || undefined,
    thumbnail,
    totalTracks
  }
}
