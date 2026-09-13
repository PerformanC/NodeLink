/**
 * SABR Stream Type Definitions
 *
 * Shared types for SABR (Server-side Adaptive Bitrate) streaming.
 * These types cover stream configuration, UMP part handling,
 * media segment tracking, and traffic logging.
 *
 * Re-exports codec types from {@link ./protor.ts} for centralized access.
 *
 * @packageDocumentation
 * @module SabrTypes
 */
export { base64ToU8, concatenateChunks, FormatId, FormatInitializationMetadata, MediaHeader, NextRequestPolicy, PlaybackStartPolicy, ProtoReader, ProtoWriter, ReloadPlaybackContext, RequestCancellationPolicy, RequestIdentifier, SabrContextSendingPolicy, SabrContextUpdate, SabrError, SabrRedirect, StreamProtectionStatus, UMPPartId, UMPWriter, VideoPlaybackAbrRequest } from '../../sources/youtube/sabr/protor.js';
