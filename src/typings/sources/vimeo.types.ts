/**
 * Type definitions for the Vimeo source provider.
 *
 * Covers Vimeo oEmbed API, API v2, player config JSON,
 * DASH/HLS playlists, and segmented streaming structures.
 * @module typings/sources/vimeo.types
 * @packageDocumentation
 */

import type {
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Vimeo oEmbed API response.
 *
 * Returned by `https://vimeo.com/api/oembed.json`.
 * @public
 */
export interface VimeoOembedResponse {
  /** Video title. */
  title?: string
  /** Author/creator display name. */
  author_name?: string
  /** Video duration in seconds. */
  duration?: number
  /** Thumbnail URL. */
  thumbnail_url?: string
  /** Video width in pixels. */
  width?: number
  /** Video height in pixels. */
  height?: number
  /** Video description. */
  description?: string
  /** Author profile URL. */
  author_url?: string
  /** Provider name (always "Vimeo"). */
  provider_name?: string
  /** Provider URL. */
  provider_url?: string
  /** Embed HTML string. */
  html?: string
}

/**
 * Single video entry from Vimeo API v2.
 *
 * Returned by `https://vimeo.com/api/v2/video/{id}.json`.
 * @public
 */
export interface VimeoApiV2Video {
  /** Numeric video ID. */
  id?: number
  /** Video title. */
  title?: string
  /** Uploader display name. */
  user_name?: string
  /** Video duration in seconds. */
  duration?: number
  /** Large thumbnail URL. */
  thumbnail_large?: string
  /** Medium thumbnail URL. */
  thumbnail_medium?: string
  /** Small thumbnail URL. */
  thumbnail_small?: string
  /** Video description. */
  description?: string
  /** Number of likes. */
  stats_number_of_likes?: number
  /** Number of plays. */
  stats_number_of_plays?: number
  /** Upload date string. */
  upload_date?: string
}

/**
 * Vimeo oEmbed or API v2 metadata result.
 *
 * Normalized shape returned by internal metadata fetchers.
 * @public
 */
export interface VimeoVideoMetadata {
  /** Video title. */
  title: string
  /** Author/creator name. */
  author: string
  /** Duration in milliseconds. */
  durationMs: number
  /** Thumbnail/artwork URL. */
  artworkUrl: string | null
}

/**
 * Single segment entry in a Vimeo DASH/segmented playlist.
 * @public
 */
export interface VimeoPlaylistSegment {
  /** Relative segment URL path. */
  url?: string
  /** Segment start time in seconds. */
  start?: number
  /** Segment end time in seconds. */
  end?: number
  /** Segment byte size. */
  size?: number
}

/**
 * Audio track metadata from Vimeo playlist JSON.
 * @public
 */
export interface VimeoAudioTrack {
  /** Codec string (e.g., "mp4a.40.2"). */
  codecs?: string
  /** Container format identifier (e.g., "mp42", "dash"). */
  format?: string
  /** Average bitrate in bits per second. */
  avg_bitrate?: number
  /** Peak bitrate in bits per second. */
  bitrate?: number
  /** Sample rate in Hz (camelCase variant). */
  sample_rate?: number
  /** Sample rate in Hz (snake_case variant). */
  audio_sample_rate?: number
  /** Track duration in seconds. */
  duration?: number
  /** Base URL for relative segment resolution. */
  base_url?: string
  /** Base64-encoded init segment data. */
  init_segment?: string | null
  /** Segment list for this track. */
  segments?: VimeoPlaylistSegment[]
}

/**
 * Video track metadata from Vimeo playlist JSON (used as audio fallback).
 * @public
 */
export interface VimeoVideoTrack {
  /** Codec string. */
  codecs?: string
  /** Container format identifier. */
  format?: string
  /** Average bitrate in bits per second. */
  avg_bitrate?: number
  /** Peak bitrate in bits per second. */
  bitrate?: number
  /** Track duration in seconds. */
  duration?: number
  /** Base URL for relative segment resolution. */
  base_url?: string
  /** Base64-encoded init segment data. */
  init_segment?: string | null
  /** Segment list for this track. */
  segments?: VimeoPlaylistSegment[]
  /** Video height in pixels (used for quality selection). */
  height?: number
}

/**
 * Vimeo DASH/segmented playlist JSON structure.
 *
 * Fetched from a CDN `playlist.json` endpoint.
 * @public
 */
export interface VimeoPlaylist {
  /** Clip identifier. */
  clip_id?: number | string
  /** Base URL prepended to segment paths. */
  base_url?: string
  /** Available audio tracks. */
  audio?: VimeoAudioTrack[]
  /** Available video tracks. */
  video?: VimeoVideoTrack[]
}

/**
 * CDN entry within Vimeo player config.
 * @public
 */
export interface VimeoCdnConfig {
  /** HLS/segmented playlist URL. */
  url?: string
  /** DASH AVC-specific playlist URL. */
  avc_url?: string
  /** Origin URL for CDN requests. */
  origin?: string
}

/**
 * HLS file config from Vimeo player config.
 * @public
 */
export interface VimeoHlsFile {
  /** Available CDN configurations keyed by CDN name. */
  cdns?: Record<string, VimeoCdnConfig>
  /** Default CDN name. */
  default_cdn?: string
}

/**
 * DASH file config from Vimeo player config.
 * @public
 */
export interface VimeoDashFile {
  /** Available CDN configurations keyed by CDN name. */
  cdns?: Record<string, VimeoCdnConfig>
  /** Default CDN name. */
  default_cdn?: string
}

/**
 * Progressive download entry from Vimeo player config.
 * @public
 */
export interface VimeoProgressiveFile {
  /** Direct media URL. */
  url?: string
  /** Video quality label (e.g., "360p"). */
  quality?: string
  /** Video height in pixels. */
  height?: number
  /** Video width in pixels. */
  width?: number
  /** MIME type. */
  mime?: string
  /** CDN identifier. */
  cdn?: string
  /** File size in bytes. */
  filesize?: number
}

/**
 * File container within Vimeo player config.
 * @public
 */
export interface VimeoConfigFiles {
  /** HLS streaming configuration. */
  hls?: VimeoHlsFile
  /** DASH streaming configuration. */
  dash?: VimeoDashFile
  /** Progressive download options. */
  progressive?: VimeoProgressiveFile[]
}

/**
 * Vimeo player config JSON structure.
 *
 * Extracted from the embed page or fetched from the `config_url`.
 * @public
 */
export interface VimeoConfig {
  /** Request-level files block. */
  request?: {
    /** Available file formats. */
    files?: VimeoConfigFiles
  }
  /** Video-level files block (alternate location). */
  video?: {
    /** Available file formats. */
    files?: VimeoConfigFiles
  }
  /** Direct files block (alternate location). */
  files?: VimeoConfigFiles
  /** Clip-level files block (alternate location). */
  clip?: {
    /** Available file formats. */
    files?: VimeoConfigFiles
  }
  /** Nested config (recursive). */
  config?: VimeoConfig
  /** Player-wrapped config (recursive). */
  player?: {
    /** Nested config. */
    config?: VimeoConfig
  }
  /** Data-wrapped config (recursive). */
  data?: {
    /** Nested config. */
    config?: VimeoConfig
  }
}

/**
 * Parsed playlist data consumed by the segment streamer.
 * @public
 */
export interface VimeoPlaylistData {
  /** Original playlist JSON URL. */
  playlistUrl: string
  /** Base path for relative URL resolution. */
  basePath: string
  /** Track-level base URL path. */
  trackPath: string
  /** Base64-encoded init segment (DASH). */
  initSegment: string | null
  /** Ordered list of media segments. */
  segments: VimeoPlaylistSegment[]
  /** Track duration in seconds. */
  duration?: number
  /** Track bitrate in bits per second. */
  bitrate?: number
  /** Codec string. */
  codecs?: string
  /** Sample rate in Hz (audio only). */
  sampleRate?: number
  /** Clip identifier. */
  clipId?: number | string
  /** Whether this is DASH format (affects init segment handling). */
  isDashFormat?: boolean
  /** Container type passed to the playback demuxer. */
  streamType?: 'fmp4' | 'mp4'
}

/**
 * Progressive stream result returned by `_handleProgressiveUrls`.
 * @public
 */
export interface VimeoProgressiveResult {
  /** Direct media URL. */
  url: string
  /** Protocol (always "https" for progressive). */
  protocol: 'https'
  /** Container format (always "mp4" for progressive). */
  format: 'mp4'
  /** Additional metadata. */
  additionalData: {
    /** Source identifier. */
    source: string
    /** Quality label. */
    quality?: string
    /** Video height in pixels. */
    height: number
  }
}

/**
 * Segment/stream result returned by `_fetchPlaylist`.
 * @public
 */
export interface VimeoSegmentedResult {
  /** Playlist or segment URL. */
  url: string
  /** Stream protocol identifier. */
  protocol: 'segmented' | 'hls' | 'https'
  /** Container format. */
  format: 'fmp4' | 'mp4' | 'mpegts'
  /** Parsed playlist data for segmented streams. */
  playlistData?: VimeoPlaylistData
  /** Additional metadata. */
  additionalData: {
    /** Source identifier. */
    source: string
    /** Track bitrate. */
    bitrate?: number
    /** Codec string. */
    codecs?: string
    /** Number of segments. */
    segments?: number
    /** Sample rate in Hz. */
    sampleRate?: number
    /** Container format from source. */
    format?: string
  }
}

/**
 * HLS stream result returned when HLS CDN is available.
 * @public
 */
export interface VimeoHlsResult {
  /** HLS master playlist URL. */
  url: string
  /** Protocol identifier. */
  protocol: 'hls'
  /** Container format. */
  format: 'mpegts'
  /** Additional metadata. */
  additionalData: {
    /** Source identifier. */
    source: string
  }
}

/**
 * Union of all possible stream extraction results.
 * @public
 */
export type VimeoStreamResult =
  | VimeoProgressiveResult
  | VimeoSegmentedResult
  | VimeoHlsResult

/**
 * Handoff cache entry storing a playlist result with expiration.
 * @public
 */
export interface VimeoHandoffEntry {
  /** Cached playlist/stream result. */
  value: VimeoSegmentedResult
  /** Expiration timestamp (milliseconds since epoch). */
  expiresAt: number
}

/**
 * Vimeo-specific user data stored on decoded tracks.
 *
 * Contains the hash parameter required for private/unlisted videos.
 * @public
 */
export interface VimeoUserData {
  /** Vimeo-specific metadata. */
  vimeo: {
    /** Hash parameter for private video access. */
    h: string
  }
}

/**
 * Decoded track shape accepted by Vimeo `getTrackUrl` and `loadStream`.
 *
 * Extends `TrackInfo` with optional Vimeo-specific user data.
 * @public
 */
export interface VimeoDecodedTrack extends TrackInfo {
  /**
   * Optional Vimeo-specific user data containing the private video hash.
   */
  userData?: VimeoUserData
}

/**
 * Track URL result for Vimeo source.
 * @public
 */
export type VimeoTrackUrlResult = VimeoStreamResult & TrackUrlResult

/**
 * Stream result for Vimeo source.
 * @public
 */
export type VimeoLoadStreamResult = TrackStreamResult

/**
 * Error payload used by Vimeo source exceptions.
 * @public
 */
export interface VimeoErrorPayload {
  /** Error message text. */
  message: string
  /** Error severity category. */
  severity: 'common' | 'suspicious' | 'fault'
  /** Error cause identifier. */
  cause?: string
}

/**
 * Resolve result union used by Vimeo source.
 * @public
 */
export type VimeoResolveResult =
  | {
      loadType: 'track'
      data: {
        encoded: string
        info: TrackInfo
        pluginInfo: Record<string, unknown>
      }
    }
  | { loadType: 'empty'; data: Record<string, never> }
  | SourceResult

/**
 * Source-level state maintained by the Vimeo provider.
 * @public
 */
export interface VimeoSourceState {
  /** NodeLink runtime context. */
  nodelink: VimeoNodeLinkContext
  /** Source configuration options. */
  config: VimeoNodeLinkContext['options']
  /** Search term prefixes (empty — Vimeo does not support search). */
  searchTerms: string[]
  /** URL regex patterns that match Vimeo URLs. */
  patterns: RegExp[]
  /** Source priority for URL pattern matching. */
  priority: number
}

/**
 * Minimal NodeLink context required by Vimeo provider.
 * @public
 */
export interface VimeoNodeLinkContext extends WorkerNodeLink {
  /**
   * Route planner for IP address selection.
   */
  routePlanner?: {
    /** Get an available IP address. */
    getIP?: () => string | null | undefined
  }
}
