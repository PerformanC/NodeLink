import { logger, makeRequest } from '../utils.js';
/**
 * Meaning provider backed by Wikipedia.
 *
 * Tries a small set of track/artist queries and returns the first
 * non-empty extract found from MediaWiki.
 * @public
 */
export default class WikipediaMeaning {
    nodelink;
    priority;
    /**
     * Creates a new Wikipedia meaning provider.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.priority = 90;
    }
    /**
     * Initializes the provider.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Removes HTML comments and trims text.
     * @param text - Raw extract text from Wikipedia.
     * @returns Normalized clean text.
     */
    _cleanText(text) {
        if (!text)
            return '';
        return text.replace(/<!--[\s\S]*?-->/g, '').trim();
    }
    /**
     * Loads meaning details for a track from Wikipedia.
     * @param trackInfo - Track metadata used to build search queries.
     * @param language - Target language code (default: `en`).
     * @returns Meaning payload or empty result.
     */
    async getMeaning(trackInfo, language) {
        const lang = language || 'en';
        const queries = [];
        if (trackInfo.title) {
            queries.push({ type: 'track', query: `${trackInfo.title} (song)` });
            queries.push({ type: 'track', query: trackInfo.title });
        }
        if (trackInfo.author) {
            queries.push({ type: 'artist', query: trackInfo.author });
        }
        for (const item of queries) {
            const { type, query } = item;
            const encodedQuery = encodeURIComponent(query);
            const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts|description&titles=${encodedQuery}&redirects=1&explaintext=1`;
            try {
                const { body, statusCode } = await makeRequest(url, { method: 'GET' });
                const response = body;
                const pages = response?.query?.pages;
                if (statusCode !== 200 || !pages)
                    continue;
                const pageId = Object.keys(pages)[0];
                if (!pageId || pageId === '-1')
                    continue;
                const page = pages[pageId];
                if (!page)
                    continue;
                const extract = this._cleanText(page.extract);
                if (extract && extract !== '\n') {
                    const pageTitle = page.title || query;
                    return {
                        loadType: 'meaning',
                        data: {
                            title: page.title || null,
                            description: page.description || null,
                            paragraphs: extract
                                .split('\n')
                                .filter((line) => line.trim().length > 0),
                            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pageTitle.replace(/ /g, '_'))}`,
                            translation: null,
                            meaningMeta: {
                                id: null,
                                localeId: null,
                                origin: null,
                                submittedBy: null,
                                reviewedBy: null
                            },
                            song: {
                                title: trackInfo.title || page.title || null,
                                artist: trackInfo.author || null,
                                youtubeId: null,
                                letrasId: null,
                                artworkUrl: null
                            },
                            type
                        }
                    };
                }
            }
            catch (e) {
                logger('debug', 'WikipediaMeaning', `Failed to fetch for query "${query}": ${e.message}`);
            }
        }
        return { loadType: 'empty', data: {} };
    }
}
