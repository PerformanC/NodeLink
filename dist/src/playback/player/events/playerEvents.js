import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/**
 * Delivers player events, prepares track payloads, and invokes plugin hooks.
 * @internal
 */
export class PlayerEvents {
    player;
    nodelink;
    session;
    lyrics;
    _resolvedTrack = null;
    constructor(player, nodelink, session, lyrics) {
        this.player = player;
        this.nodelink = nodelink;
        this.session = session;
        this.lyrics = lyrics;
    }
    get resolvedTrack() {
        return this._resolvedTrack;
    }
    clearResolvedTrack() {
        this._resolvedTrack = null;
    }
    /**
     * Sends an event or queues it while the session is paused.
     */
    emit(type, payload = {}) {
        this.nodelink.statsManager.incrementPlaybackEvent(type);
        const eventData = JSON.stringify({
            op: 'event',
            type,
            guildId: this.player.guildId,
            ...payload
        });
        if (this.session.isPaused) {
            this.session.eventQueue.push(eventData);
            logger('debug', 'Player', `Queued event ${type} for paused session ${this.session.id}`);
            return;
        }
        try {
            this.session.socket.send(eventData);
        }
        catch { }
    }
    /**
     * Resolves the event track before start hooks and lyrics loading.
     */
    async emitTrackStart() {
        const trackToEmit = await this._resolveTrackForEvent(this.player.track);
        this._resolvedTrack = trackToEmit;
        const format = this.player.streamInfo?.format;
        const playingQuality = format && typeof format === 'object' && 'itag' in format
            ? (format.itag ?? null)
            : null;
        this.player.emitEvent(GatewayEvents.TRACK_START, {
            track: trackToEmit,
            playingQuality
        });
        this.nodelink.pluginManager?.callHook('onTrackStart', this.player.guildId, trackToEmit);
        if (trackToEmit?.info?.sourceName === 'eternalbox') {
            const info = trackToEmit.info;
            const pluginInfo = (trackToEmit.pluginInfo ?? {});
            const spotify = pluginInfo.spotify;
            const links = {
                jukeboxPage: info.uri,
                analysisUrl: pluginInfo.analysisUrl || null,
                streamUrl: pluginInfo.streamUrl || null,
                ogAudioSource: pluginInfo.ogAudioSource || null,
                spotifyUrl: spotify?.url || info.uri || null
            };
            this.player.emitEvent(GatewayEvents.ETERNALBOX_INFO, {
                track: trackToEmit,
                eternalbox: {
                    id: info.identifier,
                    service: pluginInfo.service || null,
                    analysisSummary: pluginInfo.analysisSummary || null,
                    spotify: pluginInfo.spotify || null,
                    links
                }
            });
        }
        if (this.player.isLyricsSubscribed) {
            await this.lyrics._loadLyrics();
        }
    }
    /**
     * Emits the cached event track before cleaning up mixer layers.
     */
    emitTrackEnd(reason, extra = {}) {
        const trackToEmit = this._resolvedTrack || this.player.track;
        this.player.emitEvent(GatewayEvents.TRACK_END, {
            track: trackToEmit,
            reason: reason,
            ...extra
        });
        this.nodelink.pluginManager?.callHook('onTrackEnd', this.player.guildId, trackToEmit, reason);
        if (this.player.audioMixer?.autoCleanup) {
            this.player.audioMixer.clearLayers('MAIN_ENDED');
        }
    }
    async _resolveTrackForEvent(track) {
        if (!track)
            return null;
        if (!this.nodelink.options.experimental.enableHoloTracks) {
            return track;
        }
        try {
            const source = this.nodelink.sources.getSource(track.info.sourceName);
            const resolveHoloTrack = source?.resolveHoloTrack;
            if (resolveHoloTrack) {
                const holoTrack = await resolveHoloTrack.call(source, track, {
                    fetchChannelInfo: this.nodelink.options.search.fetchChannelInfo,
                    resolveExternalLinks: this.nodelink.options.search.resolveExternalLinks
                });
                return holoTrack || track;
            }
        }
        catch (err) {
            const error = err;
            logger('warn', 'Player', `Failed to resolve Holo track: ${error.message}`);
        }
        return track;
    }
}
