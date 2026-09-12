import { http1makeRequest, logger } from '../utils.js';
/**
 * Letras suggest endpoint for track discovery.
 * @internal
 */
const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/';
/**
 * Decodes common HTML entities from Letras payloads.
 * @param text - Raw text.
 * @returns Decoded text.
 * @internal
 */
const decodeHtml = (text) => {
    if (!text)
        return text || '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
};
/**
 * Cleans text fragments extracted from HTML content.
 * @param text - Raw HTML-free text.
 * @returns Sanitized text.
 * @internal
 */
const cleanText = (text) => {
    if (!text)
        return '';
    let cleaned = decodeHtml(text);
    cleaned = cleaned.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '');
    return cleaned.trim();
};
/**
 * Parses JSONP payload returned by Letras suggest endpoint.
 * @param body - Raw endpoint body.
 * @returns Parsed Solr response or null.
 * @internal
 */
const parseJsonp = (body) => {
    if (!body)
        return null;
    const trimmed = body.trim();
    if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
        return JSON.parse(trimmed.slice('LetrasSug('.length, -1));
    }
    const start = trimmed.indexOf('(');
    const end = trimmed.lastIndexOf(')');
    if (start !== -1 && end > start) {
        return JSON.parse(trimmed.slice(start + 1, end));
    }
    return JSON.parse(trimmed);
};
/**
 * Normalizes text for matching.
 * @param text - Raw text.
 * @returns Comparable normalized text.
 * @internal
 */
const normalize = (text) => (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
/**
 * Extracts OMQ lyric metadata block from page HTML.
 * @param html - Letras page HTML.
 * @returns Parsed OMQ payload or null.
 * @internal
 */
const extractOmqLyric = (html) => {
    const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i);
    if (!match)
        return null;
    try {
        return JSON.parse(match[1] || '{}');
    }
    catch {
        return null;
    }
};
/**
 * Extracts original lyrics block from page HTML.
 * @param html - Letras page HTML.
 * @returns Plain lyrics lines or null.
 * @internal
 */
const extractLyricOriginal = (html) => {
    const match = html.match(/<div class="lyric-original[^>]*">([\s\S]*?)<\/div>/i);
    if (!match)
        return null;
    let text = match[1] || '';
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    return text.split('\n').map(cleanText).filter(Boolean);
};
/**
 * Extracts available translation languages from page HTML.
 * @param html - Letras page HTML.
 * @returns Translation language entries.
 * @internal
 */
const extractTranslationLanguages = (html) => {
    const match = html.match(/window\.__translationLanguages\s*=\s*(\[[\s\S]*?\]);/i);
    if (!match)
        return [];
    try {
        const parsed = JSON.parse(match[1] || '[]');
        return Array.isArray(parsed)
            ? parsed
            : [];
    }
    catch {
        return [];
    }
};
/**
 * Normalizes language codes for matching.
 * @param lang - Incoming language code.
 * @returns Normalized code or null.
 * @internal
 */
const normalizeLang = (lang) => {
    if (!lang)
        return null;
    const cleaned = lang.toLowerCase().replace('-', '_');
    if (cleaned.startsWith('pt'))
        return 'pt';
    if (cleaned.startsWith('en'))
        return 'en';
    if (cleaned.startsWith('es'))
        return 'es';
    if (cleaned.startsWith('de'))
        return 'de';
    if (cleaned.startsWith('fr'))
        return 'fr';
    if (cleaned.startsWith('nl'))
        return 'nl';
    return cleaned;
};
/**
 * Builds translation page URL from translation entry.
 * @param entry - Translation entry metadata.
 * @returns Translation URL or null.
 * @internal
 */
const buildTranslationUrl = (entry) => {
    if (!entry?.url?.artist || !entry?.url?.song || !entry?.url?.translation) {
        return null;
    }
    return `https://www.letras.mus.br/${entry.url.artist}/${entry.url.song}/${entry.url.translation}`;
};
/**
 * Parses subtitle API payload into synced line objects.
 * @param subtitle - Serialized subtitle JSON string.
 * @returns Parsed synchronized lyric lines.
 * @internal
 */
const parseSubtitle = (subtitle) => {
    let parsed;
    try {
        parsed = JSON.parse(subtitle);
    }
    catch {
        return [];
    }
    if (!Array.isArray(parsed))
        return [];
    return parsed
        .map((entry) => {
        if (!Array.isArray(entry) || entry.length < 3)
            return null;
        const tuple = entry;
        const text = cleanText(String(tuple[0] || ''));
        const start = Number.parseFloat(String(tuple[1] || 'NaN'));
        const end = Number.parseFloat(String(tuple[2] || 'NaN'));
        if (!text || Number.isNaN(start) || Number.isNaN(end))
            return null;
        return {
            text,
            time: Math.round(start * 1000),
            duration: Math.max(0, Math.round((end - start) * 1000))
        };
    })
        .filter((line) => line !== null);
};
/**
 * Builds canonical Letras track URL.
 * @param dns - Artist slug.
 * @param url - Song slug.
 * @returns Canonical track URL.
 * @internal
 */
const buildTrackUrl = (dns, url) => `https://www.letras.mus.br/${dns}/${url}/`;
/**
 * Selects best Solr candidate document for track metadata.
 * @param docs - Candidate documents.
 * @param title - Track title.
 * @param author - Track author.
 * @returns Best candidate or null.
 * @internal
 */
