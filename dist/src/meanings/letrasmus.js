import { translateMany, translateText } from '../modules/googleTranslate.js';
import { getBestMatch, http1makeRequest, logger } from '../utils.js';
/**
 * Letras suggest endpoint used to discover candidate tracks.
 * @internal
 */
const SOLR_ENDPOINT = 'https://solr.sscdn.co/letras/m1/';
/**
 * Normalizes query text to improve candidate matching.
 * @param text - Raw title or author text.
 * @returns Sanitized text without noisy tokens.
 * @internal
 */
const cleanText = (text) => {
    if (!text)
        return '';
    return text
        .replace(/\s*\([^)]*\)/g, ' ')
        .replace(/\s*\[[^\]]*\]/g, ' ')
        .replace(/\b(official|video|audio|mv|visualizer|live|session|ao vivo|lyric|lyrics|hd|4k|remix|edit|cover|acoustic|instrumental)\b/gi, ' ')
        .replace(/feat\.?/gi, ' ')
        .replace(/ft\.?/gi, ' ')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};
/**
 * Builds ranked query variations for Letras search.
 * @param trackInfo - Track metadata used to assemble queries.
 * @returns Candidate query strings ordered by relevance.
 * @internal
 */
const buildSearchCandidates = (trackInfo) => {
    const candidates = new Set();
    const rawTitle = trackInfo.title || '';
    const rawAuthor = trackInfo.author || '';
    const cleanedTitle = cleanText(rawTitle);
    const cleanedAuthor = cleanText(rawAuthor);
    const pushCandidate = (title, author) => {
        const t = cleanText(title);
        const a = cleanText(author);
        const combined = [t, a].filter(Boolean).join(' ').trim();
        if (combined)
            candidates.add(combined);
    };
    const rawTitleLower = rawTitle.toLowerCase();
    const rawAuthorLower = rawAuthor.toLowerCase();
    if (cleanedTitle || cleanedAuthor) {
        pushCandidate(cleanedTitle, cleanedAuthor);
    }
    if (cleanedTitle)
        candidates.add(cleanedTitle);
    const splitTitle = (title, sep) => {
        if (!title.includes(sep))
            return null;
        const parts = title.split(sep).map((part) => part.trim());
        if (parts.length < 2)
            return null;
        return [parts[0] || '', parts.slice(1).join(sep).trim()];
    };
    const dashSplit = splitTitle(rawTitle, ' - ');
    if (dashSplit) {
        const [left, right] = dashSplit;
        const leftClean = cleanText(left);
        const rightClean = cleanText(right);
        if (rightClean) {
            pushCandidate(rightClean, cleanedAuthor || leftClean);
            candidates.add(rightClean);
        }
        if (leftClean && rightClean) {
            pushCandidate(rightClean, leftClean);
        }
    }
    const pipeSplit = splitTitle(rawTitle, ' | ');
    if (pipeSplit) {
        const [left, right] = pipeSplit;
        const leftClean = cleanText(left);
        const rightClean = cleanText(right);
        if (leftClean)
            candidates.add(leftClean);
        if (rightClean)
            candidates.add(rightClean);
        if (leftClean && cleanedAuthor)
            pushCandidate(leftClean, cleanedAuthor);
    }
    if (rawAuthorLower && rawTitleLower.includes(rawAuthorLower)) {
        let stripped = '';
        try {
            stripped = cleanText(rawTitle.replace(new RegExp(rawAuthor, 'ig'), ''));
        }
        catch {
            stripped = cleanText(rawTitle);
        }
        if (stripped) {
            pushCandidate(stripped, cleanedAuthor);
            candidates.add(stripped);
        }
    }
    if (cleanedAuthor) {
        pushCandidate(cleanedTitle, cleanedAuthor);
        candidates.add(cleanedAuthor);
    }
    return Array.from(candidates);
};
/**
 * Parses JSONP responses from Letras suggest endpoint.
 * @param body - Raw endpoint response.
 * @returns Parsed Solr payload or null when invalid.
 * @internal
 */
const parseJsonp = (body) => {
    const trimmed = body.trim();
    try {
        if (trimmed.startsWith('LetrasSug(') && trimmed.endsWith(')')) {
            return JSON.parse(trimmed.slice('LetrasSug('.length, -1));
        }
        const start = trimmed.indexOf('(');
        const end = trimmed.lastIndexOf(')');
        if (start !== -1 && end > start) {
            return JSON.parse(trimmed.slice(start + 1, end));
        }
        return JSON.parse(trimmed);
    }
    catch {
        return null;
    }
};
/**
 * Decodes HTML entities into plain unicode text.
 * @param text - Encoded HTML fragment.
 * @returns Decoded text.
 * @internal
 */
