import type { FiltersState } from '../playback/player.types.ts'

/**
 * Normalized input parsed from HLS HTTP endpoint requests.
 * @public
 */
export interface HlsRequestInput {
  encodedTrack: string
  sessionId?: string
  action: 'playlist' | 'init' | 'segment'
  sequence?: number
  segmentDuration: number
  volume: number
  filters: FiltersState
}

/**
 * Track URL payload returned by the source resolution subsystem for HLS.
 * @public
 */
export interface HlsTrackUrlResult {
  url?: string
  protocol?: string
  format?: string | { itag?: number; [key: string]: unknown }
  newTrack?: {
    info: import('../sources/source.types.ts').TrackInfo
  }
  additionalData?: Record<string, unknown>
  exception?: {
    message: string
    severity?: string
    cause?: string
  }
}
