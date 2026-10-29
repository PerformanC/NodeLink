import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/** Owns playback updates and source-stall recovery. @internal */
export class PlayerRecovery {
    runtime;
    clock;
    connectionController;
    transitionController;
    resourceLoader;
    sponsorBlockController;
    lyricsController;
    playback;
    seeking;
    constructor(runtime) {
        this.runtime = runtime;
    }
    _lastPosition = 0;
    _stuckTime = 0;
    _lastStreamDataTime = 0;
    _isRecovering = false;
    stuckRecoveryCount = 0;
    _positionAtRecoveryStart = 0;
    static MAX_STUCK_RECOVERY_ATTEMPTS = 3;
    _sendUpdate() {
        if (!this.connectionController.connection ||
            (this.playback.isPaused &&
                !this.transitionController._fadeTimers.pause) ||
            this.connectionController.connStatus === 'destroyed' ||
            this.playback.destroying)
            return false;
        const position = this.clock._realPosition();
        if (this.sponsorBlockController.sponsorBlock.enabled &&
            this.playback.track) {
            // Periodic log to verify position and sb state
            if (Math.abs(position - this._lastPosition) > 1000 ||
                this._lastPosition === 0) {
                logger('debug', 'Player', `[SponsorBlock][${this.runtime.guildId}] Current position: ${Math.round(position)}ms, Segments: ${this.sponsorBlockController.sponsorBlock.segments.length}, LastSkipped: ${this.sponsorBlockController.sponsorBlock.lastSkippedUuid}`);
            }
        }
        const threshold = this.runtime.nodelink.options.playback.trackStuckThresholdMs ?? 0;
        if (threshold > 0 &&
            !this.playback.isUpdatingTrack &&
            !this.playback._isStopping &&
            this.playback.track &&
            !this.playback._isResuming &&
            !this.playback.isPaused &&
            this.connectionController._isVoiceReady()) {
            if (this._lastPosition === position) {
                this._stuckTime +=
                    this.runtime.nodelink.options.playback.playerUpdateInterval ?? 0;
                if (this._stuckTime >= threshold && !this._isRecovering) {
                    const stuckTime = this._stuckTime;
                    this._stuckTime = 0;
                    const pipelineStream = this.resourceLoader._getAudioStream();
                    if (pipelineStream?.isPipelineFinished()) {
                        logger('debug', 'Player', `Player for guild ${this.runtime.guildId} is starving but the network stream has finished. Treating as natural trackEnd.`);
                        this.connectionController.connection.stop(EndReasons.FINISHED);
                        return false;
                    }
                    if (this.playback.streamInfo?.format === 'mp4') {
                        logger('error', 'Player', `Player for guild ${this.runtime.guildId} is stuck on an MP4 track. Emitting TRACK_STUCK without recovery.`);
                        this.runtime.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.runtime.guildId,
                            track: this.playback.track,
                            thresholdMs: threshold,
                            reason: 'Playback of MP4 track is stuck'
                        });
                        this.runtime.nodelink.pluginManager?.callHook('onTrackStuck', this.runtime.guildId, this.playback.track, threshold, 'Playback of MP4 track is stuck');
                        this.playback.stop();
                        return false;
                    }
                    if (!this.playback.track.info.isSeekable) {
                        if (this.resourceLoader.profilerStreamStats.lastChunkAt &&
                            Date.now() - this.resourceLoader.profilerStreamStats.lastChunkAt <
                                threshold) {
                            this._stuckTime = 0;
                            return true;
                        }
                        logger('warn', 'Player', `Player for guild ${this.runtime.guildId} is stuck on a non-seekable track. Stopping track.`);
                        this.runtime.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.runtime.guildId,
                            track: this.playback.track,
                            thresholdMs: threshold,
                            reason: 'Track is not seekable'
                        });
                        this.playback.stop();
                        return false;
                    }
                    // reason for this special check:
                    // monochrome does not send 200ms of the final segment (or tidal, idk) so the player thinks its gonna be a recovery
                    // this fixes it by treating as a natural "trackEnd"
                    // for example: an audio is 200000ms long, it will only play until 199800ms before triggering a recovery
                    const trackLength = this.playback.track.info.length;
                    const audioStream = this.resourceLoader._getAudioStream();
                    const playbackSpeed = audioStream?.getEffectiveRate() ?? this.clock._getTimescaleSpeed();
                    const endThreshold = playbackSpeed < 1.0 ? 5000 : 2000;
                    if (trackLength > 0 && position >= trackLength - endThreshold) {
                        logger('debug', 'Player', `Player for guild ${this.runtime.guildId} is near track end (${position}/${trackLength}ms). Treating as natural finish instead of stuck.`);
                        this.connectionController.connection.stop(EndReasons.FINISHED);
                        return false;
                    }
                    if (this.stuckRecoveryCount >=
                        PlayerRecovery.MAX_STUCK_RECOVERY_ATTEMPTS) {
                        logger('error', 'Player', `Player for guild ${this.runtime.guildId} exceeded max recovery attempts (${PlayerRecovery.MAX_STUCK_RECOVERY_ATTEMPTS}). Stopping track.`);
                        this.runtime.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.runtime.guildId,
                            track: this.playback.track,
                            thresholdMs: threshold,
                            reason: 'Max recovery attempts exceeded'
                        });
                        this.playback.stop();
                        return false;
                    }
                    logger('warn', 'Player', `Player for guild ${this.runtime.guildId} is stuck. Attempting to recover... (attempt ${this.stuckRecoveryCount + 1}/${PlayerRecovery.MAX_STUCK_RECOVERY_ATTEMPTS})`, {
                        lastPosition: this._lastPosition,
                        currentPosition: position,
                        stuckTime: stuckTime,
                        threshold: threshold,
                        connStatus: this.connectionController.connStatus,
                        lastStreamDataTime: this._lastStreamDataTime > 0
                            ? new Date(this._lastStreamDataTime).toISOString()
                            : 'never',
                        statistics: this.connectionController.connection?.statistics
                    });
                    this._isRecovering = true;
                    this.stuckRecoveryCount++;
                    this._positionAtRecoveryStart = position;
                    if (this.playback.track.info.identifier &&
                        this.playback.track.info.sourceName) {
                        this.runtime.nodelink.trackCacheManager?.delete(this.playback.track.info.sourceName, this.playback.track.info.identifier);
                    }
                    const isStream = this.playback.track.info.isStream;
                    const recoveryPosition = isStream ? 0 : this._lastPosition;
                    this.seeking
                        .seek(recoveryPosition, this.playback.track.endTime, true)
                        .then((success) => {
                        if (success) {
                            logger('info', 'Player', `Player for guild ${this.runtime.guildId} recovered successfully.`);
                        }
                        else {
                            logger('error', 'Player', `Player for guild ${this.runtime.guildId} recovery failed. Stopping track.`);
                            this.runtime.emitEvent(GatewayEvents.TRACK_STUCK, {
                                guildId: this.runtime.guildId,
                                track: this.playback.track,
                                thresholdMs: threshold,
                                reason: 'Recovery attempt failed'
                            });
                            this.playback.stop();
                        }
                        this._isRecovering = false;
                    })
                        .catch((error) => {
                        logger('error', 'Player', `Player for guild ${this.runtime.guildId} recovery attempt threw an error: ${error.message}. Stopping track.`);
                        this.runtime.emitEvent(GatewayEvents.TRACK_STUCK, {
                            guildId: this.runtime.guildId,
                            track: this.playback.track,
                            thresholdMs: threshold,
                            reason: `Recovery attempt failed: ${error.message}`
                        });
                        this.playback.stop();
                        this._isRecovering = false;
                    });
                }
            }
            else {
                this._stuckTime = 0;
                this._isRecovering = false;
            }
        }
        if (position !== this._lastPosition) {
            this._lastStreamDataTime = Date.now();
            if (this.stuckRecoveryCount > 0) {
                const meaningfulAdvance = 2000;
                if (position - this._positionAtRecoveryStart >= meaningfulAdvance) {
                    this.stuckRecoveryCount = 0;
                }
            }
        }
        this._lastPosition = position;
        this.lyricsController._syncLyrics();
        if (this.sponsorBlockController.sponsorBlock.enabled &&
            !this.playback.isPaused &&
            this.playback.track &&
            !this.playback._isResuming &&
            !this._isRecovering &&
            !this.seeking._isSeeking &&
            this.sponsorBlockController.skipAt(position, this.playback.track))
            return true;
        if (this.seeking._isSeeking)
            return true;
        this.runtime.session.socket.send(JSON.stringify({
            op: GatewayEvents.PLAYER_UPDATE,
            guildId: this.runtime.guildId,
            state: {
                time: Date.now(),
                position,
                connected: this.connectionController.connStatus === 'connected',
                ping: this.connectionController.connection &&
                    this.connectionController.connection.ping >= 0
                    ? this.connectionController.connection.ping
                    : 0
            }
        }));
        return true;
    }
}
