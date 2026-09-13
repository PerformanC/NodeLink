import { logger, makeRequest } from '../../utils.js';
import Web from './clients/Web.js';
/**
 * Helper responsible for bootstrapping and polling YouTube live chat.
 *
 * The helper converts the watch-next live chat continuation flow into a small
 * polling abstraction that the source can bridge to WebSocket clients.
 *
 * @example
 * ```typescript
 * const liveChat = new LiveChat(nodelink, {
 *   getProxy: () => undefined,
 *   getContext: () => ytContext
 * })
 *
 * const connection = await liveChat.getLiveChat('dQw4w9WgXcQ')
 * const update = await connection?.poll()
 * ```
 *
 * @public
 */
export default class LiveChat {
    /** Worker runtime shared with the YouTube source. */
    nodelink;
    /** Minimal source adapter exposing proxy and context access. */
    source;
    /** Web client used to bootstrap the initial watch-next continuation. */
    webClient;
    /** Fallback Innertube API key used when watch-next does not expose one. */
    apiKey;
    /** Active live chat sessions keyed by synthetic connection id. */
    activeChats;
    /**
     * Creates a live chat helper for the active YouTube source runtime.
     *
     * @param nodelink - Worker runtime used for logging and shared utilities.
     * @param source - Minimal source adapter exposing proxy and context access.
     */
    constructor(nodelink, source) {
        this.nodelink = nodelink;
        this.source = source;
        this.webClient = new Web(nodelink, null);
        this.apiKey = 'AIzaSyAO_FJ2SlqI87oz4cl9Sdr_LRIPvS6S8';
        this.activeChats = new Map();
    }
    /**
     * Bootstraps a pollable live chat session for a YouTube live stream.
     *
     * The method first resolves the watch-next continuation token, then returns
     * a lightweight polling object that can be reused by the WebSocket bridge.
     *
     * @param videoId - Live-stream video identifier to attach to.
     *
     * @example
     * ```typescript
     * const connection = await liveChat.getLiveChat('5qap5aO4i9A')
     * if (connection) {
     *   const result = await connection.poll()
     *   console.log(result?.actions)
     * }
     * ```
     *
     * @returns Pollable live chat connection, or `null` when chat is unavailable.
     */
    async getLiveChat(videoId) {
        try {
            const { body, statusCode } = await this.webClient._makeNextRequest(videoId, this.source.getContext(), {});
            const data = (body ?? {});
            if (statusCode !== 200 || !body) {
                logger('error', 'YouTube-LiveChat', `Failed to get next data for ${videoId}: Status ${statusCode}`);
                return null;
            }
            const chatRenderer = data.contents?.twoColumnWatchNextResults?.conversationBar
                ?.liveChatRenderer;
            let continuation = chatRenderer?.continuations?.[0]?.reloadContinuationData
                ?.continuation ?? null;
            if (!continuation) {
                logger('warn', 'YouTube-LiveChat', `No live chat continuation found for ${videoId}`);
                return null;
            }
            const apiKey = data.responseContext?.serviceTrackingParams?.[0]?.serviceInfo?.[0]
                ?.value || this.apiKey;
            return {
                poll: async () => {
                    if (!continuation) {
                        return null;
                    }
                    const headers = {
                        'Content-Type': 'application/json'
                    };
                    const { body: chatBody, statusCode: pollStatusCode } = await makeRequest(`https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${apiKey}`, {
                        method: 'POST',
                        headers,
                        body: {
                            context: this.source.getContext(),
                            continuation
                        },
                        disableBodyCompression: true,
                        proxy: this.source.getProxy()
                    });
                    if (pollStatusCode !== 200 || !chatBody) {
                        logger('warn', 'YouTube-LiveChat', `Polling failed for ${videoId}: Status ${pollStatusCode}`);
                        return null;
                    }
                    const chatResponse = chatBody;
                    const chatContinuation = chatResponse.continuationContents?.liveChatContinuation;
                    if (!chatContinuation) {
                        return null;
                    }
                    const nextContinuationData = chatContinuation.continuations?.[0]?.invalidationContinuationData ||
                        chatContinuation.continuations?.[0]?.timedContinuationData;
                    continuation = nextContinuationData?.continuation ?? null;
                    return {
                        actions: this.parseActions(chatContinuation.actions ?? []),
                        timeoutMs: nextContinuationData?.timeoutMs ?? 5000
                    };
                }
            };
        }
        catch (error) {
            logger('error', 'YouTube-LiveChat', `Error initializing chat for ${videoId}: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }
    /**
     * Normalizes raw YouTube live chat actions into worker-friendly payloads.
     *
     * @param actions - Raw action array returned by YouTube.
     *
     * @example
     * ```typescript
     * const payloads = liveChat.parseActions(rawActions)
     * socket.send(JSON.stringify({ op: 'actions', actions: payloads }))
     * ```
     *
     * @returns Simplified action payloads ready to serialize over the socket.
     */
    parseActions(actions) {
        const parsed = [];
        for (const action of actions) {
            const item = action.addChatItemAction?.item;
            if (!item) {
                continue;
            }
            const renderer = item.liveChatTextMessageRenderer ||
                item.liveChatPaidMessageRenderer ||
                item.liveChatMembershipItemRenderer ||
                item.liveChatSponsorshipsGiftPurchaseAnnouncementRenderer;
            if (!renderer) {
                continue;
            }
            parsed.push({
                type: item.liveChatTextMessageRenderer
                    ? 'text'
                    : item.liveChatPaidMessageRenderer
                        ? 'paid'
                        : item.liveChatMembershipItemRenderer
                            ? 'membership'
                            : 'gift',
                id: renderer.id,
                timestamp: renderer.timestampUsec,
                author: {
                    name: renderer.authorName?.simpleText ||
                        renderer.headerPrimaryText?.runs
                            ?.map((run) => run.text ?? '')
                            .join(''),
                    id: renderer.authorExternalChannelId,
                    photo: renderer.authorPhoto?.thumbnails?.at(-1)?.url,
                    badges: renderer.authorBadges?.map((badge) => badge.liveChatAuthorBadgeRenderer?.tooltip)
                },
                message: renderer.message?.runs?.map((run) => run.text ?? '').join('') ||
                    renderer.headerSubtext?.simpleText ||
                    renderer.headerSubtext?.runs?.map((run) => run.text ?? '').join(''),
                amount: renderer.purchaseAmountText?.simpleText
            });
        }
        return parsed;
    }
    /**
     * Alias used by the source layer to obtain a live chat session.
     *
     * @param videoId - Live-stream video identifier.
     * @returns Pollable live chat connection, or `null` when unavailable.
     */
    async handleLiveChat(videoId) {
        return this.getLiveChat(videoId);
    }
    /**
     * Attaches a WebSocket-style client to the live chat polling loop.
     *
     * @param socket - Socket-like transport receiving serialized chat actions.
     * @param videoId - Live-stream video identifier to follow.
     *
     * @example
     * ```typescript
     * await liveChat.handleConnection(socket, '5qap5aO4i9A')
     * ```
     *
     * @returns Promise resolved once the chat loop finishes or the socket closes.
     */
    async handleConnection(socket, videoId) {
        const chatSocket = socket;
        logger('info', 'YouTube-LiveChat', `Starting live chat for video: ${videoId}`);
        try {
            const chat = await this.getLiveChat(videoId);
            if (!chat) {
                chatSocket.close(1008, 'Could not initialize live chat');
                return;
            }
            const chatKey = `${videoId}-${Date.now()}`;
            this.activeChats.set(chatKey, true);
            const cleanup = () => {
                this.activeChats.delete(chatKey);
                if (chatSocket.readyState === 1) {
                    chatSocket.close();
                }
            };
            chatSocket.on('close', () => {
                this.activeChats.delete(chatKey);
            });
            chatSocket.on('error', cleanup);
            while (this.activeChats.has(chatKey)) {
                try {
                    const result = await chat.poll();
                    if (!result) {
                        break;
                    }
                    if (result.actions.length > 0) {
                        chatSocket.send(JSON.stringify({ op: 'actions', actions: result.actions }));
                    }
                    await new Promise((resolve) => setTimeout(resolve, result.timeoutMs || 5000));
                }
                catch (error) {
                    logger('error', 'YouTube-LiveChat', `Polling error: ${error instanceof Error ? error.message : String(error)}`);
                    break;
                }
            }
            cleanup();
        }
        catch (error) {
            logger('error', 'YouTube-LiveChat', `Failed to connect: ${error instanceof Error ? error.message : String(error)}`);
            chatSocket.close(1011, 'Internal error during initialization');
        }
    }
}
