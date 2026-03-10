import { decodeTrack, logger, sendErrorResponse } from "../utils.js";
/**
 * Validates that a value is a non-array object.
 *
 * @param value - Candidate object value.
 * @returns `true` when the value is a plain object-like value.
 */
function isObjectRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Builds a strongly typed runtime view for the player route.
 *
 * @param nodelink - Router-facing runtime instance.
 * @returns Runtime compatible with the route, or `null` when the required
 * session manager field is unavailable.
 */
function getPlayersRouteRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.sessions ||
        typeof runtime.sessions.get !== 'function' ||
        runtime.workerManager === undefined) {
        return null;
    }
    return runtime;
}
/**
 * Extracts and validates the dynamic route parameters.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Validated path parameters, or `null` when validation fails.
 */
function getPathParams(parsedUrl) {
    const parts = parsedUrl.pathname.split('/');
    const sessionId = parts[3];
    const guildId = parts[5];
    if (!sessionId) {
        return null;
    }
    if (guildId !== undefined && guildId !== '' && !/^\d{17,20}$/.test(guildId)) {
        return null;
    }
    return guildId
        ? { sessionId, guildId }
        : {
            sessionId
        };
}
/**
 * Parses the `noReplace` query parameter.
 *
 * @param parsedUrl - Parsed request URL.
 * @returns Parsed query state, or `null` when the query value is invalid.
 */
function getQueryParams(parsedUrl) {
    const noReplaceRaw = parsedUrl.searchParams.get('noReplace');
    if (noReplaceRaw === null) {
        return {};
    }
    if (noReplaceRaw === 'true') {
        return { noReplace: true };
    }
    if (noReplaceRaw === 'false') {
        return { noReplace: false };
    }
    return null;
}
/**
 * Parses and validates a voice state payload.
 *
 * @param value - Candidate voice payload.
 * @returns Valid voice payload, or `null` when validation fails.
 */
function getVoicePayload(value) {
    if (!isObjectRecord(value)) {
        return null;
    }
    const payload = value;
    const { token, endpoint, sessionId, channelId } = payload;
    if (typeof token !== 'string' || token.length === 0) {
        return null;
    }
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
        return null;
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return null;
    }
    if (channelId !== undefined &&
        channelId !== null &&
        typeof channelId !== 'string') {
        return null;
    }
    return {
        token,
        endpoint,
        sessionId,
        channelId: typeof channelId === 'string' ? channelId : undefined
    };
}
/**
 * Parses and validates a track update payload.
 *
 * @param value - Candidate track payload.
 * @param allowNullEncoded - Whether `encoded: null` is accepted.
 * @returns Valid track payload, `undefined` when absent, or `null` when invalid.
 */
function getTrackUpdateInput(value, allowNullEncoded) {
    if (value === undefined) {
        return undefined;
    }
    if (value === null) {
        return allowNullEncoded ? undefined : null;
    }
    if (!isObjectRecord(value)) {
        return null;
    }
    const payload = value;
    const { encoded, identifier, userData, audioTrackId, language } = payload;
    if (encoded !== undefined &&
        encoded !== null &&
        typeof encoded !== 'string') {
        return null;
    }
    if (encoded === null && !allowNullEncoded) {
        return null;
    }
    if (identifier !== undefined && typeof identifier !== 'string') {
        return null;
    }
    if (audioTrackId !== undefined &&
        audioTrackId !== null &&
        typeof audioTrackId !== 'string') {
        return null;
    }
    if (language !== undefined &&
        language !== null &&
        typeof language !== 'string') {
        return null;
    }
    return {
        encoded: encoded,
        identifier: typeof identifier === 'string' ? identifier : undefined,
        userData,
        audioTrackId: typeof audioTrackId === 'string' ? audioTrackId : undefined,
        language: typeof language === 'string' ? language : undefined
    };
}
/**
 * Parses and validates the player patch payload.
 *
 * @param body - Parsed request body.
 * @returns Valid payload object, or `null` when validation fails.
 */
