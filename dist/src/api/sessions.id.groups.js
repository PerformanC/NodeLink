import { decodeTrack, logger, sendErrorResponse } from '../utils.js';
function isObjectRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function getGroupsRouteRuntime(nodelink) {
    const runtime = nodelink;
    if (!runtime.sessions || typeof runtime.sessions.get !== 'function') {
        return null;
    }
    return runtime;
}
function getPathParams(parsedUrl) {
    const parts = parsedUrl.pathname.split('/');
    const sessionId = parts[3];
    const groupId = parts[5];
    if (!sessionId) {
        return null;
    }
    return groupId && groupId !== '' ? { sessionId, groupId } : { sessionId };
}
function normalizeTrackInfo(decodedTrack) {
    return {
        ...decodedTrack.info,
        uri: decodedTrack.info.uri ?? '',
        artworkUrl: decodedTrack.info.artworkUrl ?? null,
        isrc: decodedTrack.info.isrc ?? null
    };
}
function getAudioTrackId(trackPayload) {
    return trackPayload.language ?? trackPayload.audioTrackId ?? undefined;
}
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
    if (isObjectRecord(payload.ducking)) {
        const duckingInput = payload.ducking;
        safe.ducking = {
            enabled: duckingInput.enabled === true,
            duration: typeof duckingInput.duration === 'number' &&
                Number.isFinite(duckingInput.duration)
                ? Math.max(0, duckingInput.duration)
                : 500,
            targetVolume: typeof duckingInput.targetVolume === 'number' &&
                Number.isFinite(duckingInput.targetVolume)
                ? Math.max(0, Math.min(1, duckingInput.targetVolume))
                : 0.3,
            curve: typeof duckingInput.curve === 'string' ? duckingInput.curve : 'linear'
        };
    }
    return safe;
}
function getGroupCreatePayload(body) {
    if (!isObjectRecord(body))
        return null;
    const payload = body;
    const id = payload.id;
    if (typeof id !== 'string' || id.length === 0)
        return null;
    const guildIds = payload.guildIds;
    if (guildIds !== undefined) {
        if (!Array.isArray(guildIds))
            return null;
        for (const gid of guildIds) {
            if (typeof gid !== 'string' || !/^\d{17,20}$/.test(gid))
                return null;
        }
    }
    return {
        id: id,
        guildIds: guildIds ?? []
    };
}
function getGroupPatchPayload(body) {
    if (!isObjectRecord(body))
        return null;
    const payload = body;
    const result = {};
    if (payload.players !== undefined) {
        if (!isObjectRecord(payload.players))
            return null;
        const p = payload.players;
        const players = {};
        if (p.add !== undefined) {
            if (!Array.isArray(p.add))
                return null;
            for (const gid of p.add) {
                if (typeof gid !== 'string' || !/^\d{17,20}$/.test(gid))
                    return null;
            }
            players.add = p.add;
        }
        if (p.remove !== undefined) {
            if (!Array.isArray(p.remove))
                return null;
            for (const gid of p.remove) {
                if (typeof gid !== 'string')
                    return null;
            }
            players.remove = p.remove;
        }
        result.players = players;
    }
    if (payload.track !== undefined) {
        if (payload.track !== null && !isObjectRecord(payload.track))
            return null;
        result.track = payload.track;
    }
    if (payload.position !== undefined) {
        if (typeof payload.position !== 'number' ||
            !Number.isFinite(payload.position) ||
            payload.position < 0)
            return null;
        result.position = payload.position;
    }
    if (payload.endTime !== undefined) {
        if (payload.endTime !== null &&
            (typeof payload.endTime !== 'number' ||
                !Number.isFinite(payload.endTime) ||
                payload.endTime < 0))
            return null;
        result.endTime = payload.endTime;
    }
    if (payload.volume !== undefined) {
        if (typeof payload.volume !== 'number' ||
            !Number.isFinite(payload.volume) ||
            payload.volume < 0 ||
            payload.volume > 1000)
            return null;
        result.volume = payload.volume;
    }
    if (payload.paused !== undefined) {
        if (typeof payload.paused !== 'boolean')
            return null;
        result.paused = payload.paused;
    }
    if (payload.filters !== undefined) {
        if (!payload.filters ||
            typeof payload.filters !== 'object' ||
            Array.isArray(payload.filters))
            return null;
        result.filters = payload.filters;
    }
    if (payload.fading !== undefined) {
        if (!payload.fading ||
            typeof payload.fading !== 'object' ||
            Array.isArray(payload.fading))
            return null;
        result.fading = payload.fading;
    }
    if (payload.loudnessNormalizer !== undefined) {
        if (typeof payload.loudnessNormalizer !== 'boolean')
            return null;
        result.loudnessNormalizer = payload.loudnessNormalizer;
    }
    if (payload.ducking !== undefined) {
        if (typeof payload.ducking !== 'boolean')
            return null;
        result.ducking = payload.ducking;
    }
    return result;
}
async function applyGroupPatch(runtime, session, groupId, payload) {
    const groups = session.groups;
    if (!groups.has(groupId)) {
        throw new Error(`Group '${groupId}' not found`);
    }
    if (payload.players?.add) {
        for (const guildId of payload.players.add) {
            groups.addPlayer(groupId, guildId);
        }
    }
    if (payload.players?.remove) {
        for (const guildId of payload.players.remove) {
            groups.removePlayer(groupId, guildId);
        }
    }
    const guildIds = groups.getGuildIds(groupId);
    let trackToPlay;
    if (payload.track !== undefined) {
        trackToPlay = await resolvePlayPayload(runtime, payload.track);
    }
    const errors = [];
    const playerStates = [];
    for (const guildId of guildIds) {
        try {
            await session.players.create(guildId);
            if (trackToPlay === null) {
                await session.players.stop(guildId);
            }
            else if (trackToPlay) {
                await session.players.play(guildId, {
                    ...trackToPlay,
                    userData: payload.track?.userData,
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
            if (payload.position !== undefined && trackToPlay === undefined) {
                await session.players.seek(guildId, payload.position);
            }
            if (payload.endTime !== undefined && trackToPlay === undefined) {
                const playerState = await session.players.toJSON(guildId);
                await session.players.seek(guildId, playerState.state.position, payload.endTime ?? undefined);
            }
            if (payload.filters !== undefined) {
                await session.players.setFilters(guildId, payload.filters);
            }
            if (payload.fading !== undefined) {
                await session.players.setFading(guildId, sanitizeFadingConfig(payload.fading));
            }
            if (payload.loudnessNormalizer !== undefined) {
                await session.players.setLoudnessNormalizer(guildId, payload.loudnessNormalizer);
            }
            if (payload.ducking !== undefined) {
                await session.players.setDucking(guildId, payload.ducking);
            }
            const state = await session.players.toJSON(guildId);
            playerStates.push(state);
            await new Promise((resolve) => setTimeout(resolve, 35));
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger('error', 'GroupUpdate', `Failed to apply patch to guild ${guildId} in group '${groupId}': ${message}`);
            errors.push({ guildId, error: message });
        }
    }
    const groupJson = groups.toJSON(groupId);
    return {
        ...groupJson,
        players: playerStates,
        ...(errors.length > 0 ? { errors } : {})
    };
}
/**
 * Handles requests for the groups route.
 *
 * Supports:
 * - `GET /sessions/:id/groups` — list all groups
 * - `GET /sessions/:id/groups/:groupId` — get specific group
 * - `POST /sessions/:id/groups` — create a new group
 * - `PATCH /sessions/:id/groups/:groupId` — update group (membership + orchestration)
 * - `DELETE /sessions/:id/groups/:groupId` — delete group (does not destroy players)
 */
async function handler(nodelink, req, res, sendResponse, parsedUrl) {
    const runtime = getGroupsRouteRuntime(nodelink);
    if (!runtime) {
        sendErrorResponse(req, res, 500, 'Internal Server Error', 'Groups runtime contract is incomplete.', parsedUrl.pathname, true);
        return;
    }
    const pathParams = getPathParams(parsedUrl);
    if (!pathParams) {
        sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid path parameters', parsedUrl.pathname);
        return;
    }
    const session = runtime.sessions.get(pathParams.sessionId);
    if (!session) {
        sendErrorResponse(req, res, 404, 'Not Found', "The provided sessionId doesn't exist.", parsedUrl.pathname);
        return;
    }
    try {
        if (!pathParams.groupId) {
            if (req.method === 'GET') {
                sendResponse(req, res, session.groups.list(), 200);
                return;
            }
            if (req.method === 'POST') {
                const payload = getGroupCreatePayload(req.body);
                if (!payload) {
                    sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid group creation payload. Required: { id: string, guildIds?: string[] }', parsedUrl.pathname);
                    return;
                }
                session.groups.create(payload.id, payload.guildIds);
                sendResponse(req, res, session.groups.toJSON(payload.id), 201);
                return;
            }
            sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
            return;
        }
        if (req.method === 'GET') {
            const group = session.groups.toJSON(pathParams.groupId);
            if (!group) {
                sendErrorResponse(req, res, 404, 'Not Found', `Group '${pathParams.groupId}' not found.`, parsedUrl.pathname);
                return;
            }
            sendResponse(req, res, group, 200);
            return;
        }
        if (req.method === 'DELETE') {
            if (!session.groups.has(pathParams.groupId)) {
                sendErrorResponse(req, res, 404, 'Not Found', `Group '${pathParams.groupId}' not found.`, parsedUrl.pathname);
                return;
            }
            session.groups.delete(pathParams.groupId);
            sendResponse(req, res, null, 204);
            return;
        }
        if (req.method === 'PATCH') {
            if (!session.groups.has(pathParams.groupId)) {
                sendErrorResponse(req, res, 404, 'Not Found', `Group '${pathParams.groupId}' not found.`, parsedUrl.pathname);
                return;
            }
            const payload = getGroupPatchPayload(req.body);
            if (!payload) {
                sendErrorResponse(req, res, 400, 'Bad Request', 'Invalid group patch payload.', parsedUrl.pathname);
                return;
            }
            const result = await applyGroupPatch(runtime, session, pathParams.groupId, payload);
            sendResponse(req, res, result, 200);
            return;
        }
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unhandled group error';
        if (errorMessage.includes('not found') ||
            errorMessage.includes('already exists')) {
            const status = errorMessage.includes('already exists') ? 409 : 404;
            sendErrorResponse(req, res, status, status === 409 ? 'Conflict' : 'Not Found', errorMessage, parsedUrl.pathname);
            return;
        }
        logger('error', 'GroupUpdate', `Unhandled error: ${errorMessage}`, error);
        sendErrorResponse(req, res, 500, 'Internal Server Error', errorMessage, parsedUrl.pathname, true);
        return;
    }
    sendErrorResponse(req, res, 405, 'Method Not Allowed', 'Method Not Allowed', parsedUrl.pathname);
}
/**
 * Route module definition for the groups route.
 */
const groupsRoute = {
    handler,
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
};
export default groupsRoute;
