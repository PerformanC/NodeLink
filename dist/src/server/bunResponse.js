import { Writable } from 'node:stream';
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/**
 * Node-style response object backed by a Web `Response`.
 *
 * It behaves like an `http.ServerResponse` for the parts of the API NodeLink
 * relies on. It is a real `Writable`, so `pipeline(...)`, `once('close')`,
 * `writableEnded` and `destroy()` all work.
 *
 * - A single `end(data)` call (without prior `write`) produces a regular
 *   buffered `Response`.
 * - The first `write(...)` switches to streaming mode: the `Response` is
 *   resolved immediately with a `ReadableStream` body and backpressure is
 *   propagated to the writer.
 * - When the client disconnects the stream is cancelled, which destroys this
 *   writable and emits `close` (so handlers can release upstream resources).
 *
 * @internal
 */
export class BunResponseShim extends Writable {
    _status = 200;
    _headers = {};
    _body = [];
    headersSent = false;
    resolveResponse;
    onStreamStart;
    controller = null;
    pendingWriteCallback = null;
    streaming = false;
    responded = false;
    constructor(options) {
        super({ highWaterMark: 64 * 1024 });
        this.resolveResponse = options.resolve;
        this.onStreamStart = options.onStreamStart;
        // Mirrors http.ServerResponse: a destroy(err) must not crash the process
        // when nobody is listening for 'error'.
        this.on('error', () => { });
    }
    get statusCode() {
        return this._status;
    }
    set statusCode(value) {
        this._status = value;
    }
    writeHead(status, headers) {
        if (this.responded)
            return;
        this._status = status;
        if (headers)
            Object.assign(this._headers, headers);
    }
    setHeader(name, value) {
        this._headers[name] = value;
    }
    getHeader(name) {
        const direct = this._headers[name];
        if (direct !== undefined)
            return direct;
        const lower = name.toLowerCase();
        for (const [key, value] of Object.entries(this._headers)) {
            if (key.toLowerCase() === lower && value !== undefined) {
                return value;
            }
        }
        return undefined;
    }
    end(...args) {
        if (!this.streaming &&
            !this.responded &&
            !this.destroyed &&
            !this.writableEnded) {
            const first = args[0];
            if (typeof first === 'string') {
                this._body.push(first);
            }
            else if (first instanceof Uint8Array) {
                this._body.push(Buffer.from(first));
            }
            const chunks = this._body.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            this._body = [];
            this.respond(chunks.length > 0 ? Buffer.concat(chunks) : '');
            const callback = args.find((arg) => typeof arg === 'function');
            return super.end.call(this, ...(callback ? [callback] : []));
        }
        return super.end.call(this, ...args);
    }
    _write(chunk, encoding, callback) {
        if (!this.streaming) {
            if (this.responded) {
                callback();
                return;
            }
            this.startStreaming();
        }
        const controller = this.controller;
        if (!controller) {
            // Client is gone; drop data and let the writer finish quietly.
            callback();
            return;
        }
        // The write callback below may fire while the stream still queues this
        // chunk, after which the producer is free to reuse or mutate its Buffer.
        // Enqueue an owned copy, never a view over the caller's backing store.
        const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const owned = new Uint8Array(source);
        try {
            controller.enqueue(owned);
        }
        catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        if ((controller.desiredSize ?? 1) > 0) {
            callback();
        }
        else {
            this.pendingWriteCallback = () => callback();
        }
    }
    _final(callback) {
        this.closeController();
        callback();
    }
    _destroy(error, callback) {
        this.pendingWriteCallback = null;
        if (this.controller) {
            // Destroyed before a clean end: abort the HTTP response so the client
            // sees a truncated transfer instead of a "successful" short body.
            try {
                this.controller.error(error ?? new Error('Response destroyed'));
            }
            catch { }
            this.controller = null;
        }
        else if (!this.responded) {
            this.respond('Internal Server Error', 500);
        }
        callback(error);
    }
    startStreaming() {
        this.streaming = true;
        try {
            this.onStreamStart?.();
        }
        catch { }
        const body = new ReadableStream({
            start: (controller) => {
                this.controller = controller;
            },
            pull: () => {
                const pending = this.pendingWriteCallback;
                this.pendingWriteCallback = null;
                pending?.();
            },
            cancel: () => {
                // Client disconnected mid-stream.
                this.controller = null;
                this.pendingWriteCallback = null;
                if (!this.destroyed)
                    this.destroy();
            }
        }, { highWaterMark: 8 });
        this.respond(body);
    }
    closeController() {
        const controller = this.controller;
        this.controller = null;
        if (!controller)
            return;
        try {
            controller.close();
        }
        catch { }
    }
    respond(body, statusOverride) {
        if (this.responded)
            return;
        this.responded = true;
        this.headersSent = true;
        const status = statusOverride ?? this._status;
        const headers = new Headers();
        if (statusOverride === undefined) {
            for (const [key, value] of Object.entries(this._headers)) {
                if (value === undefined)
                    continue;
                if (Array.isArray(value)) {
                    for (const item of value)
                        headers.append(key, String(item));
                }
                else {
                    headers.set(key, String(value));
                }
            }
        }
        else {
            headers.set('Content-Type', 'text/plain');
        }
        this.resolveResponse(new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
            status,
            headers
        }));
    }
}