function getPlayerPatchPayload(body) {
    if (!isObjectRecord(body)) {
        return null;
    }
    const payload = body;
    const track = getTrackUpdateInput(payload.track, true);
    if (track === null) {
        return null;
    }
    let nextTrack;
    if (payload.nextTrack === null) {
        nextTrack = null;
    }
    else {
        const parsedNextTrack = getTrackUpdateInput(payload.nextTrack, true);
        if (parsedNextTrack === null) {
            return null;
        }
        nextTrack = parsedNextTrack;
    }
    const encodedTrack = payload.encodedTrack;
    if (encodedTrack !== undefined &&
        encodedTrack !== null &&
        typeof encodedTrack !== 'string') {
        return null;
    }
    const position = payload.position;
    if (position !== undefined &&
        (typeof position !== 'number' || !Number.isFinite(position) || position < 0)) {
        return null;
    }
    const endTime = payload.endTime;
    if (endTime !== undefined &&
        endTime !== null &&
        (typeof endTime !== 'number' || !Number.isFinite(endTime) || endTime < 0)) {
        return null;
    }
    const volume = payload.volume;
    if (volume !== undefined &&
        (typeof volume !== 'number' ||
            !Number.isFinite(volume) ||
            volume < 0 ||
            volume > 1000)) {
        return null;
    }
    const paused = payload.paused;
    if (paused !== undefined && typeof paused !== 'boolean') {
        return null;
    }
    const loudnessNormalizer = payload.loudnessNormalizer;
    if (loudnessNormalizer !== undefined &&
        typeof loudnessNormalizer !== 'boolean') {
        return null;
    }
    const filtersValue = payload.filters;
    if (filtersValue !== undefined &&
        (!filtersValue ||
            typeof filtersValue !== 'object' ||
            Array.isArray(filtersValue))) {
        return null;
    }
    const fading = payload.fading;
    if (fading !== undefined &&
        (!fading || typeof fading !== 'object' || Array.isArray(fading))) {
        return null;
    }
    const crossfade = payload.crossfade;
    if (crossfade !== undefined &&
        (!crossfade || typeof crossfade !== 'object' || Array.isArray(crossfade))) {
        return null;
    }
    const voice = payload.voice === undefined ? undefined : getVoicePayload(payload.voice);
    if (payload.voice !== undefined && !voice) {
        return null;
    }
    return {
        track,
        nextTrack,
        encodedTrack: typeof encodedTrack === 'string'
            ? encodedTrack
            : encodedTrack === null
                ? null
                : undefined,
        position,
        endTime: typeof endTime === 'number'
            ? endTime
            : endTime === null
                ? null
                : undefined,
        volume,
        paused,
        loudnessNormalizer,
        filters: filtersValue,
        fading,
        crossfade,
        voice: voice ?? undefined
    };
}
/**
 * Sanitizes the fading configuration to the runtime-supported shape.
 *
 * @param raw - Raw fading payload.
 * @returns Safe fading configuration object.
 */
function sanitizeFadingConfig(raw) {
    const safe = {
        enabled: false,
        trackStart: { duration: 0, curve: 'linear', type: 'volume' },
        trackEnd: { duration: 0, curve: 'linear', type: 'volume' },
        trackStop: { duration: 0, curve: 'linear', type: 'volume' },
        seek: { duration: 0, curve: 'linear', type: 'volume' },
        pause: { duration: 0, curve: 'linear', type: 'volume' },
        resume: { duration: 0, curve: 'linear', type: 'volume' }
    };
    if (!isObjectRecord(raw)) {
        return safe;
    }
    const payload = raw;
    safe.enabled = payload.enabled === true;
    const updateSection = (key) => {
        const section = payload[key];
        const target = safe[key];
        if (!isObjectRecord(section) || !target) {
            return;
        }
        const typedSection = section;
        const { duration, curve, type } = typedSection;
        if (typeof duration === 'number' && Number.isFinite(duration)) {
            target.duration = Math.max(0, duration);
        }
        if (typeof curve === 'string') {
            target.curve = curve;
        }
        if (type === 'volume' ||
            type === 'tape' ||
            type === 'scratch' ||
            type === 'both') {
            target.type = type;
        }
    };
    updateSection('trackStart');
    updateSection('trackEnd');
    updateSection('trackStop');
    updateSection('seek');
    updateSection('pause');
    updateSection('resume');
    return safe;
}
/**
 * Sanitizes the crossfade configuration to the runtime-supported shape.
 *
 * @param raw - Raw crossfade payload.
 * @returns Safe crossfade configuration object plus the route-only
 * `triggerNow` flag.
 */
