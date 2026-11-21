/**
 * Type definitions for Naver Chzzk (치지직) streaming source.
 *
 * @packageDocumentation
 * @module ChzzkTypes
 */

/**
 * Standard Chzzk API envelope.
 * @public
 */
export interface ChzzkApiResponse<T> {
  code: number
  message: string | null
  content: T | null
}

/**
 * Channel information associated with a live stream, VOD, or clip.
 * @public
 */
export interface ChzzkLiveChannel {
  channelId: string
  channelName: string
  channelImageUrl?: string
  verifiedMark?: boolean
  verifiedMarkType?: string
  officialChannel?: boolean
}

/**
 * Encoding track within a media entry.
 * @public
 */
export interface ChzzkEncodingTrack {
  encodingTrackId: string
  path?: string
  videoProfile?: string
  audioProfile?: string
  videoCodec?: string
  audioCodec?: string
  videoBitRate?: number
  audioBitRate?: number
  audioOnly?: boolean
  audioSamplingRate?: number
  audioChannel?: number
}

/**
 * Media playback stream definition in livePlaybackJson.
 * @public
 */
export interface ChzzkMediaEntry {
  mediaId: string
  protocol: string
  path: string
  latency?: string
  encodingTrack?: ChzzkEncodingTrack[]
}

/**
 * Parsed payload from livePlaybackJson.
 * @public
 */
export interface ChzzkLivePlaybackJson {
  meta?: {
    videoId?: string
    streamSeq?: number
    liveId?: string
    paidLive?: boolean
  }
  media?: ChzzkMediaEntry[]
  thumbnail?: {
    snapshotThumbnailTemplate?: string
    types?: string[]
  }
}

/**
 * Live detail response content for a Chzzk channel.
 * @public
 */
export interface ChzzkLiveDetail {
  liveId: number | string
  liveTitle: string
  status: 'OPEN' | 'CLOSE' | string
  liveImageUrl?: string
  defaultThumbnailImageUrl?: string
  concurrentUserCount?: number
  accumulateCount?: number
  openDate?: string
  closeDate?: string
  adult?: boolean
  livePlaybackJson?: string | ChzzkLivePlaybackJson
  channel?: ChzzkLiveChannel
}

/**
 * Video (VOD) detail response content.
 * @public
 */
export interface ChzzkVideoDetail {
  videoNo: number
  videoId: string
  videoTitle: string
  videoType?: string
  publishDate?: string
  thumbnailImageUrl?: string
  duration?: number
  readCount?: number
  inKey?: string
  vodStatus?: string
  liveRewindPlaybackJson?: string | ChzzkLivePlaybackJson | null
  channel?: ChzzkLiveChannel
}

/**
 * Clip detail response content.
 * @public
 */
export interface ChzzkClipDetail {
  clipUID: string
  videoId?: string
  clipTitle: string
  thumbnailImageUrl?: string
  duration?: number
  adult?: boolean
  channelName?: string
  ownerChannel?: ChzzkLiveChannel
}

/**
 * Clip playback info content.
 * @public
 */
export interface ChzzkClipPlayInfo {
  contentType?: string
  contentId?: string
  videoId?: string
  inKey?: string
  vodStatus?: string
  contentTitle?: string
  ownerChannel?: ChzzkLiveChannel
}

/**
 * Search live result item.
 * @public
 */
export interface ChzzkSearchLiveItem {
  live?: {
    liveTitle?: string
    liveImageUrl?: string
    defaultThumbnailImageUrl?: string
    concurrentUserCount?: number
    openDate?: string
    adult?: boolean
  }
  channel?: ChzzkLiveChannel
}

/**
 * Search video result item.
 * @public
 */
export interface ChzzkSearchVideoItem {
  video?: {
    videoNo?: number
    videoId?: string
    videoTitle?: string
    thumbnailImageUrl?: string
    duration?: number
    readCount?: number
    publishDateAt?: number
  }
  channel?: ChzzkLiveChannel
}

/**
 * Channel detail response content.
 * @public
 */
export interface ChzzkChannelDetail {
  channelId: string
  channelName: string
  channelImageUrl?: string
  verifiedMark?: boolean
  channelDescription?: string
  followerCount?: number
  openLive?: boolean
}
