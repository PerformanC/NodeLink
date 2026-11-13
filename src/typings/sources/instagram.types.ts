/**
 * Type definitions for the Instagram source.
 *
 * Covers URL parsing, OG metadata extraction, audio API responses,
 * GraphQL post queries, mirror track resolution, and stream loading.
 * @module typings/sources/instagram.types
 */

import type { BestMatchCandidate } from '../utils.types.ts'
import type {
  CredentialManager,
  SourceManager,
  SourceResult,
  TrackInfo,
  TrackStreamResult,
  TrackUrlResult,
  WorkerNodeLink
} from './source.types.ts'

/**
 * Internal API configuration state used by the Instagram source.
 *
 * Stores CSRF tokens, app identifiers, and GraphQL document IDs
 * required to authenticate requests against the Instagram API.
 * @public
 */
export interface InstagramApiConfig {
  /**
   * Instagram GraphQL API endpoint URL.
   *
   * @example `'https://www.instagram.com/api/graphql'`
   */
  apiUrl: string

  /**
   * Instagram clips/audio API endpoint URL.
   *
   * @example `'https://www.instagram.com/api/v1/clips/music/'`
   */
  audioApiUrl: string

  /**
   * CSRF token extracted from the Instagram homepage.
   * Used to authenticate API requests.
   *
   * @remarks
   * `null` until `setup()` successfully fetches the homepage.
   */
  csrfToken: string | null

  /**
   * Instagram application ID extracted from the homepage.
   * Sent as `X-IG-App-ID` header on API requests.
   *
   * @remarks
   * `null` until `setup()` successfully fetches the homepage.
   */
  igAppId: string | null

  /**
   * Facebook LSD token extracted from the homepage.
   * Sent as `X-FB-LSD` header and as a form parameter.
   *
   * @remarks
   * `null` until `setup()` successfully fetches the homepage.
   */
  fbLsd: string | null

  /**
   * Jazoest checksum parameter sent with GraphQL requests.
   *
   * @defaultValue `'2957'`
   */
  jazoest: string
}

/**
 * Subset of {@link InstagramApiConfig} persisted via the CredentialManager.
 *
 * Only the fields that may change between sessions are cached; static
 * values like `apiUrl` and `jazoest` are kept as defaults.
 * @public
 */
export interface InstagramCachedConfig {
  /** Cached CSRF token. */
  csrfToken: string
  /** Cached Instagram app ID. */
  igAppId: string
  /** Cached Facebook LSD token. */
  fbLsd: string
}

/**
 * Post/reel media fields returned by the logged-out Polaris query.
 * @internal
 */
export interface InstagramPostMedia {
  video_versions?: Array<{ url?: string }>
  image_versions2?: { candidates?: Array<{ url?: string }> }
  user?: { username?: string }
  caption?: { text?: string }
  video_dash_manifest?: string
  carousel_media?: InstagramPostMedia[]
}

/**
 * Parsed Instagram URL metadata returned by `_extractInfo`.
 *
 * Distinguishes between post/reel URLs and audio page URLs
 * so the source can route to the correct API handler.
 * @public
 */
export interface InstagramUrlInfo {
  /**
   * Extracted content identifier (shortcode or audio ID).
   *
   * @remarks
   * `null` when the URL does not match any known pattern.
   */
  id: string | null

  /**
   * Human-readable error when parsing fails.
   *
   * @remarks
   * `null` on successful extraction.
   */
  error: string | null

  /**
   * Content type discriminator.
   *
   * - `'post'` — a photo, video, or carousel post/reel.
   * - `'audio'` — an audio page (`/reels/audio/:id`).
   *
   * @remarks
   * `null` when the URL does not match any known pattern.
   */
  type: 'post' | 'audio' | null

  /**
   * URL path segment used in the Referer header.
   *
   * - `'p'` — standard post URL.
   * - `'reel'` — reel/short-video URL.
   *
   * @remarks
   * Only present when `type` is `'post'`.
   */
  pathSegment?: 'p' | 'reel'
}

/**
 * Audio metadata extracted from OG meta tags on an Instagram audio page.
 *
 * Used as a lightweight fallback before attempting the authenticated
 * audio API endpoint.
 * @public
 */
export interface InstagramOgAudioMetadata {
  /** Author/artist name parsed from the OG title or description. */
  author: string

  /** Normalized title parsed from OG metadata. */
  title: string

  /** Thumbnail image URL from `og:image`. */
  thumbnail: string

  /** Duration in milliseconds (always `-1` for OG metadata). */
  length: number

  /** Whether the audio is a live stream (always `false`). */
  isStream: boolean

  /** Whether the audio can be seeked (always `true`). */
  isSeekable: boolean

  /** Raw OG description string. */
  description: string

  /**
   * Search query constructed from the parsed author and title.
   *
   * @remarks
   * Used to find mirror tracks on other sources.
   */
  searchQuery: string
}

/**
 * Result of parsing OG title and description for audio metadata.
 * @internal
 */
export interface InstagramParsedOgMetadata {
  /** Author name extracted from OG metadata. */
  author: string | null

  /** Title extracted from OG metadata. */
  title: string | null

  /**
   * Combined search query built from author and title.
   *
   * @remarks
   * Falls back to the normalized title when both are missing.
   */
  searchQuery: string
}

/**
 * Raw track data returned by `_fetchFromAudioAPI` and `_fetchFromGraphQL`.
 *
 * Represents the direct media URL and metadata before it is wrapped
 * in a full {@link TrackInfo} payload.
 * @public
 */
