import type { IncomingHttpHeaders } from 'node:http'
import type { NodelinkConfig } from '../config/config.types.ts'

/**
 * Supported HTTP methods for API routes.
 * @public
 */
export type ApiHttpMethod =
  | 'GET'
  | 'POST'
  | 'PUT'
  | 'PATCH'
  | 'DELETE'
  | 'OPTIONS'
  | 'HEAD'
  | 'TRACE'
  | 'CONNECT'

/**
 * Headers map used by API requests and shims.
 * @remarks Header values may be normalized to strings or arrays by the runtime.
 * @public
 */
export type ApiHeaders =
  | IncomingHttpHeaders
  | Record<string, string | string[] | undefined>

/**
 * Socket metadata available on API requests.
 * @public
 */
export interface ApiSocketInfo {
  /**
   * Client IP address when available.
   */
  remoteAddress?: string

  /**
   * Client TCP port when available.
   */
  remotePort?: number
}

/**
 * Minimal request shape passed to API routes and middleware.
 * @remarks Works with both Node.js IncomingMessage and Bun request shims.
 * @example
 * ```ts
 * const authHeader = req.headers.authorization
 * if (!authHeader) {
 *   res.writeHead(401, { 'Content-Type': 'text/plain' })
 *   res.end('Unauthorized')
 * }
 * ```
 * @public
 */
export interface ApiRequest {
  /**
   * HTTP method (GET, POST, etc.).
   */
  method?: string

  /**
   * Request URL path and query string.
   */
  url?: string

  /**
   * Request headers.
   */
  headers: ApiHeaders

  /**
   * Socket metadata for the current request.
   */
  socket?: ApiSocketInfo

  /**
   * Parsed request body when available.
   * @remarks JSON bodies are parsed into objects.
   */
  body?: unknown

  /**
   * Event listener registration (data/end).
   */
  on?: (event: string, listener: (chunk: Buffer) => void) => void

  /**
   * Removes a registered event listener.
   */
  removeListener?: (event: string, listener: (chunk: Buffer) => void) => void

  /**
   * Destroys the underlying request stream.
   */
  destroy?: () => void
}

/**
 * Minimal response shape used by API handlers.
 * @remarks Compatible with Node.js ServerResponse and Bun response shims.
 * @example
 * ```ts
 * res.writeHead(200, { 'Content-Type': 'application/json' })
 * res.end(JSON.stringify({ ok: true }))
 * ```
 * @public
 */
export interface ApiResponse {
  /**
   * HTTP status code when available.
   */
  statusCode?: number

  /**
   * Writes response status and headers.
   */
  writeHead(
    status: number,
    headers?: Record<string, string | string[] | number>
  ): void

  /**
   * Sets a response header.
   */
  setHeader(name: string, value: string | string[] | number): void

  /**
   * Gets a response header.
   */
  getHeader?: (name: string) => string | string[] | number | undefined

  /**
   * Sends final response data.
   */
  end(data?: string | Buffer): void

  /**
   * Writes response data without ending the response.
   */
  write?: (data: string | Buffer) => void
}

/**
 * Helper used by API routes to return JSON responses.
 * @public
 */
export type ApiSendResponse = (
  req: ApiRequest,
  res: ApiResponse,
  data: unknown,
  status: number,
  trace?: boolean
) => void

/**
 * API route handler signature.
 * @example
 * ```ts
 * export const handler: ApiRouteHandler = (
 *   _nodelink,
 *   req,
 *   res,
 *   sendResponse
 * ) => {
 *   sendResponse(req, res, { status: 'ok' }, 200)
 * }
 * ```
 * @public
 */
export type ApiRouteHandler = (
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  sendResponse: ApiSendResponse,
  parsedUrl: URL
) => void | Promise<void>

/**
 * Module shape exported by API route files.
 * @example
 * ```ts
 * export default {
 *   methods: ['GET'],
 *   handler: (_nodelink, req, res, sendResponse) => {
 *     sendResponse(req, res, { version: '4' }, 200)
 *   }
 * }
 * ```
 * @public
 */
export interface ApiRouteModule {
  /**
   * Route handler implementation.
   */
  handler: ApiRouteHandler

  /**
   * Static pathnames this module handles, overriding the filename-derived pathname.
   */
  paths?: string[]

  /**
   * Allowed HTTP methods (defaults to GET).
   */
  methods?: ApiHttpMethod[]
}

/**
 * Normalized route definition used by the router.
 * @internal
 */
export interface ApiRouteDefinition {
  /**
   * Route handler implementation.
   */
  handler: ApiRouteHandler

  /**
   * Allowed HTTP methods.
   */
  methods: ApiHttpMethod[]
}

/**
 * Dynamic route entry with its matching RegExp.
 * @internal
 */
export type ApiDynamicRoute = [RegExp, ApiRouteDefinition]

