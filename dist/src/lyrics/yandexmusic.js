import crypto from 'node:crypto';
import { http1makeRequest, logger } from '../utils.js';
/**
 * Base URL for Yandex Music API.
 * @internal
 */
const API_BASE = 'https://api.music.yandex.net';
/**
 * User agent header value for Yandex API requests.
 * @internal
 */
const USER_AGENT = 'Yandex-Music-API';
/**
 * Yandex client header value expected by lyrics endpoint.
 * @internal
 */
const CLIENT_HEADER = 'YandexMusicAndroid/24023621';
/**
 * Android signing key for Yandex lyrics requests.
 * @internal
 */
const ANDROID_SIGN_KEY = 'p93jhgh689SBReK6ghtw62';
/**
 * Yandex Music lyrics provider.
 * @public
 */
export default class YandexMusicLyrics {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * OAuth token used for Yandex requests.
     */
    accessToken;
    /**
     * Creates a new Yandex lyrics provider.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.accessToken = null;
    }
    /**
     * Initializes the provider and resolves token sources.
     * @returns True when token exists, otherwise false.
     */
    async setup() {
        this.accessToken =
            this.nodelink.options.lyrics?.yandexmusic?.accessToken ||
                this.nodelink.options.sources?.yandexmusic?.accessToken ||
                this.nodelink.credentialManager.get('yandexmusic_access_token') ||
                null;
        if (!this.accessToken) {
            logger('warn', 'Lyrics', 'Yandex Music lyrics disabled (no token).');
            return false;
        }
        return true;
    }
    /**
     * Loads lyrics for the provided track.
     * @param trackInfo - Track metadata required for Yandex lookup.
     * @returns Lyrics payload, empty result, or provider error.
     */
    async getLyrics(trackInfo) {
        if (!trackInfo?.identifier || !this.accessToken) {
            return { loadType: 'empty', data: {} };
        }
        try {
            const { sign, timestamp } = this._createSign(trackInfo.identifier);
            const url = new URL(`${API_BASE}/tracks/${trackInfo.identifier}/lyrics`);
            url.searchParams.set('format', 'LRC');
            url.searchParams.set('timeStamp', String(timestamp));
            url.searchParams.set('sign', sign);
            const { statusCode, body } = (await http1makeRequest(url.toString(), {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `OAuth ${this.accessToken}`,
                    'User-Agent': USER_AGENT,
                    'X-Yandex-Music-Client': CLIENT_HEADER
                },
                localAddress: this.nodelink.routePlanner?.getIP?.() ?? undefined
            }));
            const payload = typeof body === 'string'
                ? JSON.parse(body)
                : body;
            if (statusCode !== 200 || payload?.error) {
                return { loadType: 'empty', data: {} };
            }
            const downloadUrl = payload?.result?.downloadUrl;
            if (!downloadUrl)
                return { loadType: 'empty', data: {} };
            const lrcText = await this._fetchText(downloadUrl);
            const lines = this._parseLrc(lrcText);
            if (lines.length === 0)
                return { loadType: 'empty', data: {} };
            return {
                loadType: 'lyrics',
                data: {
                    name: trackInfo.title || 'Unknown',
                    synced: true,
                    lines
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Lyrics', `Yandex Music lyrics error: ${message}`);
            return {
                loadType: 'error',
                data: { message, severity: 'fault' }
            };
        }
    }
    /**
     * Creates signed request data for Yandex lyrics endpoint.
     * @param trackId - Yandex track identifier.
     * @returns Signature payload with timestamp.
     * @internal
     */
    _createSign(trackId) {
        const timestamp = Math.floor(Date.now() / 1000);
        const message = `${trackId}${timestamp}`;
        const hmac = crypto.createHmac('sha256', ANDROID_SIGN_KEY);
        const sign = encodeURIComponent(hmac.update(message).digest('base64'));
        return { sign, timestamp };
    }
    /**
     * Downloads LRC text from Yandex download URL.
     * @param url - Download URL returned by API.
     * @returns Raw LRC text.
     * @throws Error when HTTP status is not 200.
     * @internal
     */
    async _fetchText(url) {
        const { statusCode, body } = (await http1makeRequest(url, {
            method: 'GET',
            headers: { Authorization: `OAuth ${this.accessToken}` },
            localAddress: this.nodelink.routePlanner?.getIP?.() ?? undefined
        }));
        if (statusCode !== 200)
            throw new Error(`HTTP ${statusCode} on ${url}`);
        return typeof body === 'string' ? body : String(body);
    }
    /**
     * Parses LRC text into unified line payload.
     * @param lrc - Raw LRC content.
     * @returns Parsed synced lyric lines.
     * @internal
     */
    _parseLrc(lrc) {
        const lines = [];
        const regex = /\[(\d{2}):(\d{2})\.(\d{2})\]\s*(.*?)(?=\n|\[|$)/g;
        for (const match of lrc.matchAll(regex)) {
            const minutes = Number(match[1] || 0);
            const seconds = Number(match[2] || 0);
            const centiseconds = Number(match[3] || 0);
            const time = (minutes * 60 + seconds) * 1000 + centiseconds * 10;
            const text = (match[4] || '').trim();
            if (!text)
                continue;
            lines.push({ text, time, duration: 0 });
        }
        return lines;
    }
}
