// Copyright (C) 2026 NodeLink.
// This file is part of NodeLink and is protected under the GNU General Public License v3 (GPLv3).
// All parts of this project are protected by this license. See LICENSE for details.
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { RingBuffer } from '../structs/RingBuffer.js';
const LAYER_BUFFER_SIZE = 1024 * 1024;
const EMPTY_BUFFER = Buffer.alloc(0);
const FRAME_SIZE = 3840;
const SILENCE_FRAME = Buffer.alloc(FRAME_SIZE);
/**
 * Mixer that allows layering multiple audio streams over a main PCM stream.
 * Acts now as a continuous river (readable stream)
 */
export class AudioMixer extends Readable {
    mixLayers;
    maxLayers;
    defaultVolume;
    autoCleanup;
    enabled;
    layerListeners;
    /**
     * Creates a new AudioMixer.
     * @param config - Mixer configuration.
     */
    constructor(config = {}) {
        super({ highWaterMark: FRAME_SIZE * 4 });
        this.mixLayers = new Map();
        this.maxLayers = config.maxLayersMix || 5;
        this.defaultVolume = config.defaultVolume || 0.8;
        this.autoCleanup = config.autoCleanup !== false;
        this.enabled = config.enabled !== false;
        this.layerListeners = new Map();
    }
    _read(_size) {
        const targetSize = FRAME_SIZE;
        if (this.mixLayers.size === 0 || !this.enabled) {
            this.push(SILENCE_FRAME);
            return;
        }
        const chunks = this.readLayerChunks(targetSize);
        if (chunks.size === 0) {
            this.push(SILENCE_FRAME);
            return;
        }
        const baseBuffer = Buffer.alloc(targetSize);
        const mixedBuffer = this.mixBuffers(baseBuffer, chunks);
        this.push(mixedBuffer);
    }
    /**
     * Ensures a buffer is treated as Int16Array, handling alignment.
     * @param buffer - Input buffer.
     * @returns Int16Array view of the buffer.
     */
    _asInt16Array(buffer) {
        if (buffer.byteOffset % 2 === 0 && buffer.length % 2 === 0) {
            return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
        }
        const alignedBuffer = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
        return new Int16Array(alignedBuffer.buffer, alignedBuffer.byteOffset, alignedBuffer.length / 2);
    }
    /**
     * Mixes multiple PCM buffers into a main PCM buffer.
     * @param mainPCM - The primary PCM buffer.
     * @param layersPCM - Map of additional PCM layers to mix in.
     * @returns The mixed PCM buffer.
     */
    mixBuffers(mainPCM, layersPCM) {
        if (layersPCM.size === 0 || !this.enabled)
            return mainPCM;
        const outputBuffer = Buffer.allocUnsafe(mainPCM.length);
        const mainView = this._asInt16Array(mainPCM);
        const outputView = this._asInt16Array(outputBuffer);
        const activeLayerViews = [];
        for (const layer of layersPCM.values()) {
            activeLayerViews.push({
                view: this._asInt16Array(layer.buffer),
                volume: layer.volume
            });
        }
        const mainLen = mainView.length;
        const numLayers = activeLayerViews.length;
        for (let i = 0; i < mainLen; i++) {
            let sample = mainView[i] ?? 0;
            for (let j = 0; j < numLayers; j++) {
                const layer = activeLayerViews[j];
                if (!layer)
                    continue;
                if (i < layer.view.length) {
                    sample += ((layer.view[i] ?? 0) * layer.volume) | 0;
                }
            }
            outputView[i] = sample < -32768 ? -32768 : sample > 32767 ? 32767 : sample;
        }
        return outputBuffer;
    }
    /**
     * Adds a new audio layer to the mixer.
     * @param stream - The audio stream to add.
     * @param track - The track info associated with the stream.
     * @param volume - Optional volume for the layer.
     * @returns The unique ID of the added layer.
     * @throws Error if maximum layers are reached.
     */
    addLayer(stream, track, volume = null) {
        if (this.mixLayers.size >= this.maxLayers) {
            throw new Error(`Maximum mix layers (${this.maxLayers}) reached`);
        }
        const id = randomBytes(8).toString('hex');
        const actualVolume = volume !== null ? volume : this.defaultVolume;
        const layer = {
            id,
            stream,
            track,
            volume: Math.max(0, Math.min(1, actualVolume)),
            position: 0,
            startTime: Date.now(),
            active: true,
            finishedFeeding: false,
            ringBuffer: new RingBuffer(LAYER_BUFFER_SIZE),
            receivedBytes: 0,
            pending: EMPTY_BUFFER,
            paused: false
        };
        this.mixLayers.set(id, layer);
        const onData = (chunk) => {
            if (!layer.active)
                return;
            if (layer.ringBuffer.length > LAYER_BUFFER_SIZE * 0.8) {
                layer.paused = true;
                stream.pause();
            }
            let data = chunk;
            if (layer.pending.length > 0) {
                const merged = Buffer.allocUnsafe(layer.pending.length + chunk.length);
                layer.pending.copy(merged, 0);
                chunk.copy(merged, layer.pending.length);
                data = merged;
                layer.pending = EMPTY_BUFFER;
            }
            const remainder = data.length % 4;
            if (remainder > 0) {
                layer.pending = Buffer.from(data.subarray(data.length - remainder));
                data = data.subarray(0, data.length - remainder);
            }
            if (data.length > 0) {
                layer.receivedBytes += data.length;
                layer.ringBuffer.write(data);
            }
        };
        const onEnd = () => {
            layer.finishedFeeding = true;
        };
        const onClose = () => {
            layer.finishedFeeding = true;
        };
        const onError = (error) => {
            this.emit('mixError', { id, error });
            this.removeLayer(id, 'ERROR');
        };
        this.layerListeners.set(id, {
            data: onData,
            end: onEnd,
            close: onClose,
            error: onError
        });
        stream.on('data', onData);
        stream.once('end', onEnd);
        stream.once('close', onClose);
        stream.once('error', onError);
        this.emit('mixStarted', { id, track, volume: layer.volume });
        return id;
    }
    /**
     * Reads chunks from all active layers.
     * @param chunkSize - Size of chunk to read in bytes.
     * @returns Map of layer chunks.
     */
    readLayerChunks(chunkSize) {
        const layerChunks = new Map();
        const safeSize = chunkSize - (chunkSize % 4);
        for (const [id, layer] of this.mixLayers.entries()) {
            if (!layer.active)
                continue;
            if (layer.ringBuffer.length < safeSize) {
                if (layer.finishedFeeding && layer.ringBuffer.length === 0) {
                    if (this.autoCleanup)
                        this.removeLayer(id, 'FINISHED');
                }
                continue;
            }
            const chunk = layer.ringBuffer.read(safeSize);
            if (!chunk)
                continue;
            layerChunks.set(id, { buffer: chunk, volume: layer.volume });
            layer.position += chunk.length;
            if (layer.paused && layer.ringBuffer.length < LAYER_BUFFER_SIZE * 0.5) {
                layer.paused = false;
                layer.stream.resume();
            }
        }
        return layerChunks;
    }
    /**
     * Checks if there are any active layers.
     * @returns True if active layers exist.
     */
    hasActiveLayers() {
        return this.mixLayers.size > 0;
    }
    /**
     * Removes a layer from the mixer.
     * @param id - The ID of the layer to remove.
     * @param reason - Reason for removal.
     * @returns True if the layer was found and removed.
     */
    removeLayer(id, reason = 'REMOVED') {
        const layer = this.mixLayers.get(id);
        if (!layer)
            return false;
        layer.active = false;
        const listeners = this.layerListeners.get(id);
        if (listeners) {
            layer.stream.off('data', listeners.data);
            layer.stream.off('end', listeners.end);
            layer.stream.off('close', listeners.close);
            layer.stream.off('error', listeners.error);
            this.layerListeners.delete(id);
        }
        if (layer.stream && !layer.stream.destroyed) {
            layer.stream.destroy();
        }
        layer.ringBuffer.dispose();
        this.mixLayers.delete(id);
        this.emit('mixEnded', { id, reason, track: layer.track });
        return true;
    }
    /**
     * Updates the volume of a layer.
     * @param id - The ID of the layer.
     * @param volume - New volume (0.0 to 1.0).
     * @returns True if the layer was updated.
     */
    updateLayerVolume(id, volume) {
        const layer = this.mixLayers.get(id);
        if (!layer)
            return false;
        layer.volume = Math.max(0, Math.min(1, volume));
        return true;
    }
    /**
     * Gets information about a specific layer.
     * @param id - The ID of the layer.
     * @returns Partial layer info or null if not found.
     */
    getLayer(id) {
        const layer = this.mixLayers.get(id);
        if (!layer)
            return null;
        return {
            id: layer.id,
            track: layer.track,
            volume: layer.volume,
            position: layer.position,
            startTime: layer.startTime
        };
    }
    /**
     * Gets information about all active layers.
     * @returns Array of layer info.
     */
    getLayers() {
        return Array.from(this.mixLayers.values()).map((layer) => ({
            id: layer.id,
            track: layer.track,
            volume: layer.volume,
            position: layer.position,
            startTime: layer.startTime
        }));
    }
    /**
     * Clears all layers from the mixer.
     * @param reason - Reason for clearing.
     * @returns The number of layers cleared.
     */
    clearLayers(reason = 'CLEARED') {
        const ids = Array.from(this.mixLayers.keys());
        for (const id of ids)
            this.removeLayer(id, reason);
        return ids.length;
    }
    /**
     * Destroys the mixer: clears all layers, removes all listeners,
     * and ends the Readable stream.
     */
    destroy() {
        this.clearLayers('DESTROYED');
        this.removeAllListeners();
        super.destroy();
        return this;
    }
}