function sanitizeCrossfadeConfig(raw) {
    const safe = {
        enabled: false,
        duration: 0,
        curve: 'sinusoidal',
        mode: 'preload',
        minBufferMs: 250,
        bufferMs: 0,
        triggerNow: false
    };
    if (!isObjectRecord(raw)) {
        return safe;
    }
    const payload = raw;
    safe.enabled = payload.enabled === true;
    const duration = payload.duration;
    if (typeof duration === 'number' && Number.isFinite(duration)) {
        safe.duration = Math.max(0, duration);
    }
    const curve = payload.curve;
    if (typeof curve === 'string') {
        safe.curve = curve;
    }
    const mode = payload.mode;
    if (mode === 'stream' || mode === 'preload') {
        safe.mode = mode;
    }
    const minBufferMs = payload.minBufferMs;
    if (typeof minBufferMs === 'number' && Number.isFinite(minBufferMs)) {
        safe.minBufferMs = Math.max(0, minBufferMs);
    }
    const bufferMs = payload.bufferMs;
    if (typeof bufferMs === 'number' && Number.isFinite(bufferMs)) {
        safe.bufferMs = Math.max(0, bufferMs);
    }
    safe.triggerNow = payload.triggerNow === true;
    return safe;
}
/**
 * Normalizes decoded track info into the stricter `TrackInfoExtended` shape
 * required by the player runtime.
 *
 * @param decodedTrack - Decoded track payload.
 * @returns Normalized track information.
 */
function normalizeTrackInfo(decodedTrack) {
    return {
        ...decodedTrack.info,
        uri: decodedTrack.info.uri ?? '',
        artworkUrl: decodedTrack.info.artworkUrl ?? null,
        isrc: decodedTrack.info.isrc ?? null
    };
}
/**
 * Resolves the optional audio track identifier override.
 *
 * @param trackPayload - Track update payload.
 * @returns Audio track identifier or `undefined` when absent.
 */
function getAudioTrackId(trackPayload) {
    return trackPayload.language ?? trackPayload.audioTrackId ?? undefined;
}
/**
 * Resolves a track update payload into a playable `PlayPayload`.
 *
 * @param nodelink - Players route runtime.
 * @param trackPayload - Track update payload.
 * @returns Resolved play payload, `null` when the track should stop playback,
 * or `undefined` when no track operation should occur.
 */
async function resolvePlayPayload(nodelink, trackPayload) {
    if (!trackPayload) {
        return undefined;
    }
    if (trackPayload.encoded !== undefined) {
        if (trackPayload.encoded === null) {
            return null;
        }
        const decodedTrack = decodeTrack(trackPayload.encoded.replace(/ /g, '+'));
        return {
            encoded: decodedTrack.encoded,
            info: normalizeTrackInfo(decodedTrack),
            audioTrackId: getAudioTrackId(trackPayload)
        };
    }
    if (trackPayload.identifier) {
        if (!nodelink.loadTrack) {
            throw new Error('Track identifier loading is not supported.');
        }
        const loadResult = await nodelink.loadTrack(trackPayload.identifier);
        if (loadResult.loadType !== 'track') {
            if (loadResult.loadType === 'empty') {
                throw new Error('Track identifier resolved to no tracks.');
            }
            throw new Error(`Track identifier resolved to ${loadResult.loadType}, expected 'track'.`);
        }
        return {
            encoded: loadResult.data.encoded,
            info: loadResult.data.info,
            audioTrackId: getAudioTrackId(trackPayload)
        };
    }
    return undefined;
}
/**
 * Resolves a track update payload into a preloadable `PlayerTrack`.
 *
 * @param nodelink - Players route runtime.
 * @param trackPayload - Track update payload.
 * @returns Resolved player track payload, or `undefined` when no preload
 * should occur.
 */
