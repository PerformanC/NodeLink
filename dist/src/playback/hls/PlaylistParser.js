/**
 * Parses an HLS playlist content.
 *
 * @param content - The playlist string content.
 * @param baseUrl - The base URL for resolving relative URIs.
 * @returns A parsed HLS playlist (Master or Media).
 * @throws Error if the format is invalid.
 * @public
 */
export function parse(content, baseUrl) {
    if (!content.includes('#EXT')) {
        throw new Error('Invalid HLS playlist format');
    }
    const lines = content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
        const { variants, audioGroups } = parseMaster(lines, baseUrl);
        return { isMaster: true, variants, audioGroups };
    }
    const result = {
        isMaster: false,
        mediaSequence: 0,
        targetDuration: 5,
        isLive: !content.includes('#EXT-X-ENDLIST'),
        segments: []
    };
    let currentKey = null;
    let currentMap = null;
    let mediaSequence = 0;
    let lastByteRange = null;
    for (const line of lines) {
        if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            const parts = line.split(':');
            if (parts[1])
                mediaSequence = parseInt(parts[1], 10);
            result.mediaSequence = mediaSequence;
        }
        else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
            const parts = line.split(':');
            if (parts[1])
                result.targetDuration = parseFloat(parts[1]);
        }
    }
    let segmentIndex = 0;
    let pendingDiscontinuity = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined)
            continue;
        if (line.startsWith('#EXT-X-DISCONTINUITY')) {
            pendingDiscontinuity = true;
        }
        else if (line.startsWith('#EXT-X-KEY:')) {
            currentKey = parseAttributes(line, baseUrl);
        }
        else if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parseAttributes(line, baseUrl);
            currentMap = {
                uri: typeof attrs.uri === 'string' ? attrs.uri : undefined,
                byteRange: typeof attrs.byterange === 'string'
                    ? parseByteRange(attrs.byterange, null)
                    : null
            };
        }
        else if (line.startsWith('#EXTINF:')) {
            const parts = line.split(':');
            const part1 = parts[1];
            if (!part1)
                continue;
            const duration = parseFloat(part1.split(',')[0] || '0');
            let j = i + 1;
            while (j < lines.length) {
                const nextLine = lines[j];
                if (nextLine === undefined || !nextLine.startsWith('#'))
                    break;
                if (nextLine.startsWith('#EXT-X-BYTERANGE:')) {
                    lastByteRange = parseByteRange(nextLine, lastByteRange);
                }
                j++;
            }
            if (j < lines.length) {
                const segmentUrl = lines[j];
                if (segmentUrl) {
                    result.segments.push({
                        url: new URL(segmentUrl, baseUrl).toString(),
                        duration,
                        key: currentKey,
                        map: currentMap,
                        byteRange: lastByteRange,
                        sequence: mediaSequence + segmentIndex,
                        discontinuity: pendingDiscontinuity
                    });
                    segmentIndex++;
                    lastByteRange = null;
                    pendingDiscontinuity = false;
                    i = j;
                }
            }
        }
    }
    return result;
}
/**
 * Parses a master playlist.
 *
 * @param lines - Array of playlist lines.
 * @param baseUrl - Base URL for relative URIs.
 * @returns Variants and audio groups.
 * @internal
 */
export function parseMaster(lines, baseUrl) {
    const variants = [];
    const audioGroups = {};
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined)
            continue;
        if (line.startsWith('#EXT-X-MEDIA:')) {
            const attrs = parseAttributes(line, baseUrl);
            const type = attrs.type;
            const groupid = attrs.groupid;
            if (type === 'AUDIO' && typeof groupid === 'string') {
                if (!audioGroups[groupid])
                    audioGroups[groupid] = [];
                audioGroups[groupid].push(attrs);
            }
        }
        else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const attrLine = line;
            const urlLine = lines[++i];
            if (!urlLine)
                break;
            const attrs = parseAttributes(attrLine, baseUrl);
            variants.push({
                url: new URL(urlLine, baseUrl).toString(),
                bandwidth: parseInt(attrs.bandwidth || '0', 10),
                codecs: attrs.codecs || '',
                audio: attrs.audio || undefined
            });
        }
    }
    return {
        variants: variants.sort((a, b) => b.bandwidth - a.bandwidth),
        audioGroups
    };
}
/**
 * Parses attributes from a playlist tag line.
 *
 * @param line - The tag line.
 * @param baseUrl - Base URL for relative URIs.
 * @returns A record of attributes.
 * @internal
 */
export function parseAttributes(line, baseUrl) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
    let match = regex.exec(line);
    while (match !== null) {
        const key = match[1]?.toLowerCase().replace(/-/g, '');
        if (key) {
            const value = match[2] || match[3];
            attrs[key] = value;
        }
        match = regex.exec(line);
    }
    const uri = attrs.uri;
    if (typeof uri === 'string') {
        attrs.uri = new URL(uri, baseUrl).toString();
    }
    const iv = attrs.iv;
    if (iv && typeof iv === 'string' && iv.startsWith('0x')) {
        attrs.iv = Buffer.from(iv.substring(2), 'hex');
    }
    return attrs;
}
/**
 * Parses an EXT-X-BYTERANGE tag.
 *
 * @param line - The tag line.
 * @param lastRange - The previous byte range for offset derivation.
 * @returns The parsed byte range.
 * @internal
 */
export function parseByteRange(line, lastRange) {
    const match = line.match(/:?(\d+)(?:@(\d+))?/);
    if (!match)
        return null;
    const lenStr = match[1];
    if (!lenStr)
        return null;
    const length = parseInt(lenStr, 10);
    const offsetStr = match[2];
    let offset = offsetStr ? parseInt(offsetStr, 10) : null;
    if (offset === null && lastRange)
        offset = lastRange.offset + lastRange.length;
    return { length, offset: offset || 0 };
}
export default {
    parse,
    parseMaster,
    parseAttributes,
    parseByteRange
};
