import { logger } from '../utils.js';
/**
 * Session-scoped manager that controls player lifecycle and player commands.
 *
 * @remarks
 * - In single-process mode, this manager directly calls {@link PlaybackPlayer} methods.
 * - In cluster mode, it forwards commands to the worker responsible for the player.
 * - Player entries are scoped by `{sessionId}:{guildId}` keys to prevent collisions.
 */
export default class PlayerManager {
    nodelink;
    sessionId;
    players;
    isCluster;
    pendingCreates;
    /**
     * Creates a new session-scoped player manager.
     * @param nodelink - NodeLink runtime context.
     * @param sessionId - Owning session id.
     */
    constructor(nodelink, sessionId) {
        this.nodelink = nodelink;
        this.sessionId = sessionId;
        this.players = new Map();
        this.isCluster = nodelink.workerManager !== null;
        this.pendingCreates = new Map();
    }
    /**
     * Builds the internal player key for a guild/session pair.
     * @param guildId - Discord guild id.
     * @internal
     */
    getPlayerKey(guildId) {
        return `${this.sessionId}:${guildId}`;
    }
    /**
     * Resolves the owning session or throws when missing.
     * @internal
     */
    getSessionOrThrow() {
        const session = this.nodelink.sessions.get(this.sessionId);
        if (!session) {
            throw new Error(`Session ${this.sessionId} was not found.`);
        }
        return session;
    }
    /**
     * Resolves a normalized session user id.
     * @param session - Source session.
     * @internal
     */
    getSessionUserId(session) {
        if (Array.isArray(session.userId)) {
            return session.userId[0];
        }
        return session.userId;
    }
    /**
     * Returns the worker manager instance when cluster mode is enabled.
     * @internal
     */
    getWorkerManagerOrThrow() {
        if (!this.nodelink.workerManager) {
            throw new Error('Worker manager is not available in this context.');
        }
        return this.nodelink.workerManager;
    }
    /**
     * Type guard for cluster snapshot entries.
     * @param player - Player map entry.
     * @internal
     */
    isClusterPlayerSnapshot(player) {
        return typeof player.play !== 'function';
    }
    /**
     * Resolves a local playback player or throws when unavailable.
     * @param playerKey - Internal player key.
     * @internal
     */
    getLocalPlayerOrThrow(playerKey) {
        const player = this.players.get(playerKey);
        if (!player || this.isClusterPlayerSnapshot(player)) {
            throw new Error('Player not found locally.');
        }
        return player;
    }
    /**
     * Executes a player command on the assigned worker.
     * @param guildId - Target guild id.
     * @param command - Command name.
     * @param args - Command argument list.
     * @param repairMissing - Recreates a missing worker player and retries once.
     * @internal
     */
    async runClusterPlayerCommand(guildId, command, args, repairMissing = false) {
        const session = this.getSessionOrThrow();
        const playerKey = this.getPlayerKey(guildId);
        const workerManager = this.getWorkerManagerOrThrow();
        const worker = workerManager.getWorkerForGuild(playerKey);
        let missingMessage = 'Player not assigned to a worker.';
        if (worker) {
            const result = await workerManager.execute(worker, 'playerCommand', {
                sessionId: this.sessionId,
                guildId,
                userId: this.getSessionUserId(session),
                command,
                args: [...args]
            });
            if (!result?.playerNotFound) {
                return result;
            }
            missingMessage = 'Player not found.';
        }
        workerManager.unassignGuild(playerKey);
        this.players.delete(playerKey);
        if (!repairMissing) {
            throw new Error(missingMessage);
        }
        logger('warn', 'PlayerManager', `Repairing missing cluster player for guild ${guildId} (session: ${this.sessionId})`);
        await this.create(guildId);
        return this.runClusterPlayerCommand(guildId, command, args);
    }
    /**
     * Executes a mutating player command and repairs missing worker state once.
     * @param guildId - Target guild id.
     * @param command - Command name.
     * @param args - Command argument list.
     * @internal
     */
    runClusterMutation(guildId, command, args) {
        return this.runClusterPlayerCommand(guildId, command, args, true);
    }
    /**
     * Runs configured player interceptors for the given action.
     * @param action - Interceptor action id.
     * @param guildId - Target guild id.
     * @param args - Action arguments.
     * @internal
     */
    async _runInterceptors(action, guildId, ...args) {
        const interceptors = this.nodelink.extensions?.playerInterceptors;
        if (!interceptors || interceptors.length === 0)
            return null;
        for (const interceptor of interceptors) {
            if (typeof interceptor !== 'function')
                continue;
            try {
                const result = await interceptor(action, guildId, args);
                if (result !== null && result !== undefined && result !== false) {
                    return { handled: true, result };
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger('error', 'PlayerManager', `Interceptor error for ${action}: ${errorMessage}`);
            }
        }
        return null;
    }
    /**
     * Creates or returns a player for the provided guild.
     * @param guildId - Target guild id.
     * @param voice - Optional initial voice payload.
     */
    async create(guildId, voice) {
        const session = this.getSessionOrThrow();
        const playerKey = this.getPlayerKey(guildId);
        const existingPlayer = this.players.get(playerKey);
        if (existingPlayer) {
            logger('debug', 'PlayerManager', `Returning existing player for guild ${guildId} (session: ${this.sessionId})`);
            return existingPlayer;
        }
        const pendingCreate = this.pendingCreates.get(playerKey);
        if (pendingCreate) {
            return pendingCreate;
        }
        const createPromise = this._createInternal(session, guildId, voice, playerKey).finally(() => {
            this.pendingCreates.delete(playerKey);
        });
        this.pendingCreates.set(playerKey, createPromise);
        return createPromise;
    }
    /**
     * Internal player creation routine for local and cluster modes.
     * @internal
     */
    async _createInternal(session, guildId, voice, playerKey) {
        if (this.isCluster) {
            const workerManager = this.getWorkerManagerOrThrow();
            const worker = workerManager.getWorkerForGuild(playerKey);
            if (!worker) {
                throw new Error('No workers available to create a player.');
            }
            let createSucceeded = false;
            try {
                logger('debug', 'PlayerManager', `Creating player for guild ${guildId} (session: ${this.sessionId}) on worker ${worker.id}`);
                const createResult = await workerManager.execute(worker, 'createPlayer', {
                    sessionId: this.sessionId,
                    guildId,
                    userId: this.getSessionUserId(session),
                    voice
                });
                if (createResult?.created === false &&
                    createResult?.reason !== 'Player already exists') {
                    throw new Error(createResult?.reason || 'The player could not be created.');
                }
                createSucceeded = true;
                if (!this.players.has(playerKey)) {
                    this.players.set(playerKey, {
                        guildId,
                        userId: this.getSessionUserId(session),
                        sessionId: this.sessionId
                    });
                }
                workerManager.assignGuildToWorker(playerKey, worker);
                const player = this.players.get(playerKey);
                if (!player) {
                    throw new Error('Player map did not contain the created entry.');
                }
                this.nodelink.pluginManager?.callHook('onPlayerCreate', guildId, this.sessionId, createResult);
                return player;
            }
            catch (error) {
                if (!createSucceeded) {
                    workerManager.unassignGuild(playerKey);
                    throw new Error('The player could not be created.', { cause: error });
                }
                throw error;
            }
        }
        const userId = this.getSessionUserId(session);
        if (!userId) {
            throw new Error(`Session ${this.sessionId} is missing a valid user id.`);
        }
        if (!session.socket) {
            throw new Error(`Session ${this.sessionId} socket is not available.`);
        }
        const localSession = {
            id: session.id,
            userId,
            socket: session.socket,
            eventQueue: session.eventQueue,
            isPaused: session.isPaused
        };
        const { Player } = await import('../playback/player.js');
        logger('debug', 'PlayerManager', `Creating new player for guild ${guildId} (session: ${this.sessionId})`);
        const player = new Player({
            nodelink: this.nodelink,
            session: localSession,
            guildId
        });
        this.players.set(playerKey, player);
        this.nodelink.statistics.players += 1;
        this.nodelink.pluginManager?.callHook('onPlayerCreate', guildId, this.sessionId, { created: true });
        return player;
    }
    /**
     * Returns a managed player entry by guild id.
     * @param guildId - Target guild id.
     */
    get(guildId) {
        return this.players.get(this.getPlayerKey(guildId));
    }
    /**
     * Destroys a player for the provided guild.
     * @param guildId - Target guild id.
     */
    async destroy(guildId) {
        const playerKey = this.getPlayerKey(guildId);
        if (this.isCluster) {
            const workerManager = this.getWorkerManagerOrThrow();
            if (!workerManager.isGuildAssigned(playerKey)) {
                return;
            }
            const worker = workerManager.getWorkerForGuild(playerKey);
            if (worker) {
                await workerManager.execute(worker, 'destroyPlayer', {
                    sessionId: this.sessionId,
                    guildId
                });
            }
            workerManager.unassignGuild(playerKey);
            this.players.delete(playerKey);
            this.nodelink.pluginManager?.callHook('onPlayerDestroy', guildId, this.sessionId);
            return;
        }
        const player = this.getLocalPlayerOrThrow(playerKey);
        player.destroy();
        this.players.delete(playerKey);
        this.nodelink.statistics.players = Math.max(0, this.nodelink.statistics.players - 1);
        this.nodelink.pluginManager?.callHook('onPlayerDestroy', guildId, this.sessionId);
    }
    /**
     * Starts playback for a track payload.
     */
    async play(guildId, trackPayload) {
        const interception = await this._runInterceptors('play', guildId, trackPayload);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'play', [trackPayload]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.play(trackPayload);
    }
    /**
     * Preloads a track without starting playback.
     */
    async preload(guildId, trackPayload) {
        const interception = await this._runInterceptors('preload', guildId, trackPayload);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'preload', [trackPayload]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.preload(trackPayload);
    }
    /**
     * Clears any queued/preloaded next track for the guild player.
     */
    async clearNextTrack(guildId) {
        const interception = await this._runInterceptors('clearNextTrack', guildId);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'clearNextTrack', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.clearNextTrack();
    }
    /**
     * Stops playback for the guild player.
     */
    async stop(guildId) {
        const interception = await this._runInterceptors('stop', guildId);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'stop', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.stop();
    }
    /**
     * Pauses or resumes playback.
     */
    async pause(guildId, shouldPause) {
        const interception = await this._runInterceptors('pause', guildId, shouldPause);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'pause', [shouldPause]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.pause(shouldPause);
    }
    /**
     * Seeks current playback to the provided position.
     */
    async seek(guildId, position, endTime) {
        const interception = await this._runInterceptors('seek', guildId, position, endTime);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'seek', [position, endTime]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.seek(position, endTime);
    }
    /**
     * Updates player output volume.
     */
    async volume(guildId, level) {
        const interception = await this._runInterceptors('volume', guildId, level);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'volume', [level]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.volume(level);
    }
    /**
     * Applies filter configuration to the player.
     */
    async setFilters(guildId, filtersPayload) {
        const interception = await this._runInterceptors('setFilters', guildId, filtersPayload);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'setFilters', [
                filtersPayload
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.setFilters(filtersPayload);
    }
    /**
     * Updates fading configuration.
     */
    async setFading(guildId, fadingConfig) {
        const interception = await this._runInterceptors('setFading', guildId, fadingConfig);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'setFading', [fadingConfig]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.setFading(fadingConfig);
    }
    /**
     * Updates crossfade configuration.
     */
    async setCrossfade(guildId, crossfadeConfig) {
        const interception = await this._runInterceptors('setCrossfade', guildId, crossfadeConfig);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'setCrossfade', [
                crossfadeConfig
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.setCrossfade(crossfadeConfig);
    }
    /**
     * Enables or disables loudness normalization.
     */
    async setLoudnessNormalizer(guildId, enabled) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'setLoudnessNormalizer', [
                enabled
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.setLoudnessNormalizer(enabled);
    }
    /**
     * Applies voice state updates to the player.
     */
    async updateVoice(guildId, voicePayload) {
        const interception = await this._runInterceptors('updateVoice', guildId, voicePayload);
        if (interception?.handled)
            return interception.result;
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'updateVoice', [
                voicePayload
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        player.updateVoice(voicePayload);
        return undefined;
    }
    /**
     * Serializes player state to a JSON-compatible object.
     * @param guildId - Target guild id.
     * @param repairMissing - Recreates a missing worker player before retrying.
     */
    async toJSON(guildId, repairMissing = false) {
        if (this.isCluster) {
            return this.runClusterPlayerCommand(guildId, 'toJSON', [], repairMissing);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.toJSON();
    }
    /**
     * Adds a mix layer to the player.
     */
    async addMix(guildId, trackPayload, volume = null) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'addMix', [
                trackPayload,
                volume
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.addMix(trackPayload, volume);
    }
    /**
     * Removes a mix layer from the player.
     */
    async removeMix(guildId, mixId) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'removeMix', [mixId]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.removeMix(mixId);
    }
    /**
     * Updates the volume of an existing mix layer.
     */
    async updateMix(guildId, mixId, volume) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'updateMix', [mixId, volume]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.updateMix(mixId, volume);
    }
    /**
     * Returns all active mix layers for the player.
     */
    async getMixes(guildId) {
        if (this.isCluster) {
            return this.runClusterPlayerCommand(guildId, 'getMixes', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.getMixes();
    }
    /**
     * Subscribes the player to lyrics updates.
     */
    async subscribeLyrics(guildId, skipTrackSource) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'subscribeLyrics', [
                skipTrackSource
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        await player.subscribeLyrics(skipTrackSource);
        return undefined;
    }
    /**
     * Unsubscribes the player from lyrics updates.
     */
    async unsubscribeLyrics(guildId) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'unsubscribeLyrics', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        await player.unsubscribeLyrics();
        return undefined;
    }
    /**
     * Returns current SponsorBlock state for a player.
     */
    async getSponsorBlock(guildId) {
        if (this.isCluster) {
            return this.runClusterPlayerCommand(guildId, 'getSponsorBlock', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        return player.getSponsorBlock();
    }
    /**
     * Updates SponsorBlock settings for a player.
     */
    async updateSponsorBlock(guildId, updates) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'updateSponsorBlock', [
                updates
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        player.updateSponsorBlock(updates);
        return undefined;
    }
    /**
     * Overrides SponsorBlock segments for a player.
     */
    async setSponsorBlockSegments(guildId, segments) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'setSponsorBlockSegments', [
                segments
            ]);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        player.setSponsorBlockSegments(segments);
        return undefined;
    }
    /**
     * Clears SponsorBlock state for a player.
     */
    async clearSponsorBlock(guildId) {
        if (this.isCluster) {
            return this.runClusterMutation(guildId, 'clearSponsorBlock', []);
        }
        const player = this.getLocalPlayerOrThrow(this.getPlayerKey(guildId));
        player.clearSponsorBlock();
        return undefined;
    }
}
