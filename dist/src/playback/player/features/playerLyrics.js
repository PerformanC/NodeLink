import { logger } from '../../../utils.js';
export class PlayerLyrics {
    runtime;
    playback;
    clock;
    connectionController;
    constructor(runtime) {
        this.runtime = runtime;
    }
    _lyricsMarkerTimer = null;
    isLyricsSubscribed = false;
    currentLyrics = null;
    lyricsLineIndex = -1;
    skipTrackSource = false;
    async subscribeLyrics(skipTrackSource) {
        logger('debug', 'Player', `[Action: subscribeLyrics] Method invoked for guild ${this.runtime.guildId}`);
        return new Promise((resolve) => {
            if (this.isLyricsSubscribed) {
                return resolve();
            }
            this.isLyricsSubscribed = true;
            this.skipTrackSource =
                skipTrackSource === 'true' || skipTrackSource === true;
            if (this.playback.track && !this.playback.isPaused) {
                this._loadLyrics().catch((error) => {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    logger('warn', 'Lyrics', `Failed to load lyrics for guild ${this.runtime.guildId}: ${errorMessage} `);
                });
            }
            return resolve();
        });
    }
    unsubscribeLyrics() {
        logger('debug', 'Player', `[Action: unsubscribeLyrics] Method invoked for guild ${this.runtime.guildId}`);
        return new Promise((resolve) => {
            this.isLyricsSubscribed = false;
            this.skipTrackSource = false;
            this.currentLyrics = null;
            this.lyricsLineIndex = -1;
            if (this._lyricsMarkerTimer) {
                clearTimeout(this._lyricsMarkerTimer);
                this._lyricsMarkerTimer = null;
            }
            return resolve();
        });
    }
    async _loadLyrics() {
        if (!this.playback.track)
            return;
        const lyricsManager = this.runtime.nodelink.lyrics ??
            (await this.runtime.nodelink.getLyricsManager?.());
        if (!lyricsManager)
            return;
        const lyricsData = await lyricsManager.loadLyrics({ info: this.playback.track.info }, undefined, this.skipTrackSource);
        if (lyricsData && lyricsData.loadType === 'lyrics') {
            const lines = lyricsData.data.lines.map((line) => ({
                timestamp: line.time,
                duration: line.duration || 0,
                line: line.text,
                words: line.words || [],
                plugin: {}
            }));
            for (let i = 0; i < lines.length - 1; i++) {
                const current = lines[i];
                const next = lines[i + 1];
                if (!current || !next)
                    continue;
                if (current.duration === 0) {
                    current.duration = next.timestamp - current.timestamp;
                }
            }
            const payload = {
                sourceName: this.playback.track.info.sourceName,
                provider: lyricsData.data.provider,
                text: lyricsData.data.lines.map((l) => l.text).join('\n'),
                lines,
                plugin: {}
            };
            this.currentLyrics = payload;
            this.lyricsLineIndex = -1;
            this.runtime.emitEvent('LyricsFoundEvent', { lyrics: this.currentLyrics });
            if (this._lyricsMarkerTimer) {
                clearTimeout(this._lyricsMarkerTimer);
                this._lyricsMarkerTimer = null;
            }
            this._recalculateLyricsIndex(undefined, undefined, true);
            this._syncLyrics(true);
        }
        else {
            this.currentLyrics = null;
            this.runtime.emitEvent('LyricsNotFoundEvent');
        }
    }
    _syncLyrics(force = false) {
        if (!this.isLyricsSubscribed || !this.currentLyrics?.lines)
            return;
        if (this._lyricsMarkerTimer && !force)
            return;
        const timescale = this.clock._getTimescale();
        const playbackSpeed = timescale.speed * timescale.rate;
        const position = this._getLyricsPosition(playbackSpeed);
        const lines = this.currentLyrics.lines;
        this._recalculateLyricsIndex(position, lines);
        const nextIndex = this.lyricsLineIndex + 1;
        const nextLine = lines[nextIndex];
        if (!nextLine)
            return;
        const nextTimestamp = nextLine.timestamp;
        const delayMs = Math.max(0, (nextTimestamp - position) / playbackSpeed);
        this._lyricsMarkerTimer = setTimeout(() => {
            this._lyricsMarkerTimer = null;
            if (!this.isLyricsSubscribed || !this.currentLyrics?.lines)
                return;
            const timedLine = this.currentLyrics.lines[nextIndex];
            if (!timedLine)
                return;
            const nowPosition = this._getLyricsPosition(playbackSpeed);
            const drift = nowPosition - nextTimestamp;
            if (drift < -15) {
                this._syncLyrics(true);
                return;
            }
            if (Math.abs(drift) > 100) {
                this.clock._lyricsBasePosition -= drift * 0.25;
            }
            this.lyricsLineIndex = nextIndex;
            this.runtime.emitEvent('LyricsLineEvent', {
                lineIndex: nextIndex,
                line: timedLine,
                skipped: drift > 60
            });
            this._syncLyrics(true);
        }, delayMs);
    }
    _getLyricsPosition(playbackSpeed) {
        const stats = this.connectionController.connection?.statistics;
        const packets = stats?.playbackPackets ?? this.clock._lyricsBasePackets;
        const deltaPackets = Math.max(0, packets - this.clock._lyricsBasePackets);
        return this.clock._lyricsBasePosition + deltaPackets * 20 * playbackSpeed;
    }
    _recalculateLyricsIndex(positionOverride, linesOverride, allowBackward = false) {
        if (!this.currentLyrics?.lines)
            return;
        const lines = linesOverride || this.currentLyrics.lines;
        let position = positionOverride;
        if (position === undefined) {
            const timescale = this.clock._getTimescale();
            const playbackSpeed = timescale.speed * timescale.rate;
            position = this._getLyricsPosition(playbackSpeed);
        }
        let foundIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line)
                continue;
            if (line.timestamp <= position) {
                foundIndex = i;
            }
            else {
                break;
            }
        }
        if (!allowBackward && foundIndex < this.lyricsLineIndex) {
            return;
        }
        if (foundIndex !== this.lyricsLineIndex) {
            const skipped = foundIndex > this.lyricsLineIndex + 1;
            this.lyricsLineIndex = foundIndex;
            if (foundIndex !== -1) {
                const line = lines[foundIndex];
                if (!line)
                    return;
                this.runtime.emitEvent('LyricsLineEvent', {
                    lineIndex: foundIndex,
                    line: line,
                    skipped
                });
            }
        }
    }
}
