import { GatewayEvents } from '../../../constants.js';
import { logger } from '../../../utils.js';
export class PlayerMixes {
    runtime;
    playback;
    constructor(runtime) {
        this.runtime = runtime;
    }
    audioMixer = null;
    _audioMixerInitPromise = null;
    async _initAudioMixer() {
        if (this.audioMixer)
            return;
        const { AudioMixer: Mixer } = await import('../../processing/AudioMixer.js');
        this.audioMixer = new Mixer(this.runtime.nodelink.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5,
            autoCleanup: true
        });
        this.audioMixer.on('mixStarted', (data) => {
            this.runtime.emitEvent(GatewayEvents.MIX_STARTED, {
                mixId: data.id,
                track: data.track,
                volume: data.volume
            });
        });
        this.audioMixer.on('mixEnded', (data) => {
            this.runtime.emitEvent(GatewayEvents.MIX_ENDED, {
                mixId: data.id,
                reason: data.reason
            });
        });
        this.audioMixer.on('mixError', (data) => {
            const errorMessage = data.error ? data.error.message : 'Unknown mix error';
            logger('error', 'Player', `Mix error for ${data.id}: ${errorMessage}`);
        });
    }
    async _ensureAudioMixer() {
        if (this.audioMixer)
            return;
        if (!this._audioMixerInitPromise) {
            this._audioMixerInitPromise = this._initAudioMixer()
                .catch((error) => {
                this._audioMixerInitPromise = null;
                throw error;
            })
                .then(() => {
                this._audioMixerInitPromise = null;
            });
        }
        await this._audioMixerInitPromise;
    }
    _destroyAudioMixer() {
        if (this.audioMixer) {
            this.audioMixer.destroy();
            this.audioMixer = null;
        }
        this._audioMixerInitPromise = null;
    }
    async addMix(trackPayload, volume = null) {
        logger('debug', 'Player', `[Action: addMix] Method invoked for guild ${this.runtime.guildId}`);
        if (!this.playback.track || this.playback.isPaused) {
            throw new Error('Cannot add mix without an active stream');
        }
        await this._ensureAudioMixer();
        if (!this.audioMixer)
            throw new Error('AudioMixer not initialized');
        const mixConfig = this.runtime.nodelink?.options?.playback.mix ?? {
            enabled: true,
            defaultVolume: 0.8,
            maxLayersMix: 5
        };
        if (this.audioMixer.mixLayers.size >= (mixConfig.maxLayersMix ?? 5)) {
            throw new Error(`Maximum number of mix layers(${mixConfig.maxLayersMix}) reached`);
        }
        const mixVolume = volume ?? mixConfig.defaultVolume ?? 0.8;
        const { createAudioResource: createResource } = await import('../../processing/streamProcessor.js');
        const urlData = await this.runtime.nodelink.sources.getTrackUrl(trackPayload.info);
        if (!urlData?.url) {
            throw new Error('Failed to get stream URL for mix track');
        }
        const fetched = await this.runtime.nodelink.sources.getTrackStream(urlData.newTrack?.info || trackPayload.info, urlData.url, urlData.protocol, urlData.additionalData);
        if (fetched.exception) {
            throw new Error(fetched.exception.message);
        }
        const pcmResource = createResource(this.runtime.guildId, fetched.stream, fetched.type || urlData.format || 'unknown', this.runtime.nodelink, {}, mixVolume, null, true);
        const mixId = this.audioMixer.addLayer(pcmResource.stream, trackPayload, mixVolume);
        return {
            id: mixId,
            track: trackPayload,
            volume: mixVolume
        };
    }
    removeMix(mixId) {
        logger('debug', 'Player', `[Action: removeMix] Method invoked for guild ${this.runtime.guildId} mixId=${mixId}`);
        if (!this.audioMixer) {
            return false;
        }
        return this.audioMixer.removeLayer(mixId);
    }
    updateMix(mixId, volume) {
        logger('debug', 'Player', `[Action: updateMix] Method invoked for guild ${this.runtime.guildId} mixId=${mixId} volume=${volume}`);
        if (!this.audioMixer) {
            return false;
        }
        return this.audioMixer.updateLayerVolume(mixId, volume);
    }
    getMixes() {
        logger('debug', 'Player', `[Action: getMixes] Method invoked for guild ${this.runtime.guildId}`);
        if (!this.audioMixer) {
            return [];
        }
        return this.audioMixer.getLayers();
    }
}
