import { SeekError } from '@ecliptia/seekable-stream';
import { EndReasons, GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/**
 * Interprets voice state changes and errors for the player.
 * Lifecycle actions return to Player through synchronous callbacks.
 * @internal
 */
export class PlayerConnectionEvents {
    player;
    nodelink;
    session;
    dependencies;
    constructor(player, nodelink, session, dependencies) {
        this.player = player;
        this.nodelink = nodelink;
        this.session = session;
        this.dependencies = dependencies;
    }
    /**
     * Handles connection state transitions.
     */
    onConnectionState(state) {
        if (this.player.destroying)
            return;
        const previousStatus = this.player.connStatus;
        this.player.connStatus = state.status;
        const crossedConnectedBoundary = previousStatus !== state.status &&
            (previousStatus === 'connected' || state.status === 'connected');
        if (crossedConnectedBoundary) {
            this.dependencies.monitor._onConnectionBoundary();
            if (state.status === 'connected') {
                this.player._lastStreamDataTime = Date.now();
            }
        }
        if (state.status === 'connected') {
            logger('info', 'Player', `Voice connection established for guild ${this.player.guildId} in session ${this.session.id}`);
            this.player.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
                guildId: this.player.guildId,
                voice: structuredClone(this.player.voice)
            });
            if (this.player.track &&
                this.player.isPaused &&
                this.player.connection?.audioStream) {
                this.player.isPaused = false;
                this.player.connection.unpause?.('reconnected');
                logger('debug', 'Player', `Unpaused track on reconnection for guild ${this.player.guildId}`);
            }
        }
        else if (state.status === 'connecting') {
            if (previousStatus !== 'disconnected' ||
                this.player.connection?.audioStream) {
                logger('info', 'Player', `Voice connection is reconnecting for guild ${this.player.guildId}`);
                this.player.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                    guildId: this.player.guildId,
                    voice: structuredClone(this.player.voice)
                });
            }
        }
        else if (state.status === 'disconnected') {
            const reason = state.reason;
            if (reason === 'reconnect_circuit_breaker') {
                logger('error', 'Player', `Voice connection circuit breaker triggered for guild ${this.player.guildId}. Too many reconnection attempts.`);
                this.player.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                    track: this.player.track,
                    exception: {
                        message: 'Voice reconnection circuit breaker triggered',
                        severity: 'suspicious', // setting this to fault will make the client recive this as a trackError.
                        cause: 'RECONNECT_CIRCUIT_BREAKER'
                    }
                });
                this.dependencies.voiceConnection._resetVoiceConnection();
            }
            this.player.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: state.code,
                reason: state.closeReason ?? state.reason,
                byRemote: true
            });
        }
        else if (state.status === 'destroyed') {
            logger('warn', 'Player', `Voice connection destroyed for guild ${this.player.guildId}`);
        }
        this.player._sendUpdate();
        if (crossedConnectedBoundary)
            this.dependencies.monitor._resetStuckTime();
    }
    /**
     * Handles player state changes emitted by the voice connection.
     */
    onPlaybackState(state) {
        if (this.player.destroying)
            return;
        logger('debug', 'Player', `Player state change for guild ${this.player.guildId} in session ${this.session.id}: ${state.status} (reason: ${state.reason})`);
        const endReason = state.reason;
        const endingReasons = [
            EndReasons.STOPPED,
            EndReasons.FINISHED,
            EndReasons.LOAD_FAILED
        ];
        if (state.status === 'idle' &&
            endReason === EndReasons.STOPPED &&
            this.dependencies.playback._shouldIgnoreStoppedState()) {
            logger('debug', 'Player', `Ignoring internal idle/stopped during stream swap for guild ${this.player.guildId}`);
            return;
        }
        if (state.status === 'idle' && state.reason === 'stuck') {
            logger('warn', 'Player', `Track became stuck for guild ${this.player.guildId}. Triggering immediate recovery.`);
            this.dependencies.monitor._markStuck();
            this.player._sendUpdate();
            return;
        }
        if (state.status === 'idle' && this.player.isUpdatingTrack) {
            if (endReason === EndReasons.STOPPED) {
                logger('debug', 'Player', `Processing stop completion during track update for guild ${this.player.guildId}`);
            }
            else {
                logger('debug', 'Player', `Ignoring idle event during track replacement for guild ${this.player.guildId}. Reason: ${state.reason}`);
                return;
            }
        }
        if (state.status === 'idle' &&
            this.player.track &&
            endReason &&
            endingReasons.includes(endReason)) {
            if (state.reason === EndReasons.FINISHED &&
                this.dependencies.queue._playGaplessTrack())
                return;
            if ((this.player.isUpdatingTrack || this.dependencies.seeking.isSeeking) &&
                state.reason === 'finished') {
                logger('debug', 'Player', `Ignoring spurious idle/finished event during track replacement/seek for guild ${this.player.guildId}.`);
                return;
            }
            logger('debug', 'Player', `Track ended for guild ${this.player.guildId}. Reason: ${state.reason}. Current position: ${this.dependencies.clock._realPosition()}`);
            this.dependencies.finishTrack(endReason);
        }
        else if (state.status === 'playing' &&
            this.player.track &&
            !this.dependencies.seeking.isSeeking &&
            (['requested', 'reconnected', 'unpaused'].includes(state.reason ?? '') ||
                this.dependencies.fadingEffects.hasPendingTrackStartFade)) {
            this.dependencies.trackPlaying();
        }
        else if (state.status === 'idle' &&
            (state.reason === 'paused' || state.reason === 'requested')) {
            this.player.isPaused = true;
        }
        else if (state.status === 'idle' && state.reason === 'reconnecting') {
            logger('info', 'Player', `Voice library reports reconnecting for guild ${this.player.guildId}`);
            this.player.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                guildId: this.player.guildId,
                voice: structuredClone(this.player.voice)
            });
        }
    }
    /**
     * Handles playback errors and emits exception events.
     */
    onError(error) {
        if (this.player.destroying)
            return;
        if (this.player.track) {
            let severity = 'fault';
            let cause = 'UNKNOWN_ERROR';
            let shouldStop = true;
            logger('debug', 'Player', `Handling player error for guild ${this.player.guildId}: ${error.message}`);
            if (error.message.includes('ECONNRESET')) {
                const now = Date.now();
                const reconnectCooldown = 5000;
                if (now - (this.player.lastManualReconnect || 0) < reconnectCooldown) {
                    logger('warn', 'Player', `Voice connection reset for guild ${this.player.guildId}. Manual reconnect on cooldown. Relying on library.`);
                }
                else {
                    this.player.lastManualReconnect = now;
                    logger('warn', 'Player', `Voice connection reset for guild ${this.player.guildId}. Attempting to manually reconnect.`);
                    this.player.updateVoice(this.player.voice, true);
                }
                severity = 'suspicious';
                cause = 'VOICE_CONNECTION_RESET';
                shouldStop = false;
            }
            else if (error.cause === 'VOICE_CONNECTION_TIMEOUT' ||
                error.message === 'Voice connection timed out') {
                logger('warn', 'Player', `Voice connection timed out for guild ${this.player.guildId}. Stopping this playback attempt.`);
                severity = 'suspicious';
                cause = 'VOICE_CONNECTION_TIMEOUT';
            }
            else if (error.cause === 'VOICE_STATE_TIMEOUT') {
                logger('warn', 'Player', `Voice playback state timed out for guild ${this.player.guildId}. Stopping this playback attempt.`);
                severity = 'suspicious';
                cause = 'VOICE_STATE_TIMEOUT';
            }
            else if (error.message.includes('Voice WS closed with reconnect code')) {
                logger('warn', 'Player', `Voice websocket closed during reconnect burst for guild ${this.player.guildId}. Preserving track for resume.`);
                severity = 'suspicious';
                cause = 'VOICE_WS_RECONNECT_FAILED';
                shouldStop = false;
                this.dependencies.playback._rememberReconnectPosition(this.dependencies.clock._realPosition());
            }
            else if (error.message.includes('stream') ||
                error.message.includes('timeout') ||
                error.message.includes('timed out') ||
                error.name === 'AbortError') {
                logger('warn', 'Player', `Stream error detected for guild ${this.player.guildId}. Stopping playback.`);
                severity = 'common';
                cause = 'STREAM_ERROR';
                shouldStop = true;
            }
            else if (error instanceof SeekError) {
                logger('error', 'Player', `Seek error for guild ${this.player.guildId}: ${error.message}. Stopping playback.`);
                severity = 'fault';
                cause = 'SEEK_ERROR';
                shouldStop = true;
            }
            else {
                logger('error', 'Player', `Unhandled player error for guild ${this.player.guildId}:`, error);
                severity = 'fault';
                cause = `${error.name || 'Error'}: ${error.message}`;
                shouldStop = true;
            }
            this.player.emitEvent(GatewayEvents.TRACK_EXCEPTION, {
                track: this.player.track,
                exception: {
                    message: error.message,
                    severity: severity,
                    cause: cause
                }
            });
            this.nodelink.pluginManager?.callHook('onTrackException', this.player.guildId, this.player.track, { message: error.message, severity, cause });
            if (shouldStop) {
                this.dependencies.events.emitTrackEnd(EndReasons.LOAD_FAILED);
                this.player.stop();
            }
        }
    }
}