const decodeHtml = (text) => {
    let out = text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    out = out.replace(/&#(\d+);/g, (match, dec) => {
        const code = Number(dec);
        if (!Number.isFinite(code))
            return match;
        return String.fromCodePoint(code);
    });
    out = out.replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
        const code = Number.parseInt(hex, 16);
        if (!Number.isFinite(code))
            return match;
        return String.fromCodePoint(code);
    });
    return out;
};
/**
 * Extracts OpenGraph metadata from HTML content.
 * @param html - Full page HTML.
 * @param property - OpenGraph property name.
 * @returns Metadata value or null when absent.
 * @internal
 */
const extractMeta = (html, property) => {
    const re1 = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)[^>]+property=["']${property}["'][^>]*>`, 'i');
    const match = html.match(re1) || html.match(re2);
    return match?.[1] ? decodeHtml(match[1]) : null;
};
/**
 * Extracts OMQ lyric metadata block from Letras HTML.
 * @param html - Full page HTML.
 * @returns Parsed lyric metadata or null.
 * @internal
 */
const extractOmqLyric = (html) => {
    const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,/i);
    if (!match?.[1])
        return null;
    try {
        return JSON.parse(match[1]);
    }
    catch {
        return null;
    }
};
/**
 * Extracts OMQ meaning metadata block from Letras HTML.
 * @param html - Full page HTML.
 * @returns Parsed meaning metadata or null.
 * @internal
 */
const extractOmqMeaning = (html) => {
    const match = html.match(/_omq\.push\(\['ui\/lyric',\s*({[\s\S]*?})\s*,\s*({[\s\S]*?})\s*,/i);
    if (!match?.[2])
        return null;
    try {
        return JSON.parse(match[2]);
    }
    catch {
        return null;
    }
};
/**
 * Extracts title and paragraphs from the meaning section.
 * @param html - Full page HTML.
 * @returns Normalized meaning block.
 * @internal
 */
const extractMeaning = (html) => {
    const match = html.match(/<div class="lyric-meaning[^>]*">([\s\S]*?)<\/div>/i);
    if (!match?.[1])
        return { title: null, body: [] };
    let block = match[1];
    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = titleMatch?.[1]
        ? decodeHtml(titleMatch[1].replace(/<[^>]+>/g, ''))
        : null;
    block = block.replace(/<h3[^>]*>[\s\S]*?<\/h3>/i, '');
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    for (const pMatch of block.matchAll(pRegex)) {
        const paragraphBlock = pMatch[1];
        if (!paragraphBlock)
            continue;
        let text = paragraphBlock.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        text = decodeHtml(text);
        const lines = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length)
            paragraphs.push(lines.join(' '));
    }
    if (!paragraphs.length) {
        let text = block.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/<[^>]+>/g, '');
        text = decodeHtml(text);
        const lines = text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length)
            paragraphs.push(lines.join(' '));
    }
    return { title, body: paragraphs };
};
/**
 * Converts a Solr document into internal track info.
 * @param doc - Solr candidate document.
 * @returns Normalized Letras track payload.
 * @internal
 */
const buildLetrasTrackInfo = (doc) => {
    const uri = `https://www.letras.mus.br/${doc.dns}/${doc.url}/`;
    return {
        title: doc.txt || 'Unknown',
        author: doc.art || 'Unknown',
        length: 0,
        uri,
        sourceName: 'letrasmus'
    };
};
/**
 * Queries Letras suggest endpoint and maps valid candidates.
 * @param query - Search query string.
 * @param limit - Maximum results to map.
 * @returns Candidate list for best-match scoring.
 * @internal
 */
const searchLetras = async (query, limit = 10) => {
    const url = `${SOLR_ENDPOINT}?q=${encodeURIComponent(query)}&wt=json&callback=LetrasSug`;
    const { body, statusCode, error } = await http1makeRequest(url, {
        method: 'GET'
    });
    if (error || statusCode !== 200 || typeof body !== 'string')
        return [];
    const parsed = parseJsonp(body);
    const docs = parsed?.response?.docs || [];
    return docs
        .filter((doc) => doc?.t === '2' && doc?.dns && doc?.url)
        .slice(0, limit)
        .map((doc) => ({ info: buildLetrasTrackInfo(doc) }));
};
/**
 * Reads translated text from translate module payload.
 * @param result - Translation module response payload.
 * @returns Translation text or null.
 * @internal
 */
