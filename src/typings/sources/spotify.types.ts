/**
 * Token types supported by Spotify authentication flows.
 * @public
 */
export type SpotifyTokenType = 'official' | 'anonymous' | 'mobile'

/**
 * Definition of a GraphQL operation for the Spotify Pathfinder API.
 * @public
 */
export interface SpotifyGraphQLOperation {
  /** The name of the GraphQL operation. */
  name: string
  /** The SHA256 hash of the persisted query. */
  hash: string
}

/**
 * Metadata response from the internal Spotify Client API.
 * Includes advanced fields like ISRC and GIDs.
 * @public
 */
export interface SpotifyMetadataResponse {
  /** The name of the track. */
  name?: string
  /** Canonical Spotify URI. */
  canonical_uri?: string
  /** Global ID used for internal metadata matching. */
  gid?: string
  /** Whether the content is marked as explicit. */
  explicit?: boolean
  /** Duration of the track in milliseconds. */
  duration?: number
  /** List of artists associated with the track. */
  artist?: Array<{ name: string }>
  /** Album metadata containing cover information. */
  album?: {
    name?: string
    cover_group?: {
      image?: Array<{ file_id: string; size: string }>
    }
  }
  /** External identifiers like ISRC. */
  external_id?: Array<{ type: string; id: string }>
}

/**
 * Generic paging structure used by the official Spotify Web API.
 * @public
 */
export interface SpotifyPagingObject<T> {
  /** Aggregated items for the current page. */
  items: T[]
  /** Total number of items available in the collection. */
  total: number
  /** Number of items per page. */
  limit: number
  /** URL to the next page of results. */
  next: string | null
  /** Offset of the current page. */
  offset: number
  /** URL to the previous page of results. */
  previous: string | null
}

/**
 * Representation of an artist in the official Spotify API.
 * @public
 */
export interface SpotifyArtist {
  /** Spotify ID for the artist. */
  id: string
  /** Display name of the artist. */
  name: string
  /** External URLs associated with the artist. */
  external_urls: { spotify: string }
  /** Visual assets for the artist. */
  images?: Array<{ url: string }>
}

/**
 * Representation of a track in the official Spotify API.
 * @public
 */
export interface SpotifyTrack {
  /** Spotify ID for the track. */
  id: string
  /** Title of the track. */
  name: string
  /** List of contributing artists. */
  artists: SpotifyArtist[]
  /** Duration of the track in milliseconds. */
  duration_ms: number
  /** Whether the track contains explicit content. */
  explicit: boolean
  /** External URLs for the track. */
  external_urls: { spotify: string }
  /** External identifiers like ISRC. */
  external_ids?: { isrc?: string }
  /** Parent album metadata. */
  album?: {
    images: Array<{ url: string }>
    name: string
  }
  /** Internal URI for local files or specific resolution. */
  uri?: string
}

/**
 * Representation of an album in the official Spotify API.
 * @public
 */
export interface SpotifyAlbum {
  /** Spotify ID for the album. */
  id: string
  /** Name of the album. */
  name: string
  /** List of album artists. */
  artists: SpotifyArtist[]
  /** Cover art images. */
  images: Array<{ url: string }>
  /** External URLs for the album. */
  external_urls: { spotify: string }
  /** Paginated list of tracks in the album. */
  tracks: SpotifyPagingObject<SpotifyTrack>
}

/**
 * Representation of an item in a Spotify playlist (official API).
 * @public
 */
export interface SpotifyPlaylistItem {
  /** The track metadata. */
  track?: SpotifyTrack
  /** The item metadata (renamed field in recent API). */
  item?: SpotifyTrack
  /** Whether the item is a local file. */
  is_local?: boolean
}

/**
 * Representation of a playlist in the official Spotify API.
 * @public
 */
export interface SpotifyPlaylist {
  /** Spotify ID for the playlist. */
  id: string
  /** Name of the playlist. */
  name: string
  /** Owner information. */
  owner: { display_name?: string }
  /** Playlist cover images. */
  images: Array<{ url: string }>
  /** External URLs for the playlist. */
  external_urls: { spotify: string }
  /** Paginated list of items in the playlist (API changed from tracks to items). */
  items?: SpotifyPagingObject<SpotifyPlaylistItem>
  /** Legacy tracks field. */
  tracks?: SpotifyPagingObject<SpotifyPlaylistItem>
}

