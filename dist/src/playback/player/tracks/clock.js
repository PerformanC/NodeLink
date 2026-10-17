/**
 * Tracks playback position from audio consumption and voice packets.
 * @internal
 */
export class PlaybackClock {
    player;
    voiceConnection;
    _packetBasePositionMs = 0;
    _packetBasePackets = 0;
    _audioConsumedBaselineMs = 0;
    _audioTrackBasePositionMs = 0;
    constructor(player, voiceConnection) {
        this.player = player;
        this.voiceConnection = voiceConnection;
    }
    /**
     * Reads the configured timescale speed and rate.
     */
    _getTimescale() {
        const filterSettings = this.player.filters.filters;
        const timescale = filterSettings?.timescale || {};
        return {
            speed: typeof timescale.speed === 'number' ? timescale.speed : 1.0,
            rate: typeof timescale.rate === 'number' ? timescale.rate : 1.0
        };
    }
    /**
     * Starts a fresh packet baseline, using zero if voice has no packet statistics.
     */
    _resetPacketBaseline(position) {
        this._packetBasePositionMs = position;
        this._snapshotPacketCount();
    }
    /**
     * Keeps the previous packet count if statistics are absent during a crossfade.
     */
    _continuePacketBaseline(position) {
        this._packetBasePositionMs = position;
        this._packetBasePackets =
            this.player.connection?.statistics?.packetsExpected ??
                this._packetBasePackets;
    }
    _snapshotPacketCount() {
        this._packetBasePackets =
            this.player.connection?.statistics?.packetsExpected ?? 0;
    }
    _adjustPacketPosition(offsetMs) {
        this._packetBasePositionMs += offsetMs;
    }
    _getPacketPosition(playbackSpeed) {
        const packets = this.player.connection?.statistics?.packetsExpected ??
            this._packetBasePackets;
        const deltaPackets = Math.max(0, packets - this._packetBasePackets);
        return this._packetBasePositionMs + deltaPackets * 20 * playbackSpeed;
    }
    _realPosition() {
        const audioStream = this.voiceConnection._getAudioStream();
        const playbackSpeed = audioStream?.getEffectiveRate?.() ?? this._getTimescaleSpeed();
        return this._getPacketPosition(playbackSpeed);
    }
    _getTimescaleSpeed() {
        const settings = (this.player.filters.filters ?? this.player.filters);
        const timescale = settings.timescale || {};
        return (timescale.speed ?? 1.0) * (timescale.rate ?? 1.0);
    }
    /**
     * Captures current position and packet count as a new baseline.
     * Call whenever playback speed changes (filters, tape, scratch).
     */
    _snapshotPosition() {
        if (!this.player.connection?.audioStream)
            return;
        this._packetBasePositionMs = this._realPosition();
        this._packetBasePackets =
            this.player.connection.statistics?.packetsExpected ?? 0;
    }
    _resetAudioConsumptionBaseline(position, consumedMs = 0) {
        this._audioTrackBasePositionMs = Math.max(0, position);
        this._audioConsumedBaselineMs = Math.max(0, consumedMs);
    }
    _getPipelineLeadMs(stream, playbackPosition) {
        const consumedMs = stream.getConsumedMs?.();
        if (!Number.isFinite(consumedMs))
            return 0;
        const decodedElapsed = Math.max(0, (consumedMs ?? 0) - this._audioConsumedBaselineMs);
        const playedElapsed = Math.max(0, playbackPosition - this._audioTrackBasePositionMs);
        return Math.min(10000, Math.max(0, decodedElapsed - playedElapsed));
    }
}
