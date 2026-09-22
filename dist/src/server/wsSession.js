import { logger } from '../utils.js';
/* INFO: Formats human-readable client name and version tag for logs */
function _formatClientTag(clientInfo) {
    const version = clientInfo.version
        ? `/\x1b[32mv${clientInfo.version}\x1b[0m`
        : '';
    return `\x1b[36m${clientInfo.name}\x1b[0m${version}`;
}
/* INFO: Handles socket disconnect: pauses session if resuming is enabled, or terminates session */
function _attachDisconnectHandler(context, socket, sessionId, clientInfo) {
    socket.on('close', (...args) => {
        const session = context.sessions.get(sessionId);
        if (!session)
            return;
        const code = typeof args[0] === 'number' ? args[0] : 1000;
        const reason = typeof args[1] === 'string' ? args[1] : 'none';
        logger('info', 'Server', `${_formatClientTag(clientInfo)} disconnected (code: ${code}, reason: ${reason})`);
        if (session.resuming) {
            context.sessions.pause(sessionId);
        }
        else {
            context.sessions.shutdown(sessionId);
        }
        context.statsManager.setWebsocketConnections(context.sessions.activeCount);
    });
}
/* INFO: Wraps socket message/close listeners with custom interceptors and plugin hooks */
function _setupSocketInterceptors(context, socket, clientInfo) {
    const originalOn = socket.on.bind(socket);
    socket.on = (event, listener) => {
        if (event === 'message') {
            return originalOn(event, async (...args) => {
                const raw = args[0];
                let parsed;
                try {
                    const text = typeof raw === 'string' ? raw : raw.toString();
                    parsed = JSON.parse(text);
                }
                catch {
                    parsed = raw;
                }
                /* INFO: Execute custom WebSocket interceptors pipeline */
                const interceptors = context.extensions.wsInterceptors;
                for (const interceptor of interceptors) {
                    const handled = await interceptor(context, socket, parsed, clientInfo);
                    if (handled === true)
                        return;
                }
                context.pluginManager.callHook('onWebSocketMessage', socket, parsed, socket.guildId);
                listener(...args);
            });
        }
        if (event === 'close') {
            return originalOn(event, (...args) => {
                context.pluginManager.callHook('onWebSocketClose', socket, args[0], args[1]);
                listener(...args);
            });
        }
        return originalOn(event, listener);
    };
}
/* INFO: Synchronizes resumed player states either through cluster workers or direct update */
function _syncResumedPlayers(context, session) {
    for (const [playerKey, playerInfo] of session.players.players.entries()) {
        if (context.workerManager) {
            const worker = context.workerManager.getWorkerForGuild(playerKey);
            if (worker) {
                context.workerManager.execute(worker, 'playerCommand', {
                    sessionId: session.id,
                    guildId: playerInfo.guildId,
                    command: 'forceUpdate',
                    args: []
                });
            }
        }
        else {
            playerInfo._sendUpdate();
        }
    }
}
/* INFO: Resumes an existing paused session, flushes queued events and synchronizes players */
function _resumeSession(context, socket, clientInfo, oldSessionId) {
    const session = context.sessions.resume(oldSessionId, socket);
    if (!session)
        return false;
    logger('info', 'Server', `${_formatClientTag(clientInfo)} resumed session: ${oldSessionId}`);
    context.statsManager.incrementSessionResume(clientInfo.name, true);
    _attachDisconnectHandler(context, socket, oldSessionId, clientInfo);
    socket.send(JSON.stringify({
        op: 'ready',
        resumed: true,
        sessionId: oldSessionId
    }));
    /* INFO: Flush all events that occurred while the client was disconnected */
    for (const event of session.eventQueue) {
        socket.send(event);
    }
    session.eventQueue.length = 0;
    _syncResumedPlayers(context, session);
    return true;
}
/* INFO: Creates a fresh session for a newly connected client */
function _createNewSession(context, socket, request, clientInfo) {
    const sessionId = context.sessions.create(request, socket, clientInfo);
    _attachDisconnectHandler(context, socket, sessionId, clientInfo);
    socket.send(JSON.stringify({
        op: 'ready',
        resumed: false,
        sessionId
    }));
}
/* INFO: Top-level handler for incoming gateway WebSocket client connections */
function handleClientWebSocket(context, socket, request, clientInfo, oldSessionId) {
    context.pluginManager.callHook('onWebSocketConnect', socket, clientInfo, oldSessionId);
    _setupSocketInterceptors(context, socket, clientInfo);
    const wasResumed = oldSessionId
        ? _resumeSession(context, socket, clientInfo, oldSessionId)
        : false;
    if (!wasResumed) {
        if (oldSessionId) {
            logger('warn', 'Server', `Session-ID "${oldSessionId}" from ${clientInfo.name} is invalid or expired. Creating new session.`);
        }
        _createNewSession(context, socket, request, clientInfo);
    }
    context.statsManager.setWebsocketConnections(context.sessions.activeCount);
}
export { handleClientWebSocket };
