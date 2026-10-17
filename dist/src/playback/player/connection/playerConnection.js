import discordVoice from '@performanc/voice';
import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/** Coordinates a player's voice credentials and connection events. @internal */
export class PlayerConnection {
    recovery;
    runtime;
    playback;
    clock;
    connection = null;
    connStatus = 'disconnected';
    lastManualReconnect = 0;
    voice = {
        sessionId: null,
        token: null,
        endpoint: null,
        channelId: null
    };
    pendingWaits = new Set();
    _connStateHandler = (_previous, state) => this._onConn(state);
    _connPlayHandler = (_previous, state) => this.playback._onPlay(state);
    _connErrorHandler = (error) => {
        const recoverable = error.cause === 'DAVE_RECOVERY_STARTED' ||
            error.cause === 'VOICE_RECONNECTING';
        logger(recoverable ? 'warn' : 'error', 'Voice', error.message);
        if (!recoverable && !this.playback.destroying)
            this.playback._onError(error);
    };
    _readyHandler = () => {
        this.playback._resumeRequestedPlayback('reconnected');
    };
    constructor(runtime) {
        this.runtime = runtime;
    }
    _isVoiceReady() {
        return this.connection?.ready ?? false;
    }
    _ensureVoiceConnection() {
        if (!this.playback.destroying && !this._isVoiceReady()) {
            this.updateVoice(this.voice);
        }
    }
    _initConnection() {
        if (this.connection || this.playback.destroying)
            return;
        const connection = discordVoice.joinVoiceChannel({
            guildId: this.runtime.guildId,
            userId: this.runtime.session.userId,
            channelId: this.voice.channelId,
            encryption: this.runtime.nodelink.options.playback.audio?.encryption ?? null
        });
        this.connection = connection;
        connection.stuckTimeout =
            Math.max(this.runtime.nodelink.options.playback.trackStuckThresholdMs ?? 10000, 30000) + 5000;
        connection.on('stateChange', this._connStateHandler);
        connection.on('playerStateChange', this._connPlayHandler);
        connection.on('error', this._connErrorHandler);
        connection.on('ready', this._readyHandler);
        this.runtime.nodelink.voiceRelay?.attach(connection, this.runtime.guildId);
        this.playback.duckingController?.attach(connection);
    }
    _onConn(state) {
        if (this.playback.destroying)
            return;
        const previousStatus = this.connStatus;
        this.connStatus = state.status;
        if (previousStatus !== state.status &&
            (previousStatus === 'connected' || state.status === 'connected')) {
            this.recovery._stuckTime = 0;
            this.recovery._positionAtRecoveryStart = this.clock._realPosition();
            if (state.status === 'connected')
                this.recovery._lastStreamDataTime = Date.now();
        }
        if (state.status === 'connected') {
            this.runtime.emitEvent(GatewayEvents.PLAYER_CONNECTED, {
                guildId: this.runtime.guildId,
                voice: structuredClone(this.voice)
            });
        }
        else if (state.status === 'connecting') {
            if (previousStatus !== 'disconnected' || this.connection?.audioStream) {
                this.runtime.emitEvent(GatewayEvents.PLAYER_RECONNECTING, {
                    guildId: this.runtime.guildId,
                    voice: structuredClone(this.voice)
                });
            }
        }
        else if (state.status === 'disconnected') {
            this.runtime.emitEvent(GatewayEvents.WEBSOCKET_CLOSED, {
                code: state.code,
                reason: state.closeReason ?? state.reason,
                byRemote: true
            });
        }
        this.recovery._sendUpdate();
    }
    updateVoice(payload = {}, force = false) {
        if (this.playback.destroying)
            return;
        for (const key of [
            'sessionId',
            'token',
            'endpoint',
            'channelId'
        ]) {
            if (payload[key] !== undefined)
                this.voice[key] = payload[key];
        }
        const { sessionId, token, endpoint, channelId } = this.voice;
        if (!sessionId || !token || !endpoint || !channelId) {
            logger('debug', 'Voice', `Waiting for complete voice credentials including channelId for guild ${this.runtime.guildId}`);
            return;
        }
        this._initConnection();
        this.connection?.updateVoice({ sessionId, token, endpoint, channelId }, force);
    }
    waitForReady() {
        const connection = this.connection;
        if (!connection)
            return Promise.reject(new Error('No voice connection available'));
        return connection.waitForReady(this.runtime.nodelink.options.playback.eventTimeoutMs ?? 15000);
    }
    waitEvent = (event, filter, timeout = this.runtime.nodelink.options.playback.eventTimeoutMs ?? 15000) => new Promise((resolve, reject) => {
        const connection = this.connection;
        if (!connection) {
            reject(new Error('No connection available for waitEvent'));
            return;
        }
        const cleanup = () => {
            clearTimeout(timer);
            connection.off(event, handler);
            this.pendingWaits.delete(cancel);
        };
        const cancel = (error) => {
            cleanup();
            reject(error);
        };
        const handler = (_previous, payload) => {
            if (!filter || filter(payload)) {
                cleanup();
                resolve(payload);
            }
        };
        const timer = setTimeout(() => cancel(new Error(`Event ${event} timed out after ${timeout}ms for guild ${this.runtime.guildId}`, event === 'playerStateChange'
            ? { cause: 'VOICE_STATE_TIMEOUT' }
            : undefined)), timeout);
        this.pendingWaits.add(cancel);
        connection.on(event, handler);
    });
    destroy() {
        for (const cancel of this.pendingWaits)
            cancel(new Error('Player destroyed'));
        const connection = this.connection;
        if (!connection)
            return;
        connection.off('stateChange', this._connStateHandler);
        connection.off('playerStateChange', this._connPlayHandler);
        connection.off('ready', this._readyHandler);
        this.runtime.nodelink.voiceRelay?.detach(connection);
        this.playback.duckingController?.detach();
        connection.destroy();
        connection.off('error', this._connErrorHandler);
        this.connection = null;
        this.connStatus = 'destroyed';
    }
}
