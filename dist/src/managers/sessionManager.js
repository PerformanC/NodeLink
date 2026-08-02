import { generateRandomLetters, logger } from '../utils.js';
import GroupManager from './groupManager.js';
/**
 * Manages active and resumable WebSocket sessions for NodeLink.
 * Handles the full lifecycle of a session, including creation, pausing for resumption,
 * and destruction of sessions and their associated players.
 *
 * @public
 */
export default class SessionManager {
    /**
     * Reference to the main NodeLink server instance.
     */
    nodelink;
    /**
     * The constructor class used to instantiate new PlayerManagers for each session.
     */
    PlayerManagerClass;
    /**
     * A map of currently active sessions, keyed by their unique sessionId.
     */
    activeSessions;
    /**
     * A map of sessions that have been paused and are waiting to be resumed, keyed by sessionId.
     */
    resumableSessions;
    /**
     * Creates a new SessionManager.
     *
     * @param nodelink - The main NodeLink server instance.
     * @param PlayerManagerClass - The constructor for the PlayerManager.
     * @throws Error if PlayerManagerClass is not provided.
     */
    constructor(nodelink, PlayerManagerClass) {
        if (!PlayerManagerClass) {
            throw new Error('SessionManager requires a PlayerManagerClass instance');
        }
        this.nodelink = nodelink;
        this.PlayerManagerClass = PlayerManagerClass;
        this.activeSessions = new Map();
        this.resumableSessions = new Map();
    }
    /**
     * Creates a new session and registers it in the active sessions pool.
     *
     * @param request - The incoming HTTP/WebSocket upgrade request.
     * @param socket - The WebSocket connection instance.
     * @param clientInfo - Metadata about the connected client.
     * @returns The unique ID of the newly created session.
     */
    create(request, socket, clientInfo) {
        const sessionId = generateRandomLetters(16);
        logger('debug', 'SessionManager', `New session created with ID ${sessionId}`);
        const players = new this.PlayerManagerClass(this.nodelink, sessionId);
        const session = {
            id: sessionId,
            clientInfo,
            userId: request.headers['user-id'],
            socket,
            players,
            groups: new GroupManager(),
            resuming: false,
            timeout: 60,
            isPaused: false,
            eventQueue: [],
            timeoutFuture: null
        };
        this.activeSessions.set(sessionId, session);
        return sessionId;
    }
    /**
     * Retrieves a session by its ID from either the active or resumable pools.
     *
     * @param sessionId - The ID of the session to retrieve.
     * @returns The session object if found, otherwise undefined.
     */
    get(sessionId) {
        return (this.activeSessions.get(sessionId) ||
            this.resumableSessions.get(sessionId));
    }
    /**
     * Checks if a session exists in either the active or resumable pools.
     *
     * @param sessionId - The ID of the session to check.
     * @returns True if the session exists, false otherwise.
     */
    has(sessionId) {
        return (this.activeSessions.has(sessionId) ||
            this.resumableSessions.has(sessionId));
    }
    /**
     * Moves a session from the active pool to the resumable pool and starts the destruction timer.
     *
     * @param sessionId - The ID of the session to pause.
     */
    pause(sessionId) {
        // [feat] session-resuming: guard double-pause and clear stale socket
        if (this.resumableSessions.has(sessionId)) {
            logger('debug', 'SessionManager', `Session ${sessionId} is already paused.`);
            return;
        }
        const session = this.activeSessions.get(sessionId);
        if (!session)
            return;
        logger('info', 'SessionManager', `Pausing session ${sessionId} for resuming (timeout: ${session.timeout}s).`);
        this.activeSessions.delete(sessionId);
        session.isPaused = true;
        session.socket = null;
        this.resumableSessions.set(sessionId, session);
        session.timeoutFuture = setTimeout(() => {
            logger('info', 'SessionManager', `Session ${sessionId} resume timeout expired after ${session.timeout}s. Destroying.`);
            this.resumableSessions.delete(sessionId);
            void this.destroy(session);
        }, session.timeout * 1000);
    }
    /**
     * Resumes a paused session with a new WebSocket connection.
     *
     * @param sessionId - The ID of the session to resume.
     * @param newSocket - The new WebSocket connection instance.
     * @returns The resumed session object, or null if not found in the resumable pool.
     */
    resume(sessionId, newSocket) {
        const session = this.resumableSessions.get(sessionId);
        if (!session)
            return null;
        logger('info', 'SessionManager', `Resuming session ${sessionId}.`);
        this.resumableSessions.delete(sessionId);
        if (session.timeoutFuture) {
            clearTimeout(session.timeoutFuture);
            session.timeoutFuture = null;
        }
        session.socket = newSocket;
        session.isPaused = false;
        this.activeSessions.set(sessionId, session);
        return session;
    }
    /**
     * Destroys a session and all its associated players, cleaning up resources.
     *
     * @param session - The session object to destroy.
     */
    async destroy(session) {
        if (!session)
            return;
        if (session.timeoutFuture) {
            clearTimeout(session.timeoutFuture);
            session.timeoutFuture = null;
        }
        logger('debug', 'SessionManager', `Destroying session ${session.id} and its players.`);
        const { players } = session;
        if (this.nodelink.workerManager) {
            for (const player of players.players.values()) {
                try {
                    await players.destroy(player.guildId);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger('error', 'SessionManager', `Failed to destroy player for guild ${player.guildId} during session destruction: ${message}`);
                }
            }
        }
        else {
            for (const player of players.players.values()) {
                try {
                    player.destroy?.();
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger('error', 'SessionManager', `Failed to destroy player for guild ${player.guildId} during session destruction: ${message}`);
                }
            }
            players.players.clear();
        }
        session.groups.destroy();
        session.socket?.destroy?.();
    }
    /**
     * Shuts down an active session by its ID.
     *
     * @param sessionId - The ID of the session to shut down.
     */
    async shutdown(sessionId) {
        logger('debug', 'SessionManager', `Shutting down session ${sessionId}.`);
        const session = this.activeSessions.get(sessionId);
        if (session) {
            this.activeSessions.delete(sessionId);
            await this.destroy(session);
        }
    }
    /**
     * Returns an iterator over all currently active sessions.
     *
     * @returns An IterableIterator of active Session objects.
     */
    values() {
        return this.activeSessions.values();
    }
    /**
     * Searches for a specific player by guild ID across all active sessions.
     *
     * @param guildId - The Discord guild ID.
     * @returns The Player instance if found, otherwise null.
     */
    getPlayer(guildId) {
        for (const session of this.activeSessions.values()) {
            const player = session.players.get(guildId);
            if (player)
                return player;
        }
        return null;
    }
}