/**
 * Response from the internal Spotify Canvas API.
 * @public
 */
export interface SpotifyCanvasResponse {
  data?: {
    /** List of canvases available for the requested track. */
    canvasesList?: Array<{
      /** Internal URI for the canvas asset. */
      canvasUri: string
      /** Whether the canvas is marked as explicit. */
      explicit: boolean
    }>
  }
}

/**
 * Internal track node structure used by the Spotify Pathfinder (GraphQL) API.
 * @public
 */
export interface SpotifyGraphQLTrack {
  /** Internal Spotify URI. */
  uri: string
  /** Name of the track. */
  name: string
  /** Whether the track is explicit. */
  explicit?: boolean
  /** Content rating information. */
  contentRating?: { label: string }
  /** Duration structure for the track. */
  duration?: { totalMilliseconds: number }
  /** Alternative duration structure. */
  trackDuration?: { totalMilliseconds: number }
  /** Associated artists. */
  artists?: {
    items: Array<{
      profile?: { name: string }
      name?: string
    }>
  }
  /** Primary artist node. */
  firstArtist?: {
    items: Array<{ profile?: { name: string } }>
  }
  /** Secondary artist node. */
  otherArtists?: {
    items: Array<{
      profile?: { name: string }
      name?: string
    }>
  }
  /** Parent album information from track context. */
  albumOfTrack?: {
    coverArt?: {
      sources: Array<{ url: string }>
    }
  }
  /** Standalone album node. */
  album?: {
    images: Array<{ url: string }>
  }
  /** External IDs provided via GraphQL. */
  externalIds?: { isrc?: string }
}

/**
 * Search results response from the Spotify Pathfinder (GraphQL) API.
 * @public
 */
export interface SpotifyGraphQLSearchResponse {
  searchV2?: {
    /** Track results. */
    tracksV2?: {
      items: Array<{
        item: {
          data: SpotifyGraphQLTrack
        }
      }>
    }
    /** Album results. */
    albumsV2?: {
      items: Array<{
        data: {
          uri: string
          name: string
          artists: {
            items: Array<{ profile: { name: string } }>
          }
          coverArt?: {
            sources: Array<{ url: string }>
          }
        }
      }>
    }
    /** Playlist results. */
    playlists?: {
      items: Array<{
        data: {
          uri: string
          name: string
          ownerV2?: { data: { name: string } }
          images?: {
            items: Array<{
              sources: Array<{ url: string }>
            }>
          }
        }
      }>
    }
    /** Artist results. */
    artists?: {
      items: Array<{
        data: {
          uri: string
          profile: { name: string }
          visuals?: {
            avatarImage?: {
              sources: Array<{ url: string }>
            }
          }
        }
      }>
    }
  }
}

/**
 * Album resolution response from the Spotify Pathfinder (GraphQL) API.
 * @public
 */
export interface SpotifyGraphQLAlbumResponse {
  albumUnion?: {
    __typename: string
    name: string
    coverArt?: { sources: Array<{ url: string }> }
    tracksV2: {
      totalCount: number
      items: Array<{
        track: SpotifyGraphQLTrack
      }>
    }
  }
}

/**
 * Playlist resolution response from the Spotify Pathfinder (GraphQL) API.
 * @public
 */
export interface SpotifyGraphQLPlaylistResponse {
  playlistV2?: {
    __typename: string
    name: string
    /** Playlist owner. `data.name` is the owner's display name. */
    ownerV2?: { data?: { name?: string | null } | null } | null
    /** Playlist cover images. Sources are not guaranteed to carry dimensions. */
    images?: {
      items?: Array<{
        sources?: Array<{
          url: string
          width?: number | null
          height?: number | null
        }>
      }>
    } | null
    content: {
      totalCount: number
      items: Array<{
        itemV2?: {
          data: SpotifyGraphQLTrack & { is_local?: boolean }
        }
      }>
    }
  }
}

/**
 * Artist resolution response from the Spotify Pathfinder (GraphQL) API.
 * @public
 */
export interface SpotifyGraphQLArtistResponse {
  artistUnion?: {
    __typename: string
    profile: { name: string }
    discography: {
      topTracks: {
        items: Array<{
          track: SpotifyGraphQLTrack
        }>
      }
    }
  }
}