/**
 * Collection of static and dynamic routes.
 * @internal
 */
export interface ApiRouteCollection {
  /**
   * Static routes keyed by exact pathname.
   */
  staticRoutes: Map<string, ApiRouteDefinition>

  /**
   * Dynamic routes sorted by pattern specificity.
   */
  dynamicRoutes: ApiDynamicRoute[]
}

/**
 * Route module entry used during route discovery.
 * @internal
 */
export interface ApiRouteModuleEntry {
  /**
   * Route file name.
   */
  file: string

  /**
   * Resolved route module.
   */
  module: ApiRouteModule
}

/**
 * Middleware result. Returning true short-circuits further processing.
 * @public
 */
export type ApiMiddlewareResult = boolean | undefined

/**
 * Middleware executed before route resolution.
 * @example
 * ```ts
 * nodelink.registerMiddleware((_nodelink, _req, res, url) => {
 *   if (url.pathname === '/v4/health') {
 *     res.writeHead(200, { 'Content-Type': 'text/plain' })
 *     res.end('ok')
 *     return true
 *   }
 * })
 * ```
 * @public
 */
export type ApiMiddlewareExtension = (
  nodelink: ApiNodelinkServer,
  req: ApiRequest,
  res: ApiResponse,
  parsedUrl: URL
) => ApiMiddlewareResult | Promise<ApiMiddlewareResult>

/**
 * Custom HTTP route registered at runtime.
 * @public
 */
export interface ApiRouteExtension {
  /**
   * HTTP method for the route.
   * @remarks Use a standard method when possible.
   */
  method?: ApiHttpMethod | string

  /**
   * Route pathname.
   */
  path: string

  /**
   * Route handler implementation.
   */
  handler: ApiRouteHandler
}

/**
 * Rate limit check result.
 * @public
 */
export interface ApiRateLimitResult {
  /**
   * Whether the request is allowed.
   */
  allowed: boolean

  /**
   * Maximum requests allowed in the current window.
   */
  limit?: number

  /**
   * Remaining requests in the window.
   */
  remaining?: number

  /**
   * Unix timestamp (ms) when the window resets.
   */
  reset?: number
}

/**
 * DoS protection check result.
 * @public
 */
export interface ApiDosProtectionResult {
  /**
   * Whether the request is allowed.
   */
  allowed: boolean

  /**
   * Optional HTTP status code when blocked.
   */
  status?: number

  /**
   * Optional block reason.
   */
  message?: string

  /**
   * Optional delay to apply before continuing.
   */
  delay?: number
}

/**
 * Stats manager methods required by the API router.
 * @public
 */
export interface ApiStatsManager {
  /**
   * Increments request count for an endpoint.
   */
  incrementApiRequest: (endpoint: string) => void

  /**
   * Records HTTP request duration for metrics.
   */
  recordHttpRequestDuration: (
    endpoint: string,
    method: string | undefined,
    statusCode: number | undefined,
    durationMs: number
  ) => void

  /**
   * Increments DoS protection block counter.
   */
  incrementDosProtectionBlock: (
    remoteAddress: string | undefined,
    reason?: string
  ) => void

  /**
   * Increments rate limit hit counter.
   */
  incrementRateLimitHit: (
    endpoint: string,
    remoteAddress: string | undefined
  ) => void
}

/**
 * DoS protection manager interface used by the API router.
 * @public
 */
export interface ApiDosProtectionManager {
  /**
   * Checks the incoming request against DoS rules.
   */
  check: (req: ApiRequest) => ApiDosProtectionResult
}

/**
 * Rate limit manager interface used by the API router.
 * @public
 */
export interface ApiRateLimitManager {
  /**
   * Checks the incoming request against rate limit rules.
   */
  check: (req: ApiRequest, parsedUrl: URL) => ApiRateLimitResult
}

/**
 * API extension points available on the NodeLink server instance.
 * @public
 */
export interface ApiExtensions {
  /**
   * Custom routes.
   */
  routes?: ApiRouteExtension[]

  /**
   * Request middlewares executed before route handling.
   */
  middlewares?: ApiMiddlewareExtension[]
}

/**
 * Minimal NodeLink server shape required by the REST API router.
 * @remarks This is intentionally smaller than the full server class.
 * @public
 */
export interface ApiNodelinkServer {
  /**
   * Loaded configuration.
   */
  options: NodelinkConfig & {
    server: NodelinkConfig['server'] & { maxBodySize?: number }
  }

  /**
   * Extension hooks.
   */
  extensions?: ApiExtensions

  /**
   * Stats manager for API metrics.
   */
  statsManager: ApiStatsManager

  /**
   * Rate limiter instance.
   */
  rateLimitManager: ApiRateLimitManager

  /**
   * DoS protection instance.
   */
  dosProtectionManager: ApiDosProtectionManager
}
