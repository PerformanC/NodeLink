import { getBestMatch, logger, makeRequest } from '../utils.js';
/**
 * Deezer lyrics provider utilizing the Deezer GraphQL internal API.
 * Supports word-by-word and line-level synchronization.
 * @public
 */
export default class DeezerLyrics {
    /**
     * NodeLink service context required for source lookups.
     * @public
     */
    nodelink;
    /**
     * Cached anonymous JWT token for authentication.
     * @internal
     */
    jwt;
    /**
     * Unix timestamp (ms) when the current JWT expires.
     * @internal
     */
    jwtExpiry;
    /**
     * Constructs a new DeezerLyrics provider.
     * @param nodelink - The parent service context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.jwt = null;
        this.jwtExpiry = 0;
    }
    /**
     * Performs provider-specific resource initialization.
     * @returns A promise resolving to true.
     * @public
     */
    async setup() {
        return true;
    }
    /**
     * Obtains a valid anonymous JWT from the Deezer authentication service.
     * Caches results until expiration.
     * @returns A promise resolving to the JWT string or null.
     * @internal
     */
    async _getJwt() {
        if (this.jwt && Date.now() < this.jwtExpiry)
            return this.jwt;
        try {
            const { body, error } = await makeRequest('https://auth.deezer.com/login/anonymous?jo=p&rto=c', { method: 'GET' });
            if (error)
                throw new Error('Request failed');
            const data = typeof body === 'string'
                ? JSON.parse(body)
                : body;
            if (!data?.jwt)
                throw new Error('No JWT in response');
            this.jwt = data.jwt;
            this.jwtExpiry = Date.now() + 300000;
            return this.jwt;
        }
        catch (e) {
            logger('error', 'Lyrics', `Deezer JWT fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }
    /**
     * Fetches and parses lyrics for the specified track.
     * Automatically resolves non-Deezer tracks using metadata matching.
     * @param trackInfo - Metadata of the track to fetch lyrics for.
     * @returns A promise resolving to a LyricsResult.
     * @public
     */
    async getLyrics(trackInfo) {
        const jwt = await this._getJwt();
        if (!jwt)
            return { loadType: 'empty', data: {} };
        let trackId = trackInfo.identifier;
        if (trackInfo.sourceName !== 'deezer') {
            const query = `${trackInfo.title} ${trackInfo.author}`;
            const searchRes = await this.nodelink.sources.search('deezer', query);
            if (searchRes.loadType !== 'search' ||
                !Array.isArray(searchRes.data) ||
                searchRes.data.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            const candidates = searchRes.data;
            const bestMatch = getBestMatch(candidates, trackInfo);
            if (!bestMatch)
                return { loadType: 'empty', data: {} };
            const matchedCandidate = bestMatch;
            trackId = matchedCandidate.info.identifier;
        }
        try {
            const query = `query GetLyrics($trackId: String!) {
  track(trackId: $trackId) {
    id
    lyrics {
      id
      text
      ...SynchronizedWordByWordLines
      ...SynchronizedLines
      licence
      copyright
      writers
      __typename
    }
    __typename
  }
}

fragment SynchronizedWordByWordLines on Lyrics {
  id
  synchronizedWordByWordLines {
    start
    end
    words {
      start
      end
      word
      __typename
    }
    __typename
  }
  __typename
}

fragment SynchronizedLines on Lyrics {
  id
  synchronizedLines {
    lrcTimestamp
    line
    lineTranslated
    milliseconds
    duration
    __typename
  }
  __typename
}`;
            const res = await makeRequest('https://pipe.deezer.com/api', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    'Content-Type': 'application/json'
                },
                body: {
                    operationName: 'GetLyrics',
                    variables: { trackId: String(trackId) },
                    query
                },
                disableBodyCompression: true
            });
            const data = typeof res.body === 'string'
                ? JSON.parse(res.body)
                : res.body;
            const lyrics = data?.data?.track?.lyrics;
            if (res.error || !lyrics)
                return { loadType: 'empty', data: {} };
            let lines = [];
            let synced = false;
            if (lyrics.synchronizedWordByWordLines?.length) {
                synced = true;
                lines = lyrics.synchronizedWordByWordLines.map((line) => ({
                    time: line.start,
                    duration: line.end - line.start,
                    text: line.words.map((w) => w.word).join(' '),
                    words: line.words.map((w) => ({
                        text: w.word,
                        timestamp: w.start,
                        duration: w.end - w.start
                    }))
                }));
            }
            else if (lyrics.synchronizedLines?.length) {
                synced = true;
                lines = lyrics.synchronizedLines.map((line) => ({
                    time: line.milliseconds,
                    duration: line.duration,
                    text: line.line
                }));
            }
            else if (lyrics.text) {
                lines = lyrics.text
                    .split(/\r?\n/)
                    .map((text) => ({ time: 0, duration: 0, text: text.trim() }))
                    .filter((line) => line.text.length > 0);
            }
            return {
                loadType: 'lyrics',
                data: {
                    name: trackInfo.title,
                    synced,
                    lines
                }
            };
        }
        catch (e) {
            logger('error', 'Lyrics', `Deezer lyrics request failed: ${e instanceof Error ? e.message : String(e)}`);
            return { loadType: 'empty', data: {} };
        }
    }
}
