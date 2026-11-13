/**
 * YouTube iOS Producer Innertube client.
 *
 * This is a secondary playback client. It does not require OAuth or player
 * JavaScript, and currently exposes AAC formats rather than YouTube's usual
 * Opus audio formats.
 */
import { BaseClient } from '../common.js';
export default class IOSProducer extends BaseClient {
    constructor(nodelink, oauth) {
        super(nodelink, 'IOS_PRODUCER', oauth);
    }
    getClient(context) {
        return {
            client: {
                clientName: 'IOS_PRODUCER',
                clientVersion: '0.147.945',
                deviceMake: 'Apple',
                deviceModel: 'iPhone16,2',
                userAgent: 'com.google.ios.youtubeproducer/0.147.945 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
                osName: 'iPhone',
                osVersion: '18.3.2.22D82',
                hl: context.client.hl,
                gl: context.client.gl,
                visitorData: context.client.visitorData
            },
            user: { lockedSafetyMode: false },
            request: { useSsl: true }
        };
    }
    getClientHeaders() {
        return {
            'X-Youtube-Client-Name': '92',
            'X-Youtube-Client-Version': '0.147.945'
        };
    }
    requiresOAuth() {
        return false;
    }
    requirePlayerScript() {
        return false;
    }
    async getTrackUrl(decodedTrack, context, cipherManager, itag, proxy) {
        const { body, statusCode } = await this._makePlayerRequest(decodedTrack.identifier, context, {}, cipherManager, proxy);
        if (statusCode !== 200 || !body) {
            return {
                loadType: 'error',
                exception: {
                    message: `Failed to get player data for stream. Status: ${statusCode}`,
                    severity: 'common',
                    cause: 'Upstream'
                }
            };
        }
        return this._extractStreamData(body, decodedTrack, context, cipherManager, itag);
    }
}
