import { normalizeFormat } from '../constants.ts'
import type {
  StreamBufferProfileName,
  StreamOutputMode,
  StreamTransportAction,
  StreamTransportBufferProfile,
  StreamTransportConfig,
  StreamTransportRule,
  StreamTransportRuleMatch
} from '../typings/config/config.types.ts'
import {
  StreamBufferProfileName as BufferProfiles,
  StreamOutputMode as OutputModes,
  StreamTransportPreset as Presets
} from '../typings/config/config.types.ts'
import type {
  SourceStreamCapabilities,
  TrackInfo
} from '../typings/sources/source.types.ts'

const DEFAULT_BUFFER_PROFILES: Record<
  StreamBufferProfileName,
  StreamTransportBufferProfile
> = {
  compact: {
    lowWatermarkBytes: 32 * 1024,
    targetWatermarkBytes: 96 * 1024,
    highWatermarkBytes: 192 * 1024
  },
  standard: {
    lowWatermarkBytes: 64 * 1024,
    targetWatermarkBytes: 192 * 1024,
    highWatermarkBytes: 384 * 1024
  },
  large: {
    lowWatermarkBytes: 128 * 1024,
    targetWatermarkBytes: 512 * 1024,
    highWatermarkBytes: 1024 * 1024
  }
}

const DEFAULT_ACTION: StreamTransportAction = {
  transport: 'direct',
  output: OutputModes.RAW,
  bufferProfile: BufferProfiles.STANDARD
}

/**
 * Input metadata used to evaluate StreamTransport routing rules.
 */
export interface StreamTransportRouteInput {
  track: Pick<TrackInfo, 'sourceName' | 'isStream' | 'length'>
  protocol?: string
  rawFormat?: string
  additionalData?: Record<string, unknown>
  capabilities?: SourceStreamCapabilities
}

/**
 * Resolved routing decision for a single track stream.
 */
export interface StreamTransportRouteDecision {
  transport: 'worker' | 'direct'
  output: StreamOutputMode
  bufferProfile: StreamBufferProfileName
  watermarks: StreamTransportBufferProfile
  ruleName: string
  codec: string
  rawFormat: string
}

function getPresetRules(config: StreamTransportConfig): StreamTransportRule[] {
  switch (config.preset) {
    case Presets.ENCRYPTED_ONLY:
      return [
        {
          name: 'preset:encrypted-only',
          enabled: true,
          match: { encrypted: true },
          action: {
            transport: 'worker',
            output: OutputModes.RAW,
            bufferProfile: BufferProfiles.STANDARD
          }
        }
      ]
    case Presets.BALANCED:
      return [
        {
          name: 'preset:balanced:live',
          enabled: true,
          match: { isLive: true },
          action: {
            transport: 'worker',
            output: OutputModes.DEMUXED,
            bufferProfile: BufferProfiles.LARGE
          }
        },
        {
          name: 'preset:balanced:encrypted',
          enabled: true,
          match: { encrypted: true },
          action: {
            transport: 'worker',
            output: OutputModes.RAW,
            bufferProfile: BufferProfiles.STANDARD
          }
        },
        {
          name: 'preset:balanced:segmented',
          enabled: true,
          match: { protocols: ['hls', 'sabr', 'dash', 'segmented'] },
          action: {
            transport: 'worker',
            output: OutputModes.DEMUXED,
            bufferProfile: BufferProfiles.STANDARD
          }
        }
      ]
    case Presets.FULL_OFFLOAD:
      return [
        {
          name: 'preset:full-offload',
          enabled: true,
          match: {},
          action: {
            transport: 'worker',
            output: OutputModes.DEMUXED,
            bufferProfile: BufferProfiles.STANDARD
          }
        }
      ]
    case Presets.CPU_SAVER:
      return [
        {
          name: 'preset:cpu-saver',
          enabled: true,
          match: {},
          action: {
            transport: 'worker',
            output: OutputModes.PCM,
            bufferProfile: BufferProfiles.LARGE
          }
        }
      ]
    case Presets.CUSTOM:
      return config.rules ?? []
    default:
      return []
  }
}

function normalizeTokenList(list?: string[]): string[] | null {
  if (!Array.isArray(list) || list.length === 0) return null
  return list.map((item) => item.trim().toLowerCase()).filter(Boolean)
}

