import os from 'node:os'
import process from 'node:process'

export type RedactionMode = 'mask' | 'trace' | 'off'

export interface RedactionOptions {
  enabled?: boolean
  mode?: RedactionMode
  ips?: boolean
  tokens?: boolean
  passwords?: boolean
  userPaths?: boolean
  networkInfo?: boolean
  cookies?: boolean
  emails?: boolean
  discordIds?: boolean
  accountInfo?: boolean
}

const DEFAULT_OPTIONS: Required<RedactionOptions> = {
  enabled: true,
  mode: 'mask',
  ips: true,
  tokens: true,
  passwords: true,
  userPaths: true,
  networkInfo: true,
  cookies: true,
  emails: true,
  discordIds: false,
  accountInfo: true
}

const IPV4_REGEX =
  /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g

const IPV6_REGEX =
  /\b(?!::1\b|::\b)(?:[0-9a-fA-F]{1,4}:){1,7}(?:(?::[0-9a-fA-F]{1,4}){1,7}|:)|(?:::([0-9a-fA-F]{1,4}:){1,7}|::[0-9a-fA-F]{1,4})|(?:\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b)/g

const SSID_REGEX = /\(SSID\s+([^)]+)\)/g

const PROXY_AUTH_REGEX =
  /((?:https?|socks5?|ftp):\/\/)([^:\s@]+):([^@\s]+)@/gi

const YT_TOKEN_REGEX = /\byt\.a\.[A-Za-z0-9_\-]{8,}\b/g
const VK_TOKEN_REGEX = /\bvk1\.a\.[A-Za-z0-9_\-]{8,}\b/g
const SPOTIFY_SP_DC_REGEX = /\bAQDV[A-Za-z0-9_\-]{16,}\b/g
const YOUTUBE_REFRESH_TOKEN_REGEX = /\b1\/\/[A-Za-z0-9_\-]{12,}\b/g
const DISCORD_BOT_TOKEN_REGEX =
  /\b[MN][A-Za-z\d]{23,26}\.[\w-]{6}\.[\w-]{27,38}\b/g
const BEARER_AUTH_REGEX =
  /\b(Bearer\s+)([A-Za-z0-9_\-\.~+/]{12,}=*)\b/gi
const BASIC_AUTH_REGEX =
  /\b(Basic\s+)([A-Za-z0-9_\-\.~+/]{12,}=*)\b/gi

