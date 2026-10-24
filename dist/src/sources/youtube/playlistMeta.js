const HTML_ENTITIES = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&#x27;': "'",
    '&lt;': '<',
    '&gt;': '>'
};
/** Decodes the handful of entities YouTube emits inside meta attributes. */
function decodeHtmlEntities(value) {
    return value.replace(/&(?:amp|quot|#39|#x27|lt|gt);/g, (entity) => HTML_ENTITIES[entity] ?? entity);
}
/**
 * Reads `og:image` from the page and returns a clean URL.
 * `days_since_epoch` is a cache-buster that changes daily, so it is dropped to
 * keep the URL stable between requests.
 */
function extractThumbnail(html) {
    const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
    for (const tag of metaTags) {
        if (!/\bproperty=["']og:image["']/i.test(tag))
            continue;
        const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
        if (!content)
            continue;
        // Edit the query string by hand: round-tripping through URLSearchParams
        // would re-encode characters such as the trailing `=` in `sqp=...=`.
        return decodeHtmlEntities(content)
            .replace(/([?&])days_since_epoch=[^&#]*&?/, '$1')
            .replace(/[?&]$/, '');
    }
    return '';
}
/**
 * Depth-first search for the first object stored under `key`.
 * Iterative so a deeply nested `ytInitialData` cannot overflow the stack.
 */
function findKey(root, key) {
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node || typeof node !== 'object')
            continue;
        const record = node;
        if (key in record && record[key] && typeof record[key] === 'object') {
            return record[key];
        }
        for (const value of Object.values(record)) {
            if (value && typeof value === 'object')
                stack.push(value);
        }
    }
    return undefined;
}
/** Joins the text of a YouTube `{ runs: [...] }` / `{ simpleText }` object. */
function textOf(value) {
    if (!value || typeof value !== 'object')
        return '';
    const text = value;
    if (typeof text.simpleText === 'string')
        return text.simpleText;
    if (Array.isArray(text.runs)) {
        return text.runs
            .map((run) => (typeof run?.text === 'string' ? run.text : ''))
            .join('');
    }
    return '';
}
/**
 * Reads the playlist owner from `ytInitialData`.
 *
 * Tries the classic sidebar layout first
 * (`playlistSidebarSecondaryInfoRenderer.videoOwner.videoOwnerRenderer.title`),
 * then the newer `playlistHeaderRenderer.ownerText`.
 */
function extractAuthor(html) {
    const match = html.match(/ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!match?.[1])
        return '';
    let data;
    try {
        data = JSON.parse(match[1]);
    }
    catch {
        return '';
    }
    const sidebar = findKey(data, 'playlistSidebarSecondaryInfoRenderer');
    const fromSidebar = textOf(sidebar?.videoOwner?.videoOwnerRenderer?.title);
    if (fromSidebar)
        return fromSidebar.trim();
    const header = findKey(data, 'playlistHeaderRenderer');
    return textOf(header?.ownerText).trim();
}
/**
 * Extracts the author and thumbnail from the HTML of a YouTube playlist page.
 * Never throws; missing values come back as empty strings.
 * @param html - Raw HTML of `https://www.youtube.com/playlist?list=...`.
 */
export function parsePlaylistMeta(html) {
    return {
        author: extractAuthor(html),
        thumbnail: extractThumbnail(html)
    };
}
