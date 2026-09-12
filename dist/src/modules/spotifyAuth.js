import crypto from 'node:crypto';
import { http1makeRequest, logger } from '../utils.js';
/**
 * Built-in encoded TOTP secrets used as primary/fallback bootstrap.
 * @internal
 */
const ENCODED_SECRETS = [
    { secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N', version: 61 },
    { secret: 'OmE{ZA.J^":0FG\\Uz?[@WW', version: 60 },
    { secret: '{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH', version: 59 }
];
/**
 * Cached TOTP secret currently used for Spotify token requests.
 * @internal
 */
let currentTotpSecret = null;
/**
 * Cached TOTP version currently used for Spotify token requests.
 * @internal
 */
let currentTotpVersion = null;
/**
 * Last successful secret fetch timestamp in milliseconds.
 * @internal
 */
let lastSecretFetchTime = 0;
/**
 * Secret refresh interval in milliseconds.
 * @internal
 */
const SECRET_FETCH_INTERVAL = 60 * 60 * 1000;
/**
 * Remote source for updated Spotify TOTP secret dictionary.
 * @internal
 */
const SECRETS_URL = 'https://raw.githubusercontent.com/xyloflake/spot-secrets-go/refs/heads/main/secrets/secretDict.json';
/**
 * User agent used for Spotify web endpoints.
 * @internal
 */
const USER_AGENT_MOBILE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
/**
 * Decodes an obfuscated secret string into raw bytes.
 * @param encoded - Encoded secret value.
 * @returns Decoded secret bytes.
 * @internal
 */
function decodeSecret(encoded) {
    const t = 33;
    const n = 9;
    const byteValues = encoded.split('').map((char, index) => {
        return char.charCodeAt(0) ^ ((index % t) + n);
    });
    const joined = byteValues.join('');
    const asciiBuffer = Buffer.from(joined, 'utf8');
    const hexString = asciiBuffer.toString('hex');
    return Buffer.from(hexString, 'hex');
}
/**
 * Ensures an up-to-date TOTP secret is cached.
 * Falls back to hardcoded secret data when remote fetch fails.
 * @internal
 */
async function ensureTotpSecrets() {
    const now = Date.now();
    if (currentTotpSecret && now - lastSecretFetchTime < SECRET_FETCH_INTERVAL) {
        return;
    }
    try {
        const res = await http1makeRequest(SECRETS_URL, {
            headers: { Accept: 'application/json' }
        });
        if (res.statusCode !== 200 || !res.body) {
            throw new Error('Failed to fetch secrets');
        }
        const secrets = typeof res.body === 'string'
            ? JSON.parse(res.body)
            : res.body;
        const versions = Object.keys(secrets).map(Number);
        const newestVersion = Math.max(...versions).toString();
        const secretData = secrets[newestVersion];
        if (!secretData)
            throw new Error('Missing newest secret entry');
        const mappedData = secretData.map((value, index) => value ^ ((index % 33) + 9));
        currentTotpSecret = Buffer.from(mappedData.join(''), 'utf8').toString('hex');
        currentTotpVersion = newestVersion;
        lastSecretFetchTime = now;
    }
    catch (e) {
        logger('warn', 'SpotifyAuth', `Error fetching TOTP secrets: ${e instanceof Error ? e.message : String(e)}. Using fallback.`);
        if (!currentTotpSecret) {
            const fallbackData = [
                99, 111, 47, 88, 49, 56, 118, 65, 52, 67, 50, 104, 117, 101, 55, 94, 95,
                75, 94, 49, 69, 36, 85, 64, 74, 60
            ];
            const mapped = fallbackData.map((value, index) => value ^ ((index % 33) + 9));
            currentTotpSecret = Buffer.from(mapped.join(''), 'utf8').toString('hex');
            currentTotpVersion = '19';
        }
    }
}
/**
 * Retrieves Spotify server time for synchronized TOTP generation.
 * @param spDc - Optional Spotify `sp_dc` cookie value.
 * @returns Server time in milliseconds or local timestamp fallback.
 * @internal
 */
async function getServerTime(spDc) {
    try {
        const headers = { 'User-Agent': USER_AGENT_MOBILE };
        if (spDc)
            headers.Cookie = `sp_dc=${spDc}`;
        const res = await http1makeRequest('https://open.spotify.com/api/server-time', {
            headers
        });
        if (res.statusCode !== 200 || !res.body) {
            throw new Error('Failed to get time');
        }
        const data = typeof res.body === 'string'
            ? JSON.parse(res.body)
            : res.body;
        return typeof data.serverTime === 'number'
            ? data.serverTime * 1000
            : Date.now();
    }
    catch {
        return Date.now();
    }
}
/**
 * Generates a TOTP code for a given secret and timestamp.
 * @param secretHex - Secret in hexadecimal format.
 * @param timestampMs - Timestamp in milliseconds.
 * @param step - TOTP step in seconds.
 * @returns Six-digit TOTP code.
 * @internal
 */
function generateTOTP(secretHex, timestampMs, step = 30) {
    const counter = Math.floor(timestampMs / 1000 / step);
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex'));
    hmac.update(buf);
    const digest = hmac.digest();
    const offset = (digest[digest.length - 1] ?? 0) & 0xf;
    const code = ((((digest[offset] ?? 0) & 0x7f) << 24) |
        (((digest[offset + 1] ?? 0) & 0xff) << 16) |
        (((digest[offset + 2] ?? 0) & 0xff) << 8) |
        ((digest[offset + 3] ?? 0) & 0xff)) %
        1000000;
    return code.toString().padStart(6, '0');
}
/**
 * Performs Spotify token request using generated TOTP payload.
 * @param secret - Secret used to generate TOTPs.
 * @param version - TOTP version string.
 * @param spDc - Optional Spotify `sp_dc` cookie value.
 * @param productType - Spotify product type.
 * @returns Raw Spotify token response payload.
 * @internal
 */
async function performTokenRequest(secret, version, spDc, productType) {
    const isWebPlayer = productType === 'web-player';
    const serverTimeMs = await getServerTime(spDc);
    const totpLocal = generateTOTP(secret, serverTimeMs, 30);
    const totpServer = generateTOTP(secret, serverTimeMs, 900);
    const url = new URL('https://open.spotify.com/api/token');
    url.searchParams.append('reason', 'init');
    url.searchParams.append('productType', productType);
    if (!isWebPlayer)
        url.searchParams.append('platform', 'web');
    url.searchParams.append('totp', totpLocal);
    if (isWebPlayer)
        url.searchParams.append('totpServer', totpLocal);
    else
        url.searchParams.append('totpServer', totpServer);
    url.searchParams.append('totpVer', version);
    const headers = {
        'User-Agent': USER_AGENT_MOBILE,
        Origin: 'https://open.spotify.com/',
        Referer: 'https://open.spotify.com/',
        Accept: 'application/json'
    };
    if (spDc && !isWebPlayer)
        headers.Cookie = `sp_dc=${spDc}`;
    const res = await http1makeRequest(url.toString(), {
        method: 'GET',
        headers
    });
    if (res.statusCode !== 200 || !res.body) {
        throw new Error(`Spotify Auth Error: ${res.statusCode}`);
    }
    return typeof res.body === 'string'
        ? JSON.parse(res.body)
        : res.body;
}
/**
 * Retrieves a Spotify local token compatible with web/mobile player flows.
 * @param spDc - Optional Spotify `sp_dc` cookie value.
 * @param productType - Product type for token generation.
 * @returns Spotify token payload.
 * @public
 */
export async function getLocalToken(spDc, productType = 'mobile-web-player') {
    try {
        const primarySecret = ENCODED_SECRETS[0];
        if (!primarySecret)
            throw new Error('Missing primary encoded secret');
        const nativeSecret = decodeSecret(primarySecret.secret).toString('hex');
        const nativeVersion = String(primarySecret.version);
        return await performTokenRequest(nativeSecret, nativeVersion, spDc, productType);
    }
    catch {
        await ensureTotpSecrets();
        if (!currentTotpSecret) {
            throw new Error('No TOTP secret available');
        }
        return await performTokenRequest(currentTotpSecret, currentTotpVersion || '19', spDc, productType);
    }
}
