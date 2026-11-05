import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/**
 * Loads SponsorBlock segments and skips matching sections.
 * @internal
 */
export class PlayerSponsorBlock {
    player;
    nodelink;
    constructor(player, nodelink) {
        this.nodelink = nodelink;
        this.player = player;
    }
    createState() {
        return {
            enabled: this.nodelink.options.playback.sponsorblock?.enabled ?? false,
            categories: this.nodelink.options.playback.sponsorblock?.categories ?? [
                'sponsor',
                'selfpromo',
                'interaction',
                'intro',
                'outro',
                'preview',
                'music_offtopic',
                'filler'
            ],
            actionTypes: this.nodelink.options.playback.sponsorblock?.actionTypes ?? [
                'skip'
            ],
            segments: [],
            lastSkippedUuid: null,
            skipMarginMs: this.nodelink.options.playback.sponsorblock?.skipMarginMs ?? 150
        };
    }
    prepareSegments(track) {
        if (track.info.sourceName === 'youtube' ||
            track.info.sourceName === 'ytmusic') {
            this.player.sponsorBlock.segments = [];
            this.player.sponsorBlock.lastSkippedUuid = null;
            const videoId = track.info.identifier;
            const sbConfig = this.nodelink.options.playback.sponsorblock;
            if (this.player.sponsorBlock.enabled) {
                logger('debug', 'Player', `[SponsorBlock][${this.player.guildId}] Initiating segment fetch for video ${videoId}`);
                return { videoId, config: sbConfig };
            }
            else {
                logger('debug', 'Player', `[SponsorBlock][${this.player.guildId}] Auto-skip disabled, skipping segment fetch for ${videoId}`);
            }
        }
        return null;
    }
    loadSegments(request, fetchSegments) {
        const { videoId, config: sbConfig } = request;
        fetchSegments(videoId, this.player.sponsorBlock.categories, this.player.sponsorBlock.actionTypes, sbConfig?.api)
            .then((segments) => {
            if (this.player.destroying ||
                !this.player.track ||
                this.player.track.info.identifier !== videoId) {
                logger('debug', 'Player', `[SponsorBlock][${this.player.guildId}] Ignoring fetched segments for ${videoId} (track changed or player destroyed)`);
                return;
            }
            this.player.sponsorBlock.segments = segments;
            logger('info', 'Player', `[SponsorBlock][${this.player.guildId}] Applied ${segments.length} segments for video ${videoId}`);
            if (segments.length > 0) {
                this.player.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENTS_LOADED, {
                    segments
                });
                // Immediate check after load
                this.player._sendUpdate();
            }
        })
            .catch((err) => {
            logger('error', 'Player', `[SponsorBlock][${this.player.guildId}] Error fetching segments for ${videoId}:`, err);
        });
    }
    logPosition(position, lastPosition) {
        if (this.player.sponsorBlock.enabled && this.player.track) {
            // Periodic log to verify position and sb state
            if (Math.abs(position - lastPosition) > 1000 || lastPosition === 0) {
                logger('debug', 'Player', `[SponsorBlock][${this.player.guildId}] Current position: ${Math.round(position)}ms, Segments: ${this.player.sponsorBlock.segments.length}, LastSkipped: ${this.player.sponsorBlock.lastSkippedUuid}`);
            }
        }
    }
    skipSegment(position, isResuming, isRecovering, isSeeking) {
        if (this.player.sponsorBlock.enabled &&
            !this.player.isPaused &&
            this.player.track &&
            !isResuming &&
            !isRecovering &&
            !isSeeking) {
            const segment = this.player.sponsorBlock.segments.find((s) => this.player.sponsorBlock.categories.includes(s.category) &&
                this.player.sponsorBlock.actionTypes.includes(s.actionType) &&
                position + this.player.sponsorBlock.skipMarginMs >= s.start &&
                position < s.end &&
                this.player.sponsorBlock.lastSkippedUuid !== s.uuid);
            if (segment) {
                this.player.sponsorBlock.lastSkippedUuid = segment.uuid;
                const skippedMs = segment.end - position;
                logger('info', 'Player', `[SponsorBlock][${this.player.guildId}] Skipping segment: uuid=${segment.uuid} category=${segment.category} start=${segment.start}ms end=${segment.end}ms (Skipped: ${skippedMs}ms) for video ${this.player.track.info.identifier}`);
                this.player
                    .seek(segment.end)
                    .then((success) => {
                    if (success) {
                        logger('debug', 'Player', `[SponsorBlock][${this.player.guildId}] Successfully jumped to ${segment.end}ms`);
                        this.player.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENT_SKIPPED, {
                            track: this.player.track,
                            segment
                        });
                    }
                    else {
                        logger('warn', 'Player', `[SponsorBlock][${this.player.guildId}] Failed to jump to ${segment.end}ms for segment ${segment.uuid}`);
                        // fallback: temporarily mute or un-stick if it fails
                        this.player.sponsorBlock.lastSkippedUuid = null;
                    }
                })
                    .catch((err) => {
                    logger('error', 'Player', `[SponsorBlock][${this.player.guildId}] Error while seeking to segment end:`, err);
                    this.player.sponsorBlock.lastSkippedUuid = null;
                });
                return true;
            }
        }
        return false;
    }
    /**
     * Returns current SponsorBlock state for the player.
     *
     * @returns Current segments and configuration.
     */
    getSponsorBlock() {
        logger('debug', 'Player', `[Action: getSponsorBlock] Method invoked for guild ${this.player.guildId}`);
        return this.player.sponsorBlock;
    }
    /**
     * Updates SponsorBlock settings for the player.
     *
     * @param updates - Configuration updates.
     */
    updateSponsorBlock(updates) {
        logger('debug', 'Player', `[Action: updateSponsorBlock] Method invoked for guild ${this.player.guildId}`);
        if (updates.enabled !== undefined)
            this.player.sponsorBlock.enabled = updates.enabled;
        if (updates.categories !== undefined)
            this.player.sponsorBlock.categories = updates.categories;
        if (updates.actionTypes !== undefined)
            this.player.sponsorBlock.actionTypes = updates.actionTypes;
        if (updates.skipMarginMs !== undefined)
            this.player.sponsorBlock.skipMarginMs = updates.skipMarginMs;
    }
    /**
     * Overrides SponsorBlock segments for the current track.
     *
     * @param segments - Array of segments to apply.
     */
    setSponsorBlockSegments(segments) {
        logger('debug', 'Player', `[Action: setSponsorBlockSegments] Method invoked for guild ${this.player.guildId}`);
        this.player.sponsorBlock.segments = segments;
        this.player.sponsorBlock.lastSkippedUuid = null;
    }
    /**
     * Clears SponsorBlock state for the player.
     */
    clearSponsorBlock() {
        logger('debug', 'Player', `[Action: clearSponsorBlock] Method invoked for guild ${this.player.guildId}`);
        this.player.sponsorBlock.segments = [];
        this.player.sponsorBlock.lastSkippedUuid = null;
    }
}
