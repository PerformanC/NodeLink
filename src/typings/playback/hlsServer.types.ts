import type { Buffer } from 'node:buffer'
import type { Readable, Transform } from 'node:stream'
import type { EncodedTrackPayload } from '../utils.types.ts'
import type { FiltersState } from './player.types.ts'

/**
 * Opus configuration used by the HLS fMP4 muxer.
 * @public
 */
export interface HlsOpusConfig {
  sampleRate: number
  channels: number
  frameSize: number
  preSkip: number
}

/**
 * Metadata for a generated HLS media segment.
 * @public
 */
export interface HlsMediaSegmentData {
  sequence: number
  duration: number
  startTimeMs: number
  endTimeMs: number
  data: Buffer
}

/**
 * Cache entry stored in memory for fast segment serving.
 * @public
 */
export interface HlsSegmentCacheEntry {
  data: Buffer
  contentType: string
  createdAt: number
}

/**
 * Playlist entry describing an individual segment in an M3U8 manifest.
 * @public
 */
export interface HlsPlaylistEntry {
  sequence: number
  duration: number
  uri: string
}

/**
 * Configuration options for generating an HLS playlist.
 * @public
 */
export interface HlsPlaylistBuildOptions {
  encodedTrack: string
  trackLengthMs: number
  segmentDurationSec: number
  isStream: boolean
  baseUrl?: string
  sessionId?: string
  version?: number
  liveSegments?: Array<{ sequence: number; duration: number }>
}

/**
 * Session initialization options for HLS playback.
 * @public
 */
export interface HlsSessionOptions {
  sessionId: string
  encodedTrack: string
  track: EncodedTrackPayload
  segmentDurationSec: number
  volume: number
  filters: FiltersState
}

/**
 * Continuous audio pipeline feeder state for an active HLS session.
 * @public
 */
export interface HlsFeeder {
  startSegment: number
  nextSegment: number
  baseMediaDecodeTime: bigint
  targetFrames: number
  currentPackets: Buffer[]
  pcmStream:
    | (Readable & {
        destroy: (error?: Error) => void
        isPaused?: () => boolean
      })
    | null
  fetchedStream: (Readable & { destroy: (error?: Error) => void }) | null
  encoder: Transform & { destroy: () => void }
  ended: boolean
  destroy: () => void
}

/**
 * Internal session representation maintaining segment cache and continuous decode state.
 * @public
 */
export interface HlsSessionInternal {
  id: string
  encodedTrack: string
  track: EncodedTrackPayload
  segmentDurationSec: number
  volume: number
  filters: FiltersState
  initSegment: Buffer
  segments: Map<number, Buffer>
  pendingSegments: Map<number, Promise<Buffer>>
  pendingResolvers: Map<number, (data: Buffer) => void>
  pendingRejecters: Map<number, (err: Error) => void>
  createdAt: number
  lastAccessedAt: number
  lastRequestedSegment: number
  feeder: HlsFeeder | null
  feederStarting: Promise<void> | null
  livePackets: Buffer[]
  liveCurrentSeq: number
  destroyed: boolean
  destroy: () => void
}