function matchesRule(
  match: StreamTransportRuleMatch,
  ctx: {
    sourceName: string
    isLive: boolean
    encrypted: boolean
    protocol: string
    rawFormat: string
    codec: string
    durationMs: number
  }
): boolean {
  const sources = normalizeTokenList(match.sources)
  if (sources && !sources.includes('*') && !sources.includes(ctx.sourceName)) {
    return false
  }

  if (typeof match.isLive === 'boolean' && match.isLive !== ctx.isLive) {
    return false
  }

  if (
    typeof match.encrypted === 'boolean' &&
    match.encrypted !== ctx.encrypted
  ) {
    return false
  }

  const protocols = normalizeTokenList(match.protocols)
  if (protocols && !protocols.includes(ctx.protocol)) {
    return false
  }

  const formats = normalizeTokenList(match.formats)
  if (formats && !formats.includes(ctx.rawFormat)) {
    return false
  }

  const codecs = normalizeTokenList(match.codecs)
  if (codecs && !codecs.includes(ctx.codec)) {
    return false
  }

  if (
    typeof match.minDurationMs === 'number' &&
    ctx.durationMs < match.minDurationMs
  ) {
    return false
  }

  if (
    typeof match.maxDurationMs === 'number' &&
    match.maxDurationMs > 0 &&
    ctx.durationMs > match.maxDurationMs
  ) {
    return false
  }

  return true
}

function resolveBufferProfile(
  config: StreamTransportConfig | undefined,
  profileName: StreamBufferProfileName = BufferProfiles.STANDARD
): StreamTransportBufferProfile {
  const defaults = DEFAULT_BUFFER_PROFILES[profileName]
  const override = config?.bufferProfiles?.[profileName]
  if (!override) return defaults

  return {
    lowWatermarkBytes: override.lowWatermarkBytes ?? defaults.lowWatermarkBytes,
    targetWatermarkBytes:
      override.targetWatermarkBytes ?? defaults.targetWatermarkBytes,
    highWatermarkBytes:
      override.highWatermarkBytes ?? defaults.highWatermarkBytes
  }
}

/**
 * Evaluates global `cluster.streamTransport` configuration against track metadata,
 * source capabilities, and resolved stream descriptors.
 */
export function resolveStreamTransportRoute(
  config: StreamTransportConfig | undefined,
  input: StreamTransportRouteInput
): StreamTransportRouteDecision {
  const sourceName = (input.track.sourceName || '').toLowerCase()
  const protocol = (input.protocol || '').toLowerCase()
  const rawFormatRaw =
    input.rawFormat ||
    (typeof input.additionalData?.__resolvedFormat === 'string'
      ? input.additionalData.__resolvedFormat
      : '') ||
    protocol
  const rawFormat = rawFormatRaw.toLowerCase()
  const codec = normalizeFormat(rawFormat || protocol)

  const directDecision = (ruleName: string): StreamTransportRouteDecision => ({
    transport: 'direct',
    output: OutputModes.RAW,
    bufferProfile: BufferProfiles.STANDARD,
    watermarks: resolveBufferProfile(config, BufferProfiles.STANDARD),
    ruleName,
    codec,
    rawFormat
  })

  if (!config?.enabled || config.preset === Presets.OFF) {
    return directDecision('disabled')
  }

  if (input.capabilities?.isMirror) {
    return directDecision('mirror-source')
  }

  const allowedSources = normalizeTokenList(config.sources) ?? ['*']
  const excludedSources = normalizeTokenList(config.excludeSources) ?? []

  if (excludedSources.includes(sourceName)) {
    return directDecision('excluded-source')
  }

  if (!allowedSources.includes('*') && !allowedSources.includes(sourceName)) {
    return directDecision('source-not-in-scope')
  }

  const ctx = {
    sourceName,
    isLive: Boolean(input.track.isStream || input.additionalData?.isLive),
    encrypted: Boolean(
      input.capabilities?.encryptedStream || input.additionalData?.isEncrypted
    ),
    protocol,
    rawFormat,
    codec,
    durationMs: Number(input.track.length) || 0
  }

  const rules = getPresetRules(config)
  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (matchesRule(rule.match ?? {}, ctx)) {
      const profile = rule.action.bufferProfile ?? BufferProfiles.STANDARD
      return {
        transport: rule.action.transport,
        output: rule.action.output,
        bufferProfile: profile,
        watermarks: resolveBufferProfile(config, profile),
        ruleName: rule.name || 'unnamed-rule',
        codec,
        rawFormat
      }
    }
  }

  const fallbackAction = config.defaultAction ?? DEFAULT_ACTION
  const fallbackProfile = fallbackAction.bufferProfile ?? BufferProfiles.STANDARD
  return {
    transport: fallbackAction.transport,
    output: fallbackAction.output,
    bufferProfile: fallbackProfile,
    watermarks: resolveBufferProfile(config, fallbackProfile),
    ruleName: 'defaultAction',
    codec,
    rawFormat
  }
}