const KEY_VALUE_SECRET_REGEX =
  /(["']?(?:[a-zA-Z0-9_]*password|[a-zA-Z0-9_]*secret|decryptionKey|mediaApiToken|apiKey|userToken|mediaUserToken|refreshToken|arl|deviceId|udid)["']?\s*[:=]\s*["']?)([^"'\r\n,;]+)(["']?)/gi

const COOKIE_HEADER_REGEX =
  /(cookie\s*:\s*["']?)([^"'\r\n]+)(["']?)/gi
const COOKIE_FIELD_REGEX =
  /(cookies\s*:\s*["'])([^"'\r\n]+)(["'])/gi
const REMIX_COOKIE_REGEX =
  /\b(remixsid|solution429|COMPASS|SAPISID|APISID|SSID|HSID|SID|SIDCC)=([^;\s"']+)/g

const EMAIL_REGEX =
  /(?<![\/\w@])([a-zA-Z0-9_.+-])[a-zA-Z0-9_.+-]*@([a-zA-Z0-9-]+\.[a-zA-Z]{2,63})\b/g

const LOGIN_ACCOUNT_REGEX =
  /\b(Logged into \w+ as:)\s*([^(\r\n]+?)(?:\s*\(([^)\r\n]+)\))?(?=$|[,\r\n])/gi

const CLIENT_ID_REGEX =
  /(client[_-]?id[:=\s]+|[Cc]lient[ -]ID[:=\s]+|client_id\s*\()([A-Za-z0-9_\-]{16,})(\)?)/gi

const UDID_REGEX =
  /\b((?:Extracted\s+)?(?:X-ANGH-UDID|X-Device-ID|UDID|udid|deviceId|device_id)[^\r\n:]*:\s*)([a-fA-F0-9-]{16,64})\b/gi

const DISCORD_ID_REGEX =
  /\b(?:guild|user|channel|session)?[\s:_]*(\d{17,20})\b/gi

export class LogSanitizer {
  private options: Required<RedactionOptions>
  private traceMap: Map<string, string> = new Map()
  private traceCounters: Record<string, number> = {
    ip: 0,
    ipv6: 0,
    token: 0,
    pass: 0,
    ssid: 0,
    email: 0,
    discord: 0,
    user: 0,
    id: 0
  }
  private userHomePath: string | null = null

  public constructor(options?: RedactionOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
    try {
      this.userHomePath = os.homedir()
    } catch {
      this.userHomePath = null
    }
  }

  public updateOptions(options?: RedactionOptions): void {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  public resetTrace(): void {
    this.traceMap.clear()
    this.traceCounters = {
      ip: 0,
      ipv6: 0,
      token: 0,
      pass: 0,
      ssid: 0,
      email: 0,
      discord: 0,
      user: 0,
      id: 0
    }
  }

  private getTraceToken(type: keyof typeof this.traceCounters, originalValue: string): string {
    const key = `${type}:${originalValue}`
    const existing = this.traceMap.get(key)
    if (existing) {
      return existing
    }
    const nextCount = (this.traceCounters[type] ?? 0) + 1
    this.traceCounters[type] = nextCount
    const generated = `[${type.toUpperCase()}:${nextCount}]`
    this.traceMap.set(key, generated)
    return generated
  }

  public sanitize(input: string): string {
    if (!this.options.enabled || this.options.mode === 'off' || !input) {
      return input
    }

    const isTrace = this.options.mode === 'trace'
    let output = input

    if (this.options.userPaths) {
      if (this.userHomePath && this.userHomePath.length > 2) {
        const escaped = this.userHomePath
          .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\\\\/g, '\\\\+')
        output = output.replace(new RegExp(escaped, 'gi'), '<USER_HOME>')
      }

      output = output.replace(
        /[a-zA-Z]:\\+Users\\+[^\s\\\/:"'<>|]+/gi,
        '<USER_HOME>'
      )

      output = output.replace(
        /\/(?:home|Users)\/[^\s\\\/:"'<>|]+/g,
        '<USER_HOME>'
      )
    }

    if (this.options.networkInfo) {
      output = output.replace(SSID_REGEX, (_match, ssid: string) => {
        const replacement = isTrace
          ? this.getTraceToken('ssid', ssid)
          : '[REDACTED_SSID]'
        return `(SSID ${replacement})`
      })
    }

    if (this.options.passwords) {
      output = output.replace(
        PROXY_AUTH_REGEX,
        (_match, protocol: string, user: string, pass: string) => {
          const userRepl = isTrace ? this.getTraceToken('pass', user) : '[REDACTED_USER]'
          const passRepl = isTrace ? this.getTraceToken('pass', pass) : '[REDACTED_PASS]'
          return `${protocol}${userRepl}:${passRepl}@`
        }
      )

      output = output.replace(
        KEY_VALUE_SECRET_REGEX,
        (_match, prefix: string, secret: string, suffix: string) => {
          const secretRepl = isTrace
            ? this.getTraceToken('pass', secret)
            : '[REDACTED]'
          return `${prefix}${secretRepl}${suffix}`
        }
      )
    }

    if (this.options.cookies) {
      output = output.replace(
        COOKIE_HEADER_REGEX,
        `$1${isTrace ? '[COOKIE:1]' : '[REDACTED_COOKIE]'}$3`
      )
      output = output.replace(
        COOKIE_FIELD_REGEX,
        `$1${isTrace ? '[COOKIE:1]' : '[REDACTED_COOKIE]'}$3`
      )
      output = output.replace(REMIX_COOKIE_REGEX, '$1=[REDACTED_COOKIE]')
    }

    if (this.options.tokens) {
      output = output.replace(YT_TOKEN_REGEX, (token: string) => {
        const replacement = isTrace
          ? this.getTraceToken('token', token)
          : '[REDACTED]'
        return `yt.a...${replacement}`
      })

      output = output.replace(VK_TOKEN_REGEX, (token: string) => {
        const replacement = isTrace
          ? this.getTraceToken('token', token)
          : '[REDACTED]'
        return `vk1.a...${replacement}`
      })

      output = output.replace(SPOTIFY_SP_DC_REGEX, (token: string) => {
        const replacement = isTrace
          ? this.getTraceToken('token', token)
          : '[REDACTED]'
        return `AQDV...${replacement}`
      })

      output = output.replace(YOUTUBE_REFRESH_TOKEN_REGEX, (token: string) => {
        const replacement = isTrace
          ? this.getTraceToken('token', token)
          : '[REDACTED]'
        return `1//...${replacement}`
      })

      output = output.replace(DISCORD_BOT_TOKEN_REGEX, (token: string) => {
        const prefix = token.slice(0, 4)
        const replacement = isTrace
          ? this.getTraceToken('token', token)
          : '[REDACTED]'
        return `${prefix}...${replacement}`
      })

      output = output.replace(
        BEARER_AUTH_REGEX,
        (_match, prefix: string, token: string) => {
          const lead = token.slice(0, 4)
          const replacement = isTrace
            ? this.getTraceToken('token', token)
            : '[REDACTED]'
          return `${prefix}${lead}...${replacement}`
        }
      )

      output = output.replace(
        BASIC_AUTH_REGEX,
        (_match, prefix: string, token: string) => {
          const lead = token.slice(0, 4)
          const replacement = isTrace
            ? this.getTraceToken('token', token)
            : '[REDACTED]'
          return `${prefix}${lead}...${replacement}`
        }
      )

      output = output.replace(
        CLIENT_ID_REGEX,
        (_match, prefix: string, id: string, suffix: string) => {
          const replacement = isTrace
            ? this.getTraceToken('token', id)
            : `${id.slice(0, 4)}...[REDACTED]`
          return `${prefix}${replacement}${suffix}`
        }
      )

      output = output.replace(
        UDID_REGEX,
        (_match, prefix: string, id: string) => {
          const replacement = isTrace
            ? this.getTraceToken('token', id)
            : `${id.slice(0, 4)}...[REDACTED]`
          return `${prefix}${replacement}`
        }
      )
    }

    if (this.options.ips) {
      output = output.replace(IPV4_REGEX, (ip: string) => {
        return isTrace ? this.getTraceToken('ip', ip) : '[REDACTED_IP]'
      })

      output = output.replace(IPV6_REGEX, (ipv6: string) => {
        return isTrace ? this.getTraceToken('ipv6', ipv6) : '[REDACTED_IPV6]'
      })
    }

    if (this.options.emails) {
      output = output.replace(EMAIL_REGEX, (_match, firstChar: string, domain: string) => {
        return isTrace
          ? this.getTraceToken('email', _match)
          : `${firstChar}***@${domain}`
      })
    }

    if (this.options.discordIds) {
      output = output.replace(DISCORD_ID_REGEX, (match: string, snowflake: string) => {
        const lead = snowflake.slice(0, 4)
        const tail = snowflake.slice(-4)
        const replacement = isTrace
          ? this.getTraceToken('discord', snowflake)
          : `${lead}...${tail}`
        return match.replace(snowflake, replacement)
      })
    }

    if (this.options.accountInfo) {
      output = output.replace(
        LOGIN_ACCOUNT_REGEX,
        (_match, prefix: string, user: string, id?: string) => {
          const userRepl = isTrace
            ? this.getTraceToken('user', user)
            : '[REDACTED_USER]'
          const idRepl = id
            ? ` (${isTrace ? this.getTraceToken('id', id) : '[REDACTED_ID]'})`
            : ''
          return `${prefix} ${userRepl}${idRepl}`
        }
      )
    }

    return output
  }
}

export const defaultSanitizer = new LogSanitizer()
