import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
export class PlayerSponsorBlock {
    seeking;
    runtime;
    constructor(runtime) {
        this.runtime = runtime;
        this.sponsorBlock = {
            enabled: this.runtime.nodelink.options.playback.sponsorblock?.enabled ?? false,
            categories: this.runtime.nodelink.options.playback.sponsorblock
                ?.categories ?? [
                'sponsor',
                'selfpromo',
                'interaction',
                'intro',
                'outro',
                'preview',
                'music_offtopic',
                'filler'
            ],
            actionTypes: this.runtime.nodelink.options.playback.sponsorblock
                ?.actionTypes ?? ['skip'],
            segments: [],
            lastSkippedUuid: null,
            skipMarginMs: this.runtime.nodelink.options.playback.sponsorblock?.skipMarginMs ?? 150
        };
    }
    sponsorBlock;
    getSponsorBlock() {
        logger('debug', 'Player', `[Action: getSponsorBlock] Method invoked for guild ${this.runtime.guildId}`);
        return this.sponsorBlock;
    }
    updateSponsorBlock(updates) {
        logger('debug', 'Player', `[Action: updateSponsorBlock] Method invoked for guild ${this.runtime.guildId}`);
        if (updates.enabled !== undefined)
            this.sponsorBlock.enabled = updates.enabled;
        if (updates.categories !== undefined)
            this.sponsorBlock.categories = updates.categories;
        if (updates.actionTypes !== undefined)
            this.sponsorBlock.actionTypes = updates.actionTypes;
        if (updates.skipMarginMs !== undefined)
            this.sponsorBlock.skipMarginMs = updates.skipMarginMs;
    }
    setSponsorBlockSegments(segments) {
        logger('debug', 'Player', `[Action: setSponsorBlockSegments] Method invoked for guild ${this.runtime.guildId}`);
        this.sponsorBlock.segments = segments;
        this.sponsorBlock.lastSkippedUuid = null;
    }
    clearSponsorBlock() {
        logger('debug', 'Player', `[Action: clearSponsorBlock] Method invoked for guild ${this.runtime.guildId}`);
        this.sponsorBlock.segments = [];
        this.sponsorBlock.lastSkippedUuid = null;
    }
    skipAt(position, track) {
        const segment = this.sponsorBlock.segments.find((s) => this.sponsorBlock.categories.includes(s.category) &&
            this.sponsorBlock.actionTypes.includes(s.actionType) &&
            position + this.sponsorBlock.skipMarginMs >= s.start &&
            position < s.end &&
            this.sponsorBlock.lastSkippedUuid !== s.uuid);
        if (segment) {
            this.sponsorBlock.lastSkippedUuid = segment.uuid;
            const skippedMs = segment.end - position;
            logger('info', 'Player', `[SponsorBlock][${this.runtime.guildId}] Skipping segment: uuid=${segment.uuid} category=${segment.category} start=${segment.start}ms end=${segment.end}ms (Skipped: ${skippedMs}ms) for video ${track.info.identifier}`);
            this.seeking
                .seek(segment.end)
                .then((success) => {
                if (success) {
                    logger('debug', 'Player', `[SponsorBlock][${this.runtime.guildId}] Successfully jumped to ${segment.end}ms`);
                    this.runtime.emitEvent(GatewayEvents.SPONSORBLOCK_SEGMENT_SKIPPED, {
                        track: track,
                        segment
                    });
                }
                else {
                    logger('warn', 'Player', `[SponsorBlock][${this.runtime.guildId}] Failed to jump to ${segment.end}ms for segment ${segment.uuid}`);
                    // fallback: temporarily mute or un-stick if it fails
                    this.sponsorBlock.lastSkippedUuid = null;
                }
            })
                .catch((error) => {
                logger('error', 'Player', `[SponsorBlock][${this.runtime.guildId}] Error while seeking to segment end:`, error);
                this.sponsorBlock.lastSkippedUuid = null;
            });
            return true;
        }
        return false;
    }
}