const findBestDoc = (docs, title, author) => {
    const wantedTitle = normalize(title);
    const wantedAuthor = normalize(author);
    const candidates = docs.filter((doc) => doc?.t === '2' && doc?.dns && doc?.url);
    let best = candidates.find((doc) => normalize(doc.txt) === wantedTitle &&
        normalize(doc.art) === wantedAuthor) || null;
    if (!best) {
        best = candidates.find((doc) => normalize(doc.txt) === wantedTitle) || null;
    }
    return best || candidates[0] || null;
};
/**
 * Letras Mus lyrics provider.
 * @public
 */
export default class LetrasMusLyrics {
    /**
     * Runtime NodeLink context.
     */
    nodelink;
    /**
     * Creates a new Letras lyrics provider.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
    }
    /**
     * Initializes provider resources.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Fetches HTML content for a given URL.
     * @param url - Target URL.
     * @returns Response body or null when request fails.
     * @internal
     */
    async _fetchHtml(url) {
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body)
            return null;
        return typeof body === 'string' ? body : String(body);
    }
    /**
     * Resolves canonical Letras page URL for a track.
     * @param trackInfo - Track metadata.
     * @returns Canonical Letras page URL or null.
     * @internal
     */
    async _findLetrasPage(trackInfo) {
        if (trackInfo?.uri && trackInfo.sourceName === 'letrasmus') {
            return trackInfo.uri;
        }
        const query = `${trackInfo.title} ${trackInfo.author}`.trim();
        const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`;
        const { body, statusCode, error } = await http1makeRequest(url, {
            method: 'GET'
        });
        if (error || statusCode !== 200 || !body || typeof body !== 'string')
            return null;
        const parsed = parseJsonp(body);
        const docs = parsed?.response?.docs || [];
        const best = findBestDoc(docs, trackInfo.title || '', trackInfo.author || '');
        if (!best?.dns || !best.url)
            return null;
        return buildTrackUrl(best.dns, best.url);
    }
    /**
     * Loads lyrics from Letras source.
     * @param trackInfo - Track metadata.
     * @param language - Optional requested translation language.
     * @returns Lyrics payload, empty result, or provider error.
     */
    async getLyrics(trackInfo, language) {
        try {
            const pageUrl = await this._findLetrasPage(trackInfo);
            if (!pageUrl)
                return { loadType: 'empty', data: {} };
            const html = await this._fetchHtml(pageUrl);
            if (!html)
                return { loadType: 'empty', data: {} };
            const omq = extractOmqLyric(html);
            const letrasId = omq?.ID;
            const youtubeId = omq?.YoutubeID;
            const originalLang = omq?.SongLanguage || null;
            const requestedLang = normalizeLang(language);
            if (requestedLang) {
                const translations = extractTranslationLanguages(html);
                const entry = translations.find((item) => normalizeLang(item.languageCode) === requestedLang ||
                    (item.languageCode || '').toLowerCase().startsWith(requestedLang)) || null;
                const translationUrl = entry ? buildTranslationUrl(entry) : null;
                if (!translationUrl)
                    return { loadType: 'empty', data: {} };
                const translationHtml = await this._fetchHtml(translationUrl);
                if (!translationHtml)
                    return { loadType: 'empty', data: {} };
                const translatedLines = extractLyricOriginal(translationHtml);
                if (!translatedLines || translatedLines.length === 0) {
                    return { loadType: 'empty', data: {} };
                }
                return {
                    loadType: 'lyrics',
                    data: {
                        name: omq?.Name || trackInfo.title || 'Unknown',
                        synced: false,
                        language: {
                            requested: language || null,
                            resolved: requestedLang,
                            type: 'translation'
                        },
                        lines: translatedLines.map((text) => ({
                            text,
                            time: 0,
                            duration: 0
                        }))
                    }
                };
            }
            if (letrasId && youtubeId) {
                const apiUrl = `https://www.letras.mus.br/api/v2/subtitle/${letrasId}/${youtubeId}/`;
                const { body: apiBody, statusCode } = await http1makeRequest(apiUrl, {
                    method: 'GET'
                });
                const parsedApiBody = typeof apiBody === 'string'
                    ? JSON.parse(apiBody)
                    : apiBody;
                if (statusCode === 200 &&
                    parsedApiBody?.status !== 'not found' &&
                    parsedApiBody?.Original?.Subtitle) {
                    const lines = parseSubtitle(parsedApiBody.Original.Subtitle);
                    if (lines.length) {
                        return {
                            loadType: 'lyrics',
                            data: {
                                name: omq?.Name || trackInfo.title || 'Unknown',
                                synced: true,
                                language: {
                                    requested: null,
                                    resolved: originalLang,
                                    type: 'original'
                                },
                                lines
                            }
                        };
                    }
                }
            }
            const plainLines = extractLyricOriginal(html);
            if (!plainLines || plainLines.length === 0) {
                return { loadType: 'empty', data: {} };
            }
            return {
                loadType: 'lyrics',
                data: {
                    name: omq?.Name || trackInfo.title || 'Unknown',
                    synced: false,
                    language: {
                        requested: null,
                        resolved: originalLang,
                        type: 'original'
                    },
                    lines: plainLines.map((text) => ({ text, time: 0, duration: 0 }))
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Lyrics', `Letras lyrics error: ${message}`);
            return {
                loadType: 'error',
                data: { message, severity: 'fault' }
            };
        }
    }
}
