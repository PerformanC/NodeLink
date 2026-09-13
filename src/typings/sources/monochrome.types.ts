/**
 * Configuration options for the Monochrome audio source.
 * @public
 */
export interface MonochromeSourceConfig {
  /** Whether the Monochrome source is enabled. */
  enabled: boolean
  /** List of API instances to use for metadata and search. */
  instances?: string[]
  /** List of streaming instances used for manifest resolution. */
  streamingInstances?: string[]
  /** List of Qobuz proxy instances used as fallback for stream resolution. */
  qobuzInstances?: string[]
  /** Preferred audio quality. */
  quality?: 'HI_RES_LOSSLESS' | 'LOSSLESS' | 'HIGH' | 'LOW'
  /** Quality level for Qobuz proxy downloads (5 = MP3 320kbps, 6 = Default FLAC, 7 = FLAC 24bit, 27 = HiRes FLAC 24bit). */
  qobuzQuality?: number
}

/**
 * Health and scoring for a Monochrome instance.
 */
export interface InstanceHealth {
  url: string
  score: number
  lastFailure: number
  failures: number
  activeRequests: number
  version?: string
}

/**
 * Normalization data for audio leveling.
 */
export interface MonochromeNormalization {
  replayGain: number
  peakAmplitude: number
}

/**
 * Standard Tidal-like artist structure.
 */
export interface MonochromeArtist {
  id: number
  name: string
  url?: string
  picture?: string
  handle?: string | null
  type?: string
}

/**
 * Standard Tidal-like album structure.
 */
export interface MonochromeAlbum {
  id: number
  title: string
  url?: string
  cover: string
  vibrantColor?: string
  releaseDate?: string
  numberOfTracks?: number
  artist?: MonochromeArtist
  artists?: MonochromeArtist[]
  mediaMetadata?: {
    tags: string[]
  }
}

/**
 * Standard Tidal-like track structure.
 */
export interface MonochromeTrack {
  id: number
  title: string
  version?: string
  duration: number
  trackNumber: number
  volumeNumber: number
  isrc: string
  url: string
  audioQuality: string
  audioModes?: string[]
  explicit: boolean
  streamReady?: boolean
  allowStreaming?: boolean
  artist: MonochromeArtist
  artists: MonochromeArtist[]
  album: MonochromeAlbum
  mediaMetadata?: {
    tags: string[]
  }
}

/**
 * Specialized Video structure.
 */
export interface MonochromeVideo {
  id: number
  title: string
  duration: number
  image: string
  artist: MonochromeArtist
  artists: MonochromeArtist[]
  type?: string
  quality?: string
}

/**
 * Metadata for a playlist.
 */
export interface MonochromePlaylistMetadata {
  uuid: string
  title: string
  numberOfTracks: number
  description: string
  image: string
  url: string
}

/**
 * Common API response wrapper.
 */
export interface MonochromeResponse<T> {
  version: string
  data: T
}

/**
 * Specialized response for lists (search, items).
 */
export interface MonochromePagedItems<T> {
  items: T[]
  limit: number
  offset: number
  totalNumberOfItems: number
}

/**
 * Search results.
 */
export interface MonochromeSearchResults {
  tracks?: MonochromePagedItems<MonochromeTrack>
  albums?: MonochromePagedItems<MonochromeAlbum>
  artists?: MonochromePagedItems<MonochromeArtist>
  playlists?: MonochromePagedItems<MonochromePlaylistMetadata>
  videos?: MonochromePagedItems<MonochromeVideo>
}

/**
 * Streaming manifest attributes.
 */
export interface MonochromeManifestAttributes {
  uri: string
  formats: string[]
  manifest?: string
  previewReason?: string
  trackPresentation?: string
  trackAudioNormalizationData?: MonochromeNormalization
  albumAudioNormalizationData?: MonochromeNormalization
}

/**
 * Detailed streaming manifest response.
 */
export interface MonochromeManifestResponse {
  version: string
  data: {
    data: {
      id: string
      type: string
      attributes: MonochromeManifestAttributes
    }
  }
}

/**
 * Tidal lyrics structure.
 */
export interface TidalLyrics {
  trackId: number
  lyricsProvider: string
  providerLyricsId: string
  lyrics: string
  subtitles: string
}

/**
 * Specialized response for lyrics.
 */
export interface MonochromeLyricsResponse {
  version: string
  lyrics: TidalLyrics
}
