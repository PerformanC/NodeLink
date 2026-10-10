import net from 'node:net'

type HeaderBag = Record<string, string | string[] | undefined>

/**
 * Matches peer addresses against an explicit list of trusted proxy IPs/CIDRs.
 * IPv4 and IPv6 rules are kept in separate lists so an address only matches
 * rules of its own family. Invalid entries are reported through
 * `invalidEntries` and never match.
 * @public
 */
export class TrustedProxyList {
  private readonly ipv4 = new net.BlockList()
  private readonly ipv6 = new net.BlockList()
  readonly invalidEntries: string[] = []
  readonly size: number = 0

  constructor(entries: readonly string[] = []) {
    for (const entry of entries) {
      if (this.add(entry)) {
        this.size += 1
      } else {
        this.invalidEntries.push(entry)
      }
    }
  }

  /**
   * Checks whether an address belongs to a trusted proxy.
   * @param rawAddress - Peer address (IPv4, IPv6 or IPv4-mapped IPv6).
   */
  contains(rawAddress?: string | null): boolean {
    if (this.size === 0) return false

    const address = normalizeAddress(rawAddress)
    if (!address) return false

    return net.isIP(address) === 4
      ? this.ipv4.check(address, 'ipv4')
      : this.ipv6.check(address, 'ipv6')
  }

  private add(entry: string): boolean {
    const [rawAddress, rawPrefix, ...rest] = entry.trim().split('/')
    if (rest.length > 0) return false

    const address = normalizeAddress(rawAddress)
    if (!address) return false

    const isIpv4 = net.isIP(address) === 4
    const bits = isIpv4 ? 32 : 128
    const prefix = rawPrefix === undefined ? bits : Number(rawPrefix)
    const isValidPrefix =
      rawPrefix === undefined ||
      (/^\d+$/.test(rawPrefix) && prefix >= 0 && prefix <= bits)
    if (!isValidPrefix) return false

    if (isIpv4) {
      this.ipv4.addSubnet(address, prefix, 'ipv4')
    } else {
      this.ipv6.addSubnet(address, prefix, 'ipv6')
    }
    return true
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
