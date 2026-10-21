import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
/**
 * Manages the audio mixer and additional track layers.
 * @internal
 */
export class PlayerMixer {
    player;
    nodelink;
    _audioMixerInitPromise = null;
    constructor(player, nodelink) {
        this.player = player;
        this.nodelink = nodelink;
    }
    /**
     * Initializes the audio mixer instance used for mix layers and fading.
     */
    async _initAudioMixer() {
        if (this.player.audioMixer)
            return;
        const { AudioMixer: Mixer } = await import('../../processing/AudioMixer.js');
        this.player.audioMixer = new Mixer(this.nodelink.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5,
            autoCleanup: true
        });
        this.player.audioMixer.on('mixStarted', (data) => {
            this.player.emitEvent(GatewayEvents.MIX_STARTED, {
                mixId: data.id,
                track: data.track,
                volume: data.volume
            });
        });
        this.player.audioMixer.on('mixEnded', (data) => {
            this.player.emitEvent(GatewayEvents.MIX_ENDED, {
                mixId: data.id,
                reason: data.reason
            });
        });
        this.player.audioMixer.on('mixError', (data) => {
            const errorMessage = data.error ? data.error.message : 'Unknown mix error';
            logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`);
        });
    }
    /**
     * Ensures the audio mixer is initialized only once on demand.
     */
    async _ensureAudioMixer() {
        if (this.player.audioMixer)
            return;
        if (!this._audioMixerInitPromise) {
            this._audioMixerInitPromise = this._initAudioMixer()
                .catch((err) => {
                this._audioMixerInitPromise = null;
                throw err;
            })
                .then(() => {
                this._audioMixerInitPromise = null;
            });
        }
        await this._audioMixerInitPromise;
    }
    _destroyAudioMixer() {
        if (this.player.audioMixer) {
            this.player.audioMixer.destroy();
            this.player.audioMixer = null;
        }
        this._audioMixerInitPromise = null;
    }
    /**
     * Adds an additional mix layer over the main stream.
     *
     * @param trackPayload - Track to mix in PCM form.
     * @param volume - Optional mix volume (0-1). Defaults to mix config.
     * @throws Error when no active main stream or mixer limits exceeded.
     */
    async addMix(trackPayload, volume = null) {
        logger('debug', 'Player', `[Action: addMix] Method invoked for guild ${this.player.guildId}`);
        if (!this.player.track || this.player.isPaused) {
            throw new Error('Cannot add mix without an active stream');
        }
        await this._ensureAudioMixer();
        if (!this.player.audioMixer)
            throw new Error('AudioMixer not initialized');
        const mixConfig = this.nodelink?.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5
        };
        if (this.player.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)) {
            throw new Error(`Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`);
        }
        const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8;
        const { createAudioResource: createResource } = await import('../../processing/streamProcessor.js');
        const urlData = await this.nodelink.sources.getTrackUrl(trackPayload.info);
        if (!urlData?.url) {
            throw new Error('Failed to get stream URL for mix track');
        }
        const fetched = await this.nodelink.sources.getTrackStream(urlData.newTrack?.info || trackPayload.info, urlData.url, urlData.protocol, urlData.additionalData);
        if (fetched.exception) {
            throw new Error(fetched.exception.message);
        }
        const pcmResource = createResource(this.player.guildId, fetched.stream, fetched.type || urlData.format || 'unknown', this.nodelink, {}, mixVolume, null, true);
        const mixId = this.player.audioMixer.addLayer(pcmResource.stream, trackPayload, mixVolume);
        return {
            id: mixId,
            track: trackPayload,
            volume: mixVolume
        };
    }
    /**
     * Removes a mix layer by id.
     *
     * @param mixId - Identifier returned by addMix.
     * @returns True when removed.
     */
    removeMix(mixId) {
        logger('debug', 'Player', `[Action: removeMix] Method invoked for guild ${this.player.guildId} mixId=${mixId}`);
        if (!this.player.audioMixer) {
            return false;
        }
        return this.player.audioMixer.removeLayer(mixId);
    }
    /**
     * Updates the volume of a mix layer.
     *
     * @param mixId - Identifier of the mix layer.
     * @param volume - New volume (0-1).
     * @returns True when updated; false if layer missing.
     */
    updateMix(mixId, volume) {
        logger('debug', 'Player', `[Action: updateMix] Method invoked for guild ${this.player.guildId} mixId=${mixId} volume=${volume}`);
        if (!this.player.audioMixer) {
            return false;
        }
        return this.player.audioMixer.updateLayerVolume(mixId, volume);
    }
    /**
     * Lists active mix layers.
     *
     * @returns Current mix layers with track and volume.
     */
    getMixes() {
        logger('debug', 'Player', `[Action: getMixes] Method invoked for guild ${this.player.guildId}`);
        if (!this.player.audioMixer) {
            return [];
        }
        return this.player.audioMixer.getLayers();
    }
}
