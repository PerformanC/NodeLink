export class PlaybackClock {
    runtime;
    playback;
    connectionController;
    constructor(runtime) {
        this.runtime = runtime;
    }
    _audioConsumedBaselineMs = 0;
    _audioTrackBasePositionMs = 0;
    position = 0;
    _lyricsBasePosition = 0;
    _lyricsBasePackets = 0;
    _getTimescale() {
        const filterSettings = this.playback.filters.filters;
        const timescale = filterSettings?.timescale || {};
        return {
            speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
            rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
        };
    }
    _realPosition() {
        const audioStream = this.connectionController.connection?.audioStream;
        const playbackSpeed = audioStream?.getEffectiveRate() ?? this._getTimescaleSpeed();
        const packets = this.connectionController.connection?.statistics?.playbackPackets ??
            this._lyricsBasePackets;
        const deltaPackets = Math.max(0, packets - this._lyricsBasePackets);
        return this._lyricsBasePosition + deltaPackets * 20 * playbackSpeed;
    }
    _getTimescaleSpeed() {
        const settings = (this.playback.filters.filters ??
            this.playback.filters);
        const timescale = settings.timescale || {};
        return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0);
    }
    _snapshotPosition() {
        if (!this.connectionController.connection?.audioStream)
            return;
        this._lyricsBasePosition = this._realPosition();
        this._lyricsBasePackets =
            this.connectionController.connection.statistics?.playbackPackets ?? 0;
    }
    _resetAudioConsumptionBaseline(position, consumedMs = 0) {
        this._audioTrackBasePositionMs = Math.max(0, position);
        this._audioConsumedBaselineMs = Math.max(0, consumedMs);
    }
    _getPipelineLeadMs(stream, playbackPosition) {
        const consumedMs = stream.getConsumedMs();
        if (!Number.isFinite(consumedMs))
            return 0;
        const decodedElapsed = Math.max(0, (consumedMs ?? 0) - this._audioConsumedBaselineMs);
        const playedElapsed = Math.max(0, playbackPosition - this._audioTrackBasePositionMs);
        return Math.min(10000, Math.max(0, decodedElapsed - playedElapsed));
    }
}
