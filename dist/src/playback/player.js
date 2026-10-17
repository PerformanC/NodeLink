import { GatewayEvents } from '../constants.js';
import { logger } from '../utils.js';
import { PlayerConnection } from '../voice/playerConnection.js';
import { PlayerAudio } from './player/audio/controls.js';
import { PlayerMixer } from './player/audio/mixer.js';
import { PlayerTransitions } from './player/audio/transitions.js';
import { PlaybackClock } from './player/base/clock.js';
import { PlayerResources } from './player/base/resources.js';
import { PlayerConnectionEvents } from './player/connection.js';
import { PlayerEvents } from './player/events.js';
import { PlayerLyrics } from './player/features/lyrics.js';
import { PlayerSponsorBlock } from './player/features/sponsorBlock.js';
import { PlayerQueue } from './player/playback/queue.js';
import { PlayerRecovery } from './player/playback/recovery.js';
import { PlayerSeeking } from './player/playback/seeking.js';
import { PlayerPlayback } from './player/playback/tracks.js';
import { DuckingController } from './processing/DuckingController.js';
/**
 * Coordinates player commands, events, and playback features.
 * @public
 */
export class Player {
    clock;
    resources;
    playback;
    queue;
    seeking;
    recovery;
    audio;
    mixer;
    transitions;
    lyrics;
    sponsorBlockFeature;
    voiceConnection;
    connectionEvents;
    events;
    nodelink;
    session;
    guildId;
    track = null;
    _isRestoring = false;
    isPaused = false;
    volumePercent;
    filters = {};
    crossfade;
    position = 0;
    connStatus = 'disconnected';
    connection = null;
    voice = {
        sessionId: null,
        token: null,
        endpoint: null,
        channelId: null
    };
    streamInfo = null;
    sponsorBlock;
    profilerStreamStats = {
        downloadedBytes: 0,
        totalBytes: null,
        lastChunkAt: null
    };
    lastManualReconnect = 0;
    audioMixer = null;
    fading;
    loudnessNormalizer;
    duckingController = null;
    isLyricsSubscribed = false;
    currentLyrics = null;
    lyricsLineIndex = -1;
    skipTrackSource = false;
    emitEvent;
    waitEvent;
    _lastStreamDataTime = 0;
    destroying = false;
    isUpdatingTrack = false;
    stuckRecoveryCount = 0;
    constructor(options) {
        if (!options.nodelink ||
            !options.session?.socket ||
            !options.session.userId ||
            !options.guildId) {
            throw new Error('Missing required options');
        }
        this.nodelink = options.nodelink;
        this.session = options.session;
        this.guildId = options.guildId;
        this.voiceConnection = new PlayerConnection(this, this.session, this.nodelink, {
            onConnectionState: (state) => this.connectionEvents.onConnectionState(state),
            onPlaybackState: (state) => this.connectionEvents.onPlaybackState(state),
            onError: (error) => this.connectionEvents.onError(error),
            cleanupAudioStream: (context) => this.resources._cleanupCurrentAudioStream(context),
            startPendingTrack: () => this.playback._startPendingTrack()
        });
        this.clock = new PlaybackClock(this, this.voiceConnection);
        this.mixer = new PlayerMixer(this, this.nodelink);
        this.lyrics = new PlayerLyrics(this, this.nodelink, this.clock);
        this.events = new PlayerEvents(this, this.nodelink, this.session, this.lyrics);
        this.sponsorBlockFeature = new PlayerSponsorBlock(this, this.nodelink);
        this.transitions = new PlayerTransitions(this, {
            voiceConnection: this.voiceConnection,
            clock: this.clock
        });
        this.resources = new PlayerResources(this, this.nodelink, {
            mixer: this.mixer,
            voiceConnection: this.voiceConnection,
            isCrossfadeEnabled: () => this.queue._getCrossfadeConfig() !== null,
            cleanupCrossfade: (preserveQueuedTrack) => this.queue._destroyCrossfadeResources(preserveQueuedTrack),
            events: this.events
        });
        this.recovery = new PlayerRecovery(this, this.nodelink, this.session, {
            sponsorBlockFeature: this.sponsorBlockFeature,
            transitions: this.transitions,
            clock: this.clock,
            voiceConnection: this.voiceConnection,
            lyrics: this.lyrics,
            isResuming: () => this.playback.isResuming,
            isSeeking: () => this.seeking.isSeeking
        });
        this.queue = new PlayerQueue(this, this.nodelink, {
            voiceConnection: this.voiceConnection,
            clock: this.clock,
            resources: this.resources,
            recovery: this.recovery,
            transitions: this.transitions,
            events: this.events,
            _onError: (error) => this.connectionEvents.onError(error)
        });
        this.playback = new PlayerPlayback(this, this.nodelink, {
            sponsorBlockFeature: this.sponsorBlockFeature,
            voiceConnection: this.voiceConnection,
            transitions: this.transitions,
            resources: this.resources,
            clock: this.clock,
            recovery: this.recovery,
            queue: this.queue,
            _onError: (error) => this.connectionEvents.onError(error),
            events: this.events,
            _resetTrack: () => this._resetTrack()
        });
        this.seeking = new PlayerSeeking(this, this.nodelink, {
            clock: this.clock,
            recovery: this.recovery,
            lyrics: this.lyrics,
            transitions: this.transitions,
            playback: this.playback,
            resources: this.resources,
            mixer: this.mixer,
            voiceConnection: this.voiceConnection,
            queue: this.queue,
            _onError: (error) => this.connectionEvents.onError(error),
            events: this.events
        });
        this.audio = new PlayerAudio(this, this.nodelink, {
            queue: this.queue,
            clock: this.clock,
            transitions: this.transitions
        });
        this.connectionEvents = new PlayerConnectionEvents(this, this.nodelink, this.session, {
            voiceConnection: this.voiceConnection,
            clock: this.clock,
            recovery: this.recovery,
            playback: this.playback,
            seeking: this.seeking,
            queue: this.queue,
            transitions: this.transitions,
            finishTrack: (reason) => this._finishTrack(reason),
            trackPlaying: () => this._trackPlaying(),
            events: this.events
        });
        this.volumePercent = this.nodelink.options?.defaultVolume ?? 100;
        this.fading = this.nodelink.options?.playback.audio?.fading;
        this.crossfade = this.nodelink.options?.playback.audio?.crossfade;
        this.loudnessNormalizer =
            this.nodelink.options?.playback.audio?.loudnessNormalizer ?? false;
        // Initialize ducking controller from config
        const duckingCfg = this.audio._resolveDuckingConfig();
        if (duckingCfg.enabled) {
            this.duckingController = new DuckingController(this.guildId, duckingCfg);
        }
        this.sponsorBlock = this.sponsorBlockFeature.createState();
        logger('debug', 'Player', `New player created for guild ${this.guildId} in session ${this.session.id}`);
        this.emitEvent = (type, payload = {}) => this.events.emit(type, payload);
        this.emitEvent(GatewayEvents.PLAYER_CREATED, {
            guildId: this.guildId,
            player: this.toJSON()
        });
        this.waitEvent = (...args) => this.voiceConnection.waitEvent(...args);
    }
    /**
     * Destroys the player and cleans up the voice connection.
     *
     * @param emitClose - Whether to emit WEBSOCKET_CLOSED to the client.
     */
    destroy(emitClose = true) {
        logger('debug', 'Player', `[Action: destroy] Method invoked for guild ${this.guildId} with emitClose=${emitClose}`);
        if (this.destroying)
            return;
        this.destroying = true;
        this.voiceConnection.destroy();
        if (emitClose) {
            this.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: 1000,
                reason: 'destroyed by client',
                byRemote: false
            });
        }
        this.emitEvent(GatewayEvents.PLAYER_DESTROYED, {
            guildId: this.guildId
        });
        this.mixer._destroyAudioMixer();
        this.resources._abortYouTubeStreams();
        this.resources._releaseResource();
        this._resetTrack();
        this.connStatus = 'destroyed';
        this.volumePercent = this.nodelink.options?.defaultVolume ?? 100;
    }
    /**
     * Serializes player state to JSON-safe object.
     */
    toJSON() {
        logger('debug', 'Player', `[Action: toJSON] Method invoked for guild ${this.guildId}`);
        return {
            guildId: this.guildId,
            track: this.track,
            volume: this.volumePercent,
            fading: this.fading,
            crossfade: this.crossfade,
            loudnessNormalizer: this.loudnessNormalizer,
            paused: this.isPaused,
            filters: this.filters,
            state: {
                time: Date.now(),
                position: this.clock._realPosition(),
                connected: this.connStatus === 'connected',
                ping: this.connection && this.connection.ping >= 0
                    ? this.connection.ping
                    : 0
            },
            voice: structuredClone(this.voice)
        };
    }
    /**
     * Sends player state updates to the client.
     */
    _sendUpdate() {
        return this.recovery._sendUpdate();
    }
    /**
     * Starts playback for the provided track payload.
     *
     * @param payload - Track data plus playback options.
     * @param payload.noReplace - When true, keeps current track if already playing.
     * @param payload.startTime - Initial seek position in milliseconds.
     * @param payload.endTime - Optional end time to truncate playback.
     * @returns True when the request is accepted (actual start is async).
     */
    play(payload) {
        return this.playback.play(payload);
    }
    /**
     * Performs a seek operation to the requested position.
     *
     * @param position - Target position in milliseconds. Uses current position when omitted.
     * @param endTime - Optional end time to enforce after the seek.
     * @returns True when the seek succeeds; false otherwise.
     */
    seek(position, endTime, forceLegacy = false) {
        return this.seeking.seek(position, endTime, forceLegacy);
    }
    /**
     * Stops playback and emits STOPPED if applicable.
     *
     * @returns True when stop was executed; false when no active track.
     */
    stop() {
        return this.playback.stop();
    }
    /**
     * Preloads the next track for gapless playback.
     *
     * @param payload - Track to prepare in advance.
     * @returns True when preload succeeded.
     */
    preload(payload) {
        return this.queue.preload(payload);
    }
    /**
     * Clears any queued/preloaded next track.
     *
     * @returns True when state was cleared.
     */
    clearNextTrack() {
        return this.queue.clearNextTrack();
    }
    /**
     * Pauses or resumes playback.
     *
     * @param shouldPause - True to pause, false to resume.
     * @returns True when state changed; false otherwise.
     */
    pause(shouldPause) {
        return this.playback.pause(shouldPause);
    }
    /**
     * Adjusts playback volume (0-1000).
     *
     * @param level - Volume percentage (0-1000).
     * @returns True when volume was updated.
     */
    volume(level) {
        return this.audio.volume(level);
    }
    /**
     * Sets fading configuration.
     *
     * @param config - New fading config; disables fading when undefined.
     * @returns Always true.
     */
    setFading(config) {
        return this.transitions.setFading(config);
    }
    /**
     * Toggles loudness normalization.
     *
     * @param enabled - Whether to enable loudness normalization.
     * @returns True when updated.
     */
    setLoudnessNormalizer(enabled) {
        return this.audio.setLoudnessNormalizer(enabled);
    }
    /**
     * Toggles auto-ducking (lowers music volume when users speak).
     *
     * @param enabled - Whether to enable auto-ducking.
     * @returns True when updated.
     */
    setDucking(enabled) {
        return this.audio.setDucking(enabled);
    }
    /**
     * Applies audio filters to the active stream.
     *
     * @param filters - Filter payload that replaces the active filter set.
     * @returns True when filters applied; false if player inactive.
     */
    setFilters(filters) {
        return this.audio.setFilters(filters);
    }
    /**
     * Updates the voice state for this player.
     *
     * @param voicePayload - Session/token/endpoint/channel updates.
     * @param force - Forces reconnect even when unchanged.
     */
    updateVoice(voicePayload = {}, force = false) {
        this.voiceConnection.updateVoice(voicePayload, force);
    }
    /**
     * Adds an additional mix layer over the main stream.
     *
     * @param trackPayload - Track to mix in PCM form.
     * @param volume - Optional mix volume (0-1). Defaults to mix config.
     * @throws Error when no active main stream or mixer limits exceeded.
     */
    addMix(trackPayload, volume = null) {
        return this.mixer.addMix(trackPayload, volume);
    }
    /**
     * Removes a mix layer by id.
     *
     * @param mixId - Identifier returned by addMix.
     * @returns True when removed.
     */
    removeMix(mixId) {
        return this.mixer.removeMix(mixId);
    }
    /**
     * Updates the volume of a mix layer.
     *
     * @param mixId - Identifier of the mix layer.
     * @param volume - New volume (0-1).
     * @returns True when updated; false if layer missing.
     */
    updateMix(mixId, volume) {
        return this.mixer.updateMix(mixId, volume);
    }
    /**
     * Lists active mix layers.
     *
     * @returns Current mix layers with track and volume.
     */
    getMixes() {
        return this.mixer.getMixes();
    }
    /**
     * Subscribes to lyrics events for the current track.
     *
     * @param skipTrackSource - When true, skips track source provider before fetching lyrics.
     */
    subscribeLyrics(skipTrackSource) {
        return this.lyrics.subscribeLyrics(skipTrackSource);
    }
    /**
     * Unsubscribes from lyrics events.
     */
    unsubscribeLyrics() {
        return this.lyrics.unsubscribeLyrics();
    }
    /**
     * Returns current SponsorBlock state for the player.
     *
     * @returns Current segments and configuration.
     */
    getSponsorBlock() {
        return this.sponsorBlockFeature.getSponsorBlock();
    }
    /**
     * Updates SponsorBlock settings for the player.
     *
     * @param updates - Configuration updates.
     */
    updateSponsorBlock(updates) {
        this.sponsorBlockFeature.updateSponsorBlock(updates);
    }
    /**
     * Overrides SponsorBlock segments for the current track.
     *
     * @param segments - Array of segments to apply.
     */
    setSponsorBlockSegments(segments) {
        this.sponsorBlockFeature.setSponsorBlockSegments(segments);
    }
    /**
     * Clears SponsorBlock state for the player.
     */
    clearSponsorBlock() {
        this.sponsorBlockFeature.clearSponsorBlock();
    }
    setCrossfade(config) {
        return this.queue.setCrossfade(config);
    }
    _finishTrack(reason) {
        this.resources._traceTrackFinishMemory('before-cleanup');
        this.resources._cleanupCurrentAudioStream('track-end');
        this.events.emitTrackEnd(reason);
        this._resetTrack();
        this.resources._traceTrackFinishMemory('after-reset');
    }
    _trackPlaying() {
        const wasResuming = this.playback._completeResume();
        if (!wasResuming && !this._isRestoring) {
            this.clock._snapshotPacketCount();
            this.transitions._fading('trackStart');
            this.events
                .emitTrackStart()
                .catch((err) => this.connectionEvents.onError(err));
        }
    }
    _resetTrack() {
        this.transitions._resetStopping();
        this.queue._resetQueue();
        this.track = null;
        this.events.clearResolvedTrack();
        this.isPaused = false;
        this.position = 0;
        this.playback._resetResumeState();
        this._lastStreamDataTime = 0;
        this.streamInfo = null;
        this.sponsorBlock.segments = [];
        this.currentLyrics = null;
        this.lyricsLineIndex = -1;
        this.transitions._fading('reset');
        this.mixer._destroyAudioMixer();
        this.clock._resetPacketBaseline(0);
        this.lyrics._clearMarkerTimer();
    }
}
