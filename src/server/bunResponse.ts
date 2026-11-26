import type { OutgoingHttpHeaders } from 'node:http'
import { Writable } from 'node:stream'
import type { ResponseShim } from '../typings/index.types.ts'

/**
 * Options for {@link BunResponseShim}.
 * @internal
 */
export interface BunResponseShimOptions {
  /**
   * Resolves the `fetch` handler promise with the final Web `Response`.
   */
  resolve: (response: Response) => void

  /**
   * Called once when the response switches to streaming mode. Used to lift
   * Bun's idle timeout for long-lived audio streams.
   */
  onStreamStart?: () => void
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

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
export class BunResponseShim extends Writable implements ResponseShim {
  _status = 200
  _headers: OutgoingHttpHeaders = {}
  _body: (string | Buffer)[] = []
  headersSent = false

  private readonly resolveResponse: (response: Response) => void
  private readonly onStreamStart: (() => void) | undefined
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private pendingWriteCallback: (() => void) | null = null
  private streaming = false
  private responded = false

  constructor(options: BunResponseShimOptions) {
    super({ highWaterMark: 64 * 1024 })
    this.resolveResponse = options.resolve
    this.onStreamStart = options.onStreamStart

    // Mirrors http.ServerResponse: a destroy(err) must not crash the process
    // when nobody is listening for 'error'.
    this.on('error', () => {})
  }

  get statusCode(): number {
    return this._status
  }

  set statusCode(value: number) {
    this._status = value
  }

  writeHead(
    status: number,
    headers?: Record<string, string | string[] | number>
  ): void {
    if (this.responded) return
    this._status = status
    if (headers) Object.assign(this._headers, headers)
  }

  setHeader(name: string, value: string | string[] | number): void {
    this._headers[name] = value
  }

  getHeader(name: string): string | string[] | undefined {
    const direct = this._headers[name]
    if (direct !== undefined) return direct as string | string[]

    const lower = name.toLowerCase()
    for (const [key, value] of Object.entries(this._headers)) {
      if (key.toLowerCase() === lower && value !== undefined) {
        return value as string | string[]
      }
    }
    return undefined
  }

  override end(...args: unknown[]): this {
    if (
      !this.streaming &&
      !this.responded &&
      !this.destroyed &&
      !this.writableEnded
    ) {
      const first = args[0]
      if (typeof first === 'string') {
        this._body.push(first)
      } else if (first instanceof Uint8Array) {
        this._body.push(Buffer.from(first))
      }

      const chunks = this._body.map((chunk) =>
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      )
      this._body = []
      this.respond(chunks.length > 0 ? Buffer.concat(chunks) : '')

      const callback = args.find((arg) => typeof arg === 'function')
      return (super.end as (...params: unknown[]) => this).call(
        this,
        ...(callback ? [callback] : [])
      )
    }

    return (super.end as (...params: unknown[]) => this).call(this, ...args)
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.streaming) {
      if (this.responded) {
        callback()
        return
      }
      this.startStreaming()
    }

    const controller = this.controller
    if (!controller) {
      // Client is gone; drop data and let the writer finish quietly.
      callback()
      return
    }

    // The write callback below may fire while the stream still queues this
    // chunk, after which the producer is free to reuse or mutate its Buffer.
    // Enqueue an owned copy, never a view over the caller's backing store.
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    const owned = new Uint8Array(source)

    try {
      controller.enqueue(owned)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
      return
    }

    if ((controller.desiredSize ?? 1) > 0) {
      callback()
    } else {
      this.pendingWriteCallback = () => callback()
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.closeController()
    callback()
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.pendingWriteCallback = null

    if (this.controller) {
      // Destroyed before a clean end: abort the HTTP response so the client
      // sees a truncated transfer instead of a "successful" short body.
      try {
        this.controller.error(error ?? new Error('Response destroyed'))
      } catch {}
      this.controller = null
    } else if (!this.responded) {
      this.respond('Internal Server Error', 500)
    }

    callback(error)
  }

  private startStreaming(): void {
    this.streaming = true

    try {
      this.onStreamStart?.()
    } catch {}

    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.controller = controller
        },
        pull: () => {
          const pending = this.pendingWriteCallback
          this.pendingWriteCallback = null
          pending?.()
        },
        cancel: () => {
          // Client disconnected mid-stream.
          this.controller = null
          this.pendingWriteCallback = null
          if (!this.destroyed) this.destroy()
        }
      },
      { highWaterMark: 8 }
    )

    this.respond(body)
  }

  private closeController(): void {
    const controller = this.controller
    this.controller = null
    if (!controller) return
    try {
      controller.close()
    } catch {}
  }

  private respond(
    body: ConstructorParameters<typeof Response>[0],
    statusOverride?: number
  ): void {
    if (this.responded) return
    this.responded = true
    this.headersSent = true

    const status = statusOverride ?? this._status
    const headers = new Headers()

    if (statusOverride === undefined) {
      for (const [key, value] of Object.entries(this._headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, String(item))
        } else {
          headers.set(key, String(value))
        }
      }
    } else {
      headers.set('Content-Type', 'text/plain')
    }

    this.resolveResponse(
      new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
        status,
        headers
      })
    )
  }
}
