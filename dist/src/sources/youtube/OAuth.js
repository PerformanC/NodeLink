import { logger, makeRequest } from '../../utils.js';
const CLIENT_ID = '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com';
const CLIENT_SECRET = 'SboVhoG9s0rNafixCSGGKXAT';
const SCOPES = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube';
/**
 * Refresh-token helper for authenticated YouTube clients.
 *
 * The helper rotates configured refresh tokens, caches access tokens in the
 * credential manager, and exposes the device-code flow used to mint new
 * refresh tokens for TV-oriented clients.
 *
 * @example
 * ```typescript
 * const oauth = new OAuth(nodelink)
 * const headers = await oauth.getAuthHeaders()
 * ```
 *
 * @public
 */
export default class OAuth {
    /** Runtime configuration and credential hooks consumed by the helper. */
    nodelink;
    /** Refresh tokens loaded from the YouTube client settings. */
    refreshToken;
    /** Index of the next refresh token candidate to try. */
    currentTokenIndex;
    /** In-memory cached access token. */
    accessToken;
    /** Epoch timestamp in milliseconds when the in-memory token expires. */
    tokenExpiry;
    /**
     * Creates an OAuth helper bound to the current runtime configuration.
     *
     * @param nodelink - Runtime carrying YouTube client settings and credentials.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        const clientSettings = this.nodelink.options.sources?.youtube?.clients?.settings ?? {};
        let foundToken = null;
        for (const clientName of Object.keys(clientSettings)) {
            const refreshToken = clientSettings[clientName]?.refreshToken;
            if (refreshToken) {
                foundToken = refreshToken;
                break;
            }
        }
        this.refreshToken = foundToken
            ? Array.isArray(foundToken)
                ? foundToken.filter((token) => typeof token === 'string')
                : [foundToken]
            : [];
        this.currentTokenIndex = 0;
        this.accessToken = null;
        this.tokenExpiry = 0;
    }
    /**
     * Resolves a valid OAuth access token for authenticated YouTube requests.
     *
     * The helper first checks the in-memory token, then the credential cache,
     * and finally rotates through configured refresh tokens until one succeeds.
     *
     * @example
     * ```typescript
     * const accessToken = await oauth.getAccessToken()
     * if (accessToken) {
     *   console.log('Authenticated requests enabled')
     * }
     * ```
     *
     * @returns Access token string, or `null` when authentication is unavailable.
     */
    async getAccessToken() {
        if (!this.refreshToken.length ||
            (this.refreshToken.length === 1 && this.refreshToken[0] === '')) {
            return null;
        }
        if (this.accessToken && Date.now() < this.tokenExpiry) {
            return this.accessToken;
        }
        const cachedToken = this.nodelink.credentialManager?.get('yt_access_token');
        if (typeof cachedToken === 'string' && cachedToken.length > 0) {
            this.accessToken = cachedToken;
            this.tokenExpiry = Date.now() + 3_500_000;
            return this.accessToken;
        }
        const maxTokenAttempts = this.refreshToken.length;
        let tokensTried = 0;
        while (tokensTried < maxTokenAttempts) {
            const currentToken = this.refreshToken[this.currentTokenIndex];
            if (!currentToken) {
                this.currentTokenIndex =
                    (this.currentTokenIndex + 1) % this.refreshToken.length;
                tokensTried++;
                continue;
            }
            let attempts = 0;
            while (attempts < 3) {
                attempts++;
                try {
                    const { body, error, statusCode } = await makeRequest('https://www.youtube.com/o/oauth2/token', {
                        method: 'POST',
                        body: {
                            client_id: CLIENT_ID,
                            client_secret: CLIENT_SECRET,
                            refresh_token: currentToken,
                            grant_type: 'refresh_token'
                        }
                    });
                    const response = (body ?? {});
                    if (!error &&
                        statusCode === 200 &&
                        typeof response.access_token === 'string' &&
                        typeof response.expires_in === 'number') {
                        this.accessToken = response.access_token;
                        this.tokenExpiry = Date.now() + response.expires_in * 1000 - 30000;
                        this.nodelink.credentialManager?.set('yt_access_token', this.accessToken, response.expires_in * 1000 - 30000);
                        return this.accessToken;
                    }
                }
                catch { }
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
            this.currentTokenIndex =
                (this.currentTokenIndex + 1) % this.refreshToken.length;
            tokensTried++;
        }
        this.accessToken = null;
        this.tokenExpiry = 0;
        return null;
    }
    /**
     * Validates whether the currently configured refresh tokens still work.
     *
     * @example
     * ```typescript
     * const isValid = await oauth.validateCurrentTokens()
     * console.log(isValid)
     * ```
     *
     * @returns `true` when at least one refresh token can produce an access token.
     */
    async validateCurrentTokens() {
        if (!this.refreshToken.length ||
            (this.refreshToken.length === 1 && this.refreshToken[0] === '')) {
            return false;
        }
        const token = await this.getAccessToken();
        if (!token) {
            return false;
        }
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        logger('info', 'OAuth', '\x1b[1m\x1b[32mYOUR refreshtoken IS VALID :)\x1b[0m');
        logger('info', 'OAuth', '\x1b[37mPlease disable the \x1b[33mgetOAuthToken\x1b[37m option if you restarted by accident\x1b[0m');
        logger('info', 'OAuth', "\x1b[37mand didn't change it to \x1b[31mfalse\x1b[37m. If you want to get a second token\x1b[0m");
        logger('info', 'OAuth', '\x1b[37mfor fallback, follow the same steps and add \x1b[32m, ""\x1b[37m for this new token below.\x1b[0m');
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        return true;
    }
    /**
     * Builds the Authorization header map for authenticated client requests.
     *
     * @example
     * ```typescript
     * const headers = await oauth.getAuthHeaders()
     * await makeRequest(url, { headers })
     * ```
     *
     * @returns OAuth bearer headers, or an empty object when unauthenticated.
     */
    async getAuthHeaders() {
        const token = await this.getAccessToken();
        if (!token) {
            return {};
        }
        return {
            Authorization: `Bearer ${token}`
        };
    }
    /**
     * Starts the OAuth device-code flow and returns a newly issued refresh token.
     *
     * @example
     * ```typescript
     * const refreshToken = await OAuth.acquireRefreshToken()
     * console.log(refreshToken)
     * ```
     *
     * @returns Refresh token granted by Google's device authorization flow.
     */
    static async acquireRefreshToken() {
        const { body, error, statusCode } = await makeRequest('https://www.youtube.com/o/oauth2/device/code', {
            method: 'POST',
            body: {
                client_id: CLIENT_ID,
                scope: SCOPES
            }
        });
        const response = (body ?? {});
        if (error ||
            statusCode !== 200 ||
            response.error ||
            typeof response.device_code !== 'string' ||
            typeof response.user_code !== 'string' ||
            typeof response.verification_url !== 'string') {
            throw new Error(`Error obtaining device code: ${error || response.error_description || 'Invalid response'}`);
        }
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        logger('info', 'OAuth', '\x1b[1m\x1b[31mALERT: DO NOT USE YOUR MAIN GOOGLE ACCOUNT! USE A SECONDARY OR BURNER ACCOUNT ONLY!\x1b[0m');
        logger('info', 'OAuth', '\x1b[36mTo authorize, visit the following URL in your browser:\x1b[0m');
        logger('info', 'OAuth', `\x1b[1m\x1b[32mURL: ${response.verification_url}\x1b[0m`);
        logger('info', 'OAuth', `\x1b[36mAnd enter the code: \x1b[1m\x1b[37m${response.user_code}\x1b[0m`);
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        const refreshToken = await OAuth.pollForToken(response.device_code, response.interval ?? 5);
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        logger('info', 'OAuth', '\x1b[1m\x1b[32mAuthorization granted successfully! :)\x1b[0m');
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        logger('info', 'OAuth', '\x1b[36mCopy your Refresh Token and paste it in your \x1b[1mconfig.js\x1b[36m:\x1b[0m');
        logger('info', 'OAuth', `\x1b[1m\x1b[37m${refreshToken}\x1b[0m`);
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m');
        logger('info', 'OAuth', '\x1b[1m\x1b[31mIMPORTANT:\x1b[0m');
        logger('info', 'OAuth', '\x1b[37mAfter pasting the token, you \x1b[1mMUST\x1b[37m set \x1b[33mgetOAuthToken\x1b[37m to \x1b[31mfalse\x1b[0m');
        logger('info', 'OAuth', '\x1b[37motherwise the server will keep trying to obtain a new token on every restart.\x1b[0m');
        logger('info', 'OAuth', '\x1b[33mExample JSON structure for your config.js:\x1b[0m');
        const exampleJson = JSON.stringify({
            sources: {
                youtube: {
                    getOAuthToken: false,
                    clients: {
                        settings: {
                            TV: {
                                refreshToken: [refreshToken]
                            }
                        }
                    }
                }
            }
        }, null, 2);
        logger('info', 'OAuth', `\x1b[32m${exampleJson}\x1b[0m`);
        logger('info', 'OAuth', '\x1b[33m==================================================================\x1b[0m\n');
        return refreshToken;
    }
    /**
     * Polls Google's OAuth token endpoint until device authorization completes.
     *
     * @param deviceCode - Device code previously returned by `acquireRefreshToken`.
     * @param interval - Suggested polling interval in seconds.
     *
     * @example
     * ```typescript
     * const refreshToken = await OAuth.pollForToken(deviceCode, 5)
     * ```
     *
     * @returns Refresh token string once the user completes authorization.
     */
    static async pollForToken(deviceCode, interval) {
        return new Promise((resolve, reject) => {
            const poll = async () => {
                logger('info', 'OAuth', '\x1b[35m>>> AWAITING...\x1b[0m waiting for token :P');
                try {
                    const { body, error, statusCode } = await makeRequest('https://www.youtube.com/o/oauth2/token', {
                        method: 'POST',
                        body: {
                            client_id: CLIENT_ID,
                            client_secret: CLIENT_SECRET,
                            code: deviceCode,
                            grant_type: 'http://oauth.net/grant_type/device/1.0'
                        }
                    });
                    const response = (body ?? {});
                    if (error || statusCode !== 200 || response.error) {
                        if (response.error === 'authorization_pending') {
                            setTimeout(poll, interval * 1000);
                            return;
                        }
                        if (response.error === 'slow_down') {
                            setTimeout(poll, (interval + 5) * 1000);
                            return;
                        }
                        if (response.error === 'expired_token') {
                            reject(new Error('Authorization code expired.'));
                            return;
                        }
                        if (response.error === 'access_denied') {
                            reject(new Error('Access denied.'));
                            return;
                        }
                        reject(new Error(`Error during polling: ${response.error_description || error || 'Unknown error'}`));
                        return;
                    }
                    if (typeof response.refresh_token !== 'string') {
                        reject(new Error('Refresh token missing from OAuth response.'));
                        return;
                    }
                    logger('info', 'OAuth', '>>> TOKEN RECEIVED :)');
                    resolve(response.refresh_token);
                }
                catch {
                    setTimeout(poll, interval * 1000);
                }
            };
            poll();
        });
    }
}
