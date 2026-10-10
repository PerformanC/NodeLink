import net from 'node:net'

type HeaderBag = Record<string, string | string[] | undefined>

interface AddressRange {
  family: 4 | 6
  base: bigint
  mask: bigint
}

/**
 * Matches peer addresses against an explicit list of trusted proxy IPs/CIDRs.
 * Invalid entries are reported through `invalidEntries` and never match.
 * @public
 */
export class TrustedProxyList {
  private readonly ranges: AddressRange[]
  readonly invalidEntries: string[]

  constructor(entries: readonly string[] = []) {
    this.ranges = []
    this.invalidEntries = []

    for (const entry of entries) {
      const range = parseRange(entry)
      if (range) {
        this.ranges.push(range)
      } else {
        this.invalidEntries.push(entry)
      }
    }
  }

  get size(): number {
    return this.ranges.length
  }

  /**
   * Checks whether an address belongs to a trusted proxy.
   * @param rawAddress - Peer address (IPv4, IPv6 or IPv4-mapped IPv6).
   */
  contains(rawAddress?: string | null): boolean {
    if (this.ranges.length === 0) return false

    const address = normalizeAddress(rawAddress)
    if (!address) return false

    const parsed = parseAddress(address)
    if (!parsed) return false

    return this.ranges.some(
      (range) =>
        range.family === parsed.family &&
        (parsed.value & range.mask) === range.base
    )
  }
}

/**
 * Strips IPv4-mapped prefixes, brackets and ports from an address.
 * Returns null when the result is not a valid IP literal.
 * @public
 */
export function normalizeAddress(rawAddress?: string | null): string | null {
  if (!rawAddress) return null
  let address = rawAddress.trim()
  if (!address) return null

  const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed?.[1]) {
    address = bracketed[1]
  } else if (/^[\d.]+:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'))
  }

  const zoneIndex = address.indexOf('%')
  if (zoneIndex !== -1) {
    address = address.slice(0, zoneIndex)
  }

  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped?.[1]) {
    address = mapped[1]
  }

  return net.isIP(address) === 0 ? null : address.toLowerCase()
}

/**
 * Resolves the originating client address of a request.
 *
 * Forwarding headers are honored only when the TCP peer is a trusted proxy.
 * X-Forwarded-For is walked from the nearest hop (right) to the farthest
 * (left), skipping trusted proxies; the first untrusted hop is the client.
 * X-Real-IP is used only when the trusted peer sent no X-Forwarded-For.
 *
 * @param peerAddress - TCP socket remote address.
 * @param headers - Request headers.
 * @param trustedProxies - Trusted proxy list.
 * @returns The client address, or null if the peer address is unusable.
 * @public
 */
export function resolveClientAddress(
  peerAddress: string | null | undefined,
  headers: HeaderBag | undefined,
  trustedProxies: TrustedProxyList
): string | null {
  const peer = normalizeAddress(peerAddress)
  if (!peer) return null
  if (!headers || !trustedProxies.contains(peer)) return peer

  const forwardedFor = readHeader(headers, 'x-forwarded-for')
  const hops = forwardedFor
    ? forwardedFor.split(',')
    : [readHeader(headers, 'x-real-ip') ?? '']

  let client = peer
  for (let index = hops.length - 1; index >= 0; index--) {
    const hop = normalizeAddress(hops[index])
    if (!hop) break

    client = hop
    if (!trustedProxies.contains(hop)) break
  }

  return client
}

const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip'
]

/**
 * Checks whether a request originates from this host. A loopback peer that
 * carries forwarding headers is a local reverse proxy relaying an outside
 * client, so it is not considered local.
 * @param peerAddress - TCP socket remote address.
 * @param headers - Request headers.
 * @public
 */
export function isLoopbackRequest(
  peerAddress: string | null | undefined,
  headers: HeaderBag | undefined
): boolean {
  const peer = normalizeAddress(peerAddress)
  const isLoopbackPeer = peer === '::1' || Boolean(peer?.startsWith('127.'))
  if (!isLoopbackPeer) return false

  return !FORWARDING_HEADERS.some(
    (name) => headers && readHeader(headers, name) !== undefined
  )
}

function readHeader(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw.join(',') : raw
  return value?.trim() || undefined
}

function parseRange(entry: string): AddressRange | null {
  const [rawAddress, rawPrefix, ...rest] = entry.trim().split('/')
  if (rest.length > 0) return null

  const address = normalizeAddress(rawAddress)
  if (!address) return null

  const parsed = parseAddress(address)
  if (!parsed) return null

  const bits = parsed.family === 4 ? 32 : 128
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix)
  const isValidPrefix =
    rawPrefix === undefined ||
    (/^\d+$/.test(rawPrefix) && prefix >= 0 && prefix <= bits)
  if (!isValidPrefix) return null

  const hostBits = BigInt(bits - prefix)
  const full = (1n << BigInt(bits)) - 1n
  const mask = (full >> hostBits) << hostBits

  return { family: parsed.family, base: parsed.value & mask, mask }
}

function parseAddress(
  address: string
): { family: 4 | 6; value: bigint } | null {
  const family = net.isIP(address)

  if (family === 4) {
    const value = address
      .split('.')
      .reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n)
    return { family: 4, value }
  }

  if (family === 6) {
    const groups = expandIpv6(address)
    if (!groups) return null
    const value = groups.reduce(
      (acc, group) => (acc << 16n) | BigInt(group),
      0n
    )
    return { family: 6, value }
  }

  return null
}

function expandIpv6(address: string): number[] | null {
  let source = address
  const embeddedIpv4 = source.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (embeddedIpv4?.[1]) {
    const octets = embeddedIpv4[1].split('.').map(Number)
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0)
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    source = `${source.slice(0, -embeddedIpv4[1].length)}${high.toString(16)}:${low.toString(16)}`
  }

  const [head = '', tail] = source.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length
  if (tail === undefined ? missing !== 0 : missing < 0) return null

  const groups = [
    ...headGroups,
    ...new Array<string>(tail === undefined ? 0 : missing).fill('0'),
    ...tailGroups
  ].map((group) => Number.parseInt(group, 16))

  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : null
}