const getTranslationText = (result) => {
    if (!result || typeof result !== 'object')
        return null;
    const record = result;
    return typeof record.translation === 'string' ? record.translation : null;
};
export default class LetrasMusMeaning {
    nodelink;
    priority;
    /**
     * Creates a new Letras meaning provider.
     * @param nodelink - Runtime NodeLink context.
     */
    constructor(nodelink) {
        this.nodelink = nodelink;
        this.priority = 70;
    }
    /**
     * Initializes the provider.
     * @returns Always true for this provider.
     */
    async setup() {
        return true;
    }
    /**
     * Loads meaning details for a track from Letras.
     * @param trackInfo - Track metadata used to resolve/search candidates.
     * @param language - Optional target language code for translation.
     * @returns Meaning payload, empty result, or provider error.
     */
    async getMeaning(trackInfo, language) {
        try {
            let candidates = [];
            if (trackInfo.sourceName === 'letrasmus' && trackInfo.uri) {
                candidates = [
                    {
                        info: {
                            title: trackInfo.title || 'Unknown',
                            author: trackInfo.author || 'Unknown',
                            length: typeof trackInfo.length === 'number' ? trackInfo.length : 0,
                            uri: trackInfo.uri,
                            sourceName: 'letrasmus'
                        }
                    }
                ];
            }
            else {
                const searchCandidates = buildSearchCandidates(trackInfo);
                let results = [];
                for (const query of searchCandidates) {
                    results = await searchLetras(query, 12);
                    if (results.length)
                        break;
                }
                if (results.length) {
                    const matchTarget = {
                        title: cleanText(trackInfo.title),
                        author: cleanText(trackInfo.author),
                        length: typeof trackInfo.length === 'number' ? trackInfo.length : 0,
                        uri: trackInfo.uri ?? null
                    };
                    const best = getBestMatch(results, matchTarget);
                    const ordered = [];
                    if (best?.info?.uri) {
                        const bestCandidate = results.find((item) => item.info.uri === best.info.uri);
                        if (bestCandidate)
                            ordered.push(bestCandidate);
                    }
                    for (const item of results) {
                        if (!best || item.info.uri !== best.info.uri)
                            ordered.push(item);
                    }
                    candidates = ordered;
                }
            }
            if (!candidates.length) {
                return { loadType: 'empty', data: {} };
            }
            let body = null;
            let meaningUrl = null;
            let resolvedTrack = null;
            for (const candidate of candidates) {
                const letrasTrack = candidate.info;
                if (!letrasTrack?.uri || letrasTrack.sourceName !== 'letrasmus')
                    continue;
                const baseUrl = letrasTrack.uri.endsWith('/')
                    ? letrasTrack.uri
                    : `${letrasTrack.uri}/`;
                const url = `${baseUrl}significado.html`;
                const { body: fetchedBody, statusCode, error } = await http1makeRequest(url, { method: 'GET' });
                if (error || statusCode !== 200 || typeof fetchedBody !== 'string')
                    continue;
                const meaningCheck = extractMeaning(fetchedBody);
                if (!meaningCheck.body.length)
                    continue;
                body = fetchedBody;
                meaningUrl = url;
                resolvedTrack = letrasTrack;
                break;
            }
            if (!body || !meaningUrl || !resolvedTrack) {
                return { loadType: 'empty', data: {} };
            }
            const meaning = extractMeaning(body);
            const omq = extractOmqLyric(body);
            const meaningMeta = extractOmqMeaning(body);
            const ogImage = extractMeta(body, 'og:image');
            const ogTitle = extractMeta(body, 'og:title');
            const ogDescription = extractMeta(body, 'og:description');
            let translated = null;
            if (language) {
                const sourceLang = 'pt';
                try {
                    const translatedParagraphsRaw = await translateMany(meaning.body.map((value) => decodeHtml(value)), sourceLang, language);
                    const translatedParagraphs = Array.isArray(translatedParagraphsRaw)
                        ? translatedParagraphsRaw.map((value) => String(value))
                        : [];
                    const translatedTitleResult = meaning.title
                        ? await translateText(decodeHtml(meaning.title), sourceLang, language)
                        : null;
                    const translatedDescriptionResult = ogDescription
                        ? await translateText(decodeHtml(ogDescription), sourceLang, language)
                        : null;
                    translated = {
                        language: {
                            source: sourceLang,
                            target: language
                        },
                        title: getTranslationText(translatedTitleResult),
                        description: getTranslationText(translatedDescriptionResult),
                        paragraphs: translatedParagraphs
                    };
                }
                catch (e) {
                    logger('warn', 'Meaning', `Translate failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (!meaning.body.length) {
                return { loadType: 'empty', data: {} };
            }
            return {
                loadType: 'meaning',
                data: {
                    title: meaning.title || ogTitle || null,
                    description: ogDescription || null,
                    paragraphs: meaning.body,
                    translation: translated,
                    url: meaningUrl,
                    type: 'track',
                    meaningMeta: {
                        id: meaningMeta?.ID || null,
                        localeId: meaningMeta?.LocaleID || null,
                        origin: meaningMeta?.Origin || null,
                        submittedBy: null,
                        reviewedBy: null
                    },
                    song: {
                        title: omq?.Name || resolvedTrack.title || null,
                        artist: omq?.Artist || resolvedTrack.author || null,
                        youtubeId: omq?.YoutubeID || null,
                        letrasId: omq?.ID || null,
                        artworkUrl: ogImage || null
                    }
                }
            };
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            logger('error', 'Meaning', `Letras meaning error: ${message}`);
            return {
                loadType: 'error',
                data: { message, severity: 'fault' }
            };
        }
    }
}