async function resolvePreloadPayload(nodelink, trackPayload) {
    if (!trackPayload) {
        return undefined;
    }
    if (trackPayload.encoded !== undefined) {
        if (trackPayload.encoded === null) {
            return undefined;
        }
        const decodedTrack = decodeTrack(trackPayload.encoded.replace(/ /g, '+'));
        return {
            encoded: decodedTrack.encoded,
            info: normalizeTrackInfo(decodedTrack),
            audioTrackId: getAudioTrackId(trackPayload),
            userData: trackPayload.userData
        };
    }
    if (trackPayload.identifier && nodelink.loadTrack) {
        const loadResult = await nodelink.loadTrack(trackPayload.identifier);
        if (loadResult.loadType === 'track') {
            return {
                encoded: loadResult.data.encoded,
                info: loadResult.data.info,
                audioTrackId: getAudioTrackId(trackPayload),
                userData: trackPayload.userData
            };
        }
    }
    return undefined;
}
/**
 * Handles `GET /sessions/:id/players`.
 *
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param session - Target session.
 * @param runtime - Players route runtime.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @returns Promise that resolves once the response has been written.
 */
async function handlePlayerListRequest(req, res, session, runtime, sendResponse) {
    if (runtime.workerManager) {
        const playerKeys = Array.from(runtime.workerManager.guildToWorker.keys());
        const sessionPlayerKeys = playerKeys.filter((key) => key.startsWith(`${session.id}:`));
        const guildIds = sessionPlayerKeys
            .map((key) => key.split(':')[1])
            .filter((guildId) => typeof guildId === 'string');
        const players = await Promise.all(guildIds.map(async (guildId) => {
            try {
                return await session.players.toJSON(guildId);
            }
            catch (error) {
                const errorMessage = error instanceof Error
                    ? error.message
                    : 'Unknown player listing error';
                logger('error', 'PlayerList', `Failed to get player JSON for guild ${guildId}: ${errorMessage}`);
                return null;
            }
        }));
        sendResponse(req, res, players.filter((playerJson) => playerJson !== null), 200);
        return;
    }
    const players = await Promise.all(Array.from(session.players.players.values()).map((player) => session.players.toJSON(player.guildId)));
    sendResponse(req, res, players, 200);
}
/**
 * Applies a player patch payload to the target guild player.
 *
 * @param runtime - Players route runtime.
 * @param session - Target session.
 * @param guildId - Target guild identifier.
 * @param payload - Validated patch payload.
 * @param query - Validated query parameters.
 * @returns Promise resolving to the updated player JSON payload.
 */
