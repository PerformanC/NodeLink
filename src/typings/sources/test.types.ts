import type { Readable } from 'node:stream'
import type { TrackInfo } from './source.types.ts'

/**
 * Supported assertion operations for test values.
 * @public
 */
export type SourceTestMatcher =
  | { op: 'equals'; value: unknown }
  | { op: 'not-equals'; value: unknown }
  | { op: 'matches'; value: string | RegExp }
  | { op: 'not-matches'; value: string | RegExp }
  | { op: 'between'; min: number; max: number }
  | { op: 'at-least'; value: number }
  | { op: 'at-most'; value: number }
  | { op: 'exists'; value: boolean }

/**
 * Representation of an internal execution variant within a source (e.g. client, engine, strategy).
 * @public
 */
export interface SourceTestVariant {
  /** Unique variant identifier (e.g. 'Web', 'Android', 'IOS'). */
  id: string
  /** Human-readable label for logs and diagnostics. */
  label?: string
  /** Optional variant-specific options or overrides. */
  options?: Record<string, unknown>
  /** Documented skip condition for this variant. */
  skip?: {
    reason: string
  }
}

/**
 * Standardized result returned by a source for a specific execution variant.
 * The runner consumes this without knowing platform-specific protocols or internals.
 * @public
 */
export interface SourceTestVariantResult {
  /** Identifier of the variant that produced this result. */
  variant: string
  /** Whether the variant successfully resolved the track/stream. */
  resolved: boolean
  /** Whether this variant was skipped. */
  skipped?: boolean
  /** Documented reason if the variant was skipped. */
  skipReason?: string
  /** Resolved track metadata, if available or enriched by this variant. */
  track?: TrackInfo
  /** Stream of audio data provided by the source. */
  stream?: Readable | NodeJS.ReadableStream | ReadableStream<Uint8Array>
  /** Real HTTP status code, if an HTTP endpoint was involved. */
  httpStatus?: number
  /** Response headers from the server, if available. */
  headers?: Record<string, string>
  /** Identified container format (e.g. 'webm', 'mp4', 'ogg'). */
  container?: string
  /** Identified codec (e.g. 'opus', 'aac'). */
  codec?: string
  /** Content-Length in bytes, if advertised. */
  contentLength?: number
  /** Content-Range header value, if returned (e.g. HTTP 206). */
  contentRange?: string
  /** Error or exception thrown if this variant failed. */
  error?: Error | string
}

/**
 * Interface implemented by sources that offer internal execution variants.
 * @public
 */
export interface SourceVariantHandler {
  /**
   * Executes an operation for a specific variant in complete isolation without silent fallbacks.
   */
  executeVariant(
    variant: SourceTestVariant,
    track: TrackInfo,
    streamSpec?: SourceTestStreamSpec
  ): Promise<SourceTestVariantResult>
}

/**
 * Pair of container and codec allowed for audio validation.
 * @public
 */
export interface AllowedAudioFormat {
  container: string
  codec: string
}

/**
 * Specification for stream testing and audio integrity verification.
 * @public
 */
export interface SourceTestStreamSpec {
  /** Whether stream download and validation is required. */
  required: boolean
  /** Download mode: complete download for finite media, or limited window for live streams. */
  download:
    | 'complete'
    | {
        mode: 'window'
        maxDurationMs: number
        maxBytes?: number
      }
  /** Minimum bytes expected from the stream. */
  minBytes?: number
  /** Valid combinations of container and codec (e.g. [{ container: 'webm', codec: 'opus' }]). */
  validFormats?: readonly AllowedAudioFormat[]
  /** Whether to enforce complete decoding to EOF through NodeLink demuxers/decoders. */
  decodeToEnd?: boolean
}

/**
 * Specification for collection (playlist / album / search) testing.
 * @public
 */
export interface SourceTestCollectionSpec {
  /** Minimum number of items expected in the collection. */
  minItems?: number
  /** Maximum number of items allowed in the collection. */
  maxItems?: number
  /** Expected matchers for specific items in order. */
  expectedItems?: Partial<Record<keyof TrackInfo, SourceTestMatcher>>[]
  /** Which item to select for the stream test, if stream is enabled. */
  selectTrackForStream?: 'first' | 'last' | number
}

/**
 * Declarative test case definition for a source.
 * @public
 */
export interface SourceTestCase {
  /** Unique test case identifier (e.g. 'youtube.video.standard'). */
  id: string
  /** Descriptive test case name. */
  name: string

  /** Input definition for the test. */
  input:
    | {
        type: 'resolve'
        value: string
      }
    | {
        type: 'search'
        value: string
        searchType?: string
      }

  /** Matrix of execution variants to test independently. */
  matrix?: {
    variants: readonly SourceTestVariant[]
  }

  /** Expected conditions that MUST be satisfied for the test to pass. */
  expect: {
    result: {
      type: 'track' | 'playlist' | 'search' | 'empty'
    }

    /** Metadata assertions strictly typed against TrackInfo fields. */
    metadata?: Partial<Record<keyof TrackInfo, SourceTestMatcher>>

    /** Collection assertions for playlists and searches. */
    collection?: SourceTestCollectionSpec

    /** Stream testing specification. */
    stream?: SourceTestStreamSpec
  }

  /** Forbidden conditions that MUST NOT happen (e.g. empty results, duration <= 0). */
  forbid?: {
    resultTypes?: readonly string[]
    metadata?: Partial<Record<keyof TrackInfo, SourceTestMatcher>>
  }

  /** Skip condition for scenarios that are temporarily non-testable. */
  skip?: {
    reason: string
  }
}
