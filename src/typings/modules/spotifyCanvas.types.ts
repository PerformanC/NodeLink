/**
 * Parsed varint payload with next read cursor.
 * @public
 */
export interface SpotifyCanvasVarintResult {
  /**
   * Decoded varint numeric value.
   */
  val: number

  /**
   * Next byte offset after varint read.
   */
  next: number
}

/**
 * Artist block embedded in Spotify canvas payload.
 * @public
 */
export interface SpotifyCanvasArtist {
  /**
   * Spotify URI for the artist.
   */
  artistUri: string

  /**
   * Display name for the artist.
   */
  artistName: string

  /**
   * Artist image URL.
   */
  artistImgUrl: string
}

/**
 * Single canvas entry returned by Spotify Canvaz service.
 * @public
 */
export interface SpotifyCanvasEntry {
  /**
   * Canvas identifier.
   */
  id: string

  /**
   * Canvas media URL.
   */
  canvasUrl: string

  /**
   * Track Spotify URI.
   */
  trackUri: string

  /**
   * Embedded artist metadata.
   */
  artist: SpotifyCanvasArtist

  /**
   * Canvas Spotify URI.
   */
  canvasUri: string

  /** Optional additional identifier (protobuf field 9). */
  otherId?: string

  /** Provider-supplied media file identifier (Pathfinder). */
  fileId?: string

  /** Provider-supplied Canvas playback type (Pathfinder). */
  type?: string
}

/**
 * Decoded canvas list response.
 * @public
 */
export interface SpotifyCanvasDecodedResponse {
  /**
   * List of parsed canvas entries.
   */
  canvasesList: SpotifyCanvasEntry[]
}

/**
 * Wrapper returned by fetchCanvas helper.
 * @public
 */
export interface SpotifyCanvasFetchResult {
  /**
   * Parsed canvas payload.
   */
  data: SpotifyCanvasDecodedResponse
}