async function applyPlayerPatch(runtime, session, guildId, payload, query) {
    await session.players.create(guildId);
    if (payload.voice) {
        await session.players.updateVoice(guildId, payload.voice);
    }
    if (payload.encodedTrack) {
        throw new Error('The `encodedTrack` field is deprecated. Use `track.encoded` instead.');
    }
    const trackToPlay = await resolvePlayPayload(runtime, payload.track);
    const stopPlayer = trackToPlay === null;
    const shouldClearNextTrack = payload.nextTrack === null || payload.nextTrack?.encoded === null;
    if (shouldClearNextTrack) {
        await session.players.clearNextTrack(guildId);
    }
    else if (payload.nextTrack) {
        const trackToPreload = await resolvePreloadPayload(runtime, payload.nextTrack);
        if (trackToPreload) {
            await session.players.preload(guildId, trackToPreload);
        }
    }
    if (stopPlayer) {
        await session.players.stop(guildId);
    }
    if (trackToPlay && trackToPlay !== null) {
        await session.players.play(guildId, {
            ...trackToPlay,
            userData: payload.track?.userData,
            noReplace: query.noReplace,
            startTime: payload.position,
            endTime: payload.endTime ?? undefined
        });
    }
    if (payload.volume !== undefined) {
        await session.players.volume(guildId, payload.volume);
    }
    if (payload.paused !== undefined) {
        await session.players.pause(guildId, payload.paused);
    }
    if (payload.position !== undefined && !trackToPlay) {
        await session.players.seek(guildId, payload.position);
    }
    if (payload.endTime !== undefined) {
        const playerState = await session.players.toJSON(guildId);
        await session.players.seek(guildId, playerState.state.position, payload.endTime ?? undefined);
    }
    if (payload.filters !== undefined) {
        await session.players.setFilters(guildId, payload.filters);
    }
    if (payload.fading !== undefined) {
        await session.players.setFading(guildId, sanitizeFadingConfig(payload.fading));
    }
    if (payload.crossfade !== undefined) {
        const sanitizedCrossfade = sanitizeCrossfadeConfig(payload.crossfade);
        await session.players.setCrossfade(guildId, sanitizedCrossfade);
        if (sanitizedCrossfade.triggerNow) {
            const player = session.players.get(guildId);
            if (player?.triggerCrossfade) {
                const duration = typeof sanitizedCrossfade.duration === 'number' &&
                    Number.isFinite(sanitizedCrossfade.duration)
                    ? sanitizedCrossfade.duration
                    : undefined;
                await player.triggerCrossfade(duration);
            }
        }
    }
    if (payload.loudnessNormalizer !== undefined) {
        await session.players.setLoudnessNormalizer(guildId, payload.loudnessNormalizer);
    }
    return await session.players.toJSON(guildId);
}
/**
 * Handles requests for the players route.
 *
 * Supports:
 * - `GET /sessions/:id/players` to list players for a session
 * - `GET /sessions/:id/players/:guildId` to get player state
 * - `DELETE /sessions/:id/players/:guildId` to destroy a player
 * - `PATCH /sessions/:id/players/:guildId` to update player state
 *
 * @param nodelink - Router-facing NodeLink runtime.
 * @param req - Incoming HTTP request.
 * @param res - Outgoing HTTP response.
 * @param sendResponse - Helper responsible for JSON serialization and headers.
 * @param parsedUrl - Parsed request URL.
 * @returns Promise that resolves once the response has been written.
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getPlayersRouteRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Players runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const pathParams = getPathParams(parsedUrl);
    if (!pathParams) {
        const errorMessage = 'Invalid path parameters';
        logger('warn', 'PlayerUpdate', `Invalid path parameters: ${errorMessage}`);
        sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
        return;
    }
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", parsedUrl.pathname);
        return;
    }
    if (!pathParams.guildId) {
        if (req.method === 'GET') {
            await handlePlayerListRequest(req, res, session, runtime, sendResponse);
            return;
        }
        sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
        return;
    }
    try {
        if (req.method === 'GET') {
            await session.players.create(pathParams.guildId);
            sendResponse(req, res, await session.players.toJSON(pathParams.guildId), 200);
            return;
        }
        if (req.method === 'DELETE') {
            await session.players.destroy(pathParams.guildId);
            sendResponse(req, res, null, 204);
            return;
        }
        if (req.method === 'PATCH') {
            const payload = getPlayerPatchPayload(req.body);
            if (!payload) {
                const errorMessage = 'Invalid payload';
                logger('warn', 'PlayerUpdate', `Invalid payload for guild ${pathParams.guildId}: ${errorMessage}`);
                sendErrorResponse(req, res, 400, 'Bad Request', errorMessage, parsedUrl.pathname);
                return;
            }
            const query = getQueryParams(parsedUrl);
            if (!query) {
                sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid query parameters', parsedUrl.pathname);
                return;
            }
            const playerJson = await applyPlayerPatch(runtime, session, pathParams.guildId, payload, query);
            sendResponse(req, res, playerJson, 200);
            return;
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unhandled player error';
        if (errorMessage.toLowerCase().includes('player not found') ||
            errorMessage.toLowerCase().includes('player not assigned')) {
            sendErrorResponse(req, res, 404, 'Not Found', errorMessage, parsedUrl.pathname);
            return;
        }
        logger('error', 'PlayerUpdate', `Unhandled error: ${errorMessage}`, error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname, true);
        return;
    }
    sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
}
/**
 * Route module definition for the player route.
 */
const playersRoute = {
    handler,
    methods: ['GET', 'DELETE', 'PATCH']
};
export default playersRoute;