export interface InstagramRawTrackData {
  /** Direct video or audio download URL. */
  videoUrl: string

  /** Author or artist name. */
  author: string

  /** Duration in milliseconds. */
  length: number

  /** Thumbnail or artwork URL. */
  thumbnail: string

  /** Track title. */
  title: string

  /** Whether this is a live stream. */
  isStream: boolean

  /** Whether the track is seekable. */
  isSeekable: boolean

  /**
   * Optional description from OG metadata.
   *
   * @remarks
   * Only populated when resolving via `_fetchAudioOgMetadata`.
   */
  description?: string
}

/**
 * Plugin metadata attached to Instagram track payloads.
 * @public
 */
export interface InstagramPluginInfo extends Record<string, unknown> {
  /**
   * Optional description extracted from OG metadata.
   *
   * @remarks
   * Present on audio page resolves; absent on post resolves.
   */
  description: string | null
}

/**
 * Encoded Instagram track payload returned to the source manager.
 * @public
 */
export interface InstagramTrackData {
  /**
   * Base64-encoded Lavalink-compatible track payload.
   */
  encoded: string

  /**
   * Human-readable track information.
   */
  info: TrackInfo

  /**
   * Instagram-specific plugin metadata.
   */
  pluginInfo: InstagramPluginInfo
}

/**
 * Candidate info used for mirror track matching.
 *
 * Contains the title and author extracted from a search result
 * candidate, used to determine if it is an acceptable mirror
 * for the original Instagram audio.
 * @public
 */
export interface InstagramMirrorCandidateInfo {
  /** Track title from the candidate. */
  title?: string

  /** Author name from the candidate. */
  author?: string
}

/**
 * Internal fetch result wrapper used by audio and GraphQL helpers.
 *
 * All internal `_fetch*` methods return this shape to allow
 * consistent error handling in the public methods.
 * @public
 */
export interface InstagramFetchResult {
  /**
   * Resolved track data on success.
   *
   * @remarks
   * `null` when `exception` is set.
   */
  data: InstagramRawTrackData | null

  /**
   * Error details on failure.
   *
   * @remarks
   * `null` on success.
   */
  exception: {
    /** Human-readable error message. */
    message: string
    /** Error severity level. `'common'` for expected failures, `'fault'` for internal errors. */
    severity: string
    /** Optional additional context about the failure. */
    cause?: string
  } | null
}

/**
 * OG metadata fetch result used by `_fetchAudioOgMetadata`.
 *
 * Extends {@link InstagramFetchResult} with the richer
 * {@link InstagramRawTrackData} shape that includes a description field.
 * @public
 */
export interface InstagramOgFetchResult {
  /** Resolved OG audio metadata on success, or `null` on failure. */
  data: InstagramRawTrackData | null
  /** Error details on failure, or `null` on success. */
  exception: {
    /** Human-readable error message. */
    message: string
    /** Error severity level. */
    severity: string
  } | null
}

/**
 * Decoded track accepted by Instagram `getTrackUrl` and `loadStream`.
 *
 * Extends {@link TrackInfo} with optional plugin metadata injected
 * during the resolve phase.
 * @public
 */
export type InstagramDecodedTrack = TrackInfo & {
  /**
   * Optional plugin metadata injected during resolve.
   */
  pluginInfo?: Partial<InstagramPluginInfo>
}

/**
 * Track URL response for Instagram source.
 * @public
 */
export type InstagramTrackUrlResult = TrackUrlResult & {
  /** Protocol used by the resolved media URL. */
  protocol: 'https' | 'http'
  /** Media container format. */
  format: 'mp4'
}

/**
 * Stream result union for Instagram source.
 * @public
 */
export type InstagramLoadStreamResult =
  | TrackStreamResult
  | { exception: { message: string; severity: string; cause?: string } }

/**
 * Resolve result union used by Instagram source.
 * @public
 */
export type InstagramResolveResult =
  | { loadType: 'track'; data: InstagramTrackData }
  | { loadType: 'empty'; data: Record<string, never> }
  | SourceResult

/**
 * Mirror resolution result returned by `_resolveAudioMirrorTrack`.
 * @public
 */
export type InstagramMirrorResult =
  | (TrackUrlResult & {
      /**
       * The matched mirror track with updated metadata.
       */
      newTrack: BestMatchCandidate & { info: TrackInfo }
    })
  | {
      /**
       * Exception when no acceptable mirror is found.
       */
      exception: {
        /** Human-readable error message. */
        message: string
        /** Error severity level. */
        severity: string
      }
    }

/**
 * Minimal NodeLink context required by Instagram source.
 *
 * Extends the base {@link WorkerNodeLink} with required `sources`
 * and `credentialManager` properties used for mirror resolution
 * and API config caching.
 * @public
 */
export interface InstagramNodeLinkContext extends WorkerNodeLink {
  /**
   * Source manager used for delegated mirror searches and track URL resolution.
   */
  sources: SourceManager

  /**
   * Credential manager used to cache Instagram API tokens.
   */
  credentialManager: CredentialManager
}

/**
 * Extended track info passed from mirror resolution to stream loading.
 *
 * Carries the matched mirror candidate metadata alongside the
 * original Instagram track info.
 * @public
 */
export interface InstagramMirrorTrackResult {
  /** Updated track info from the mirror candidate. */
  info: TrackInfo

  /** Whether mirror resolution succeeded without exceptions. */
  exception?: never
}
