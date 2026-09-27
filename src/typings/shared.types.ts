/**
 * Client information from Client-Name header
 * @public
 */
export interface ClientInfo {
  /**
   * Client name
   */
  name: string

  /**
   * Client version
   */
  version?: string

  /**
   * Client URL
   */
  url?: string

  /**
   * Client codename
   */
  codename?: string

  /**
   * Release date
   */
  releaseDate?: string
}

/**
 * IPC Message types for cluster communication
 * @public
 */
export type IPCMessage =
  | {
      type: 'playerEvent'
      payload: {
        sessionId: string
        data: string
      }
    }
  | {
      type: 'workerStats'
      pid: number
      stats: {
        players: number
        playingPlayers: number
        memory?: {
          used: number
          allocated: number
        }
        cpu?: {
          nodelinkLoad: number
        }
        frameStats?: {
          sent: number
          nulled: number
          expected: number
        }
      }
    }
  | {
      type: 'workerFailed'
      payload: {
        workerId: number
        affectedGuilds: string[]
      }
    }
  | {
      type: 'ipBlock'
      ip: string
      durationMs?: number
    }

/**
 * HTTP Extension route
 * @public
 */
export interface Extension {
  /**
   * HTTP method
   */
  method: string

  /**
   * Route path
   */
  path: string

  /**
   * Route handler
   */
  handler: (req: ReqShim, res: ResShim) => void | Promise<void>
}

/**
 * Track modifier function
 * @public
 */
export type TrackModifier = (
  data: Record<string, string | number | boolean | null>
) => void

/**
 * WebSocket interceptor function
 * @public
 */
export type WebSocketInterceptor = (
  nodelink: Record<string, unknown>,
  socket: Record<string, unknown>,
  data: Record<string, string | number | boolean>,
  clientInfo: ClientInfo
) => Promise<boolean | undefined>

/**
 * Audio interceptor function
 * @public
 */
export type AudioInterceptor = (
  pcm: Buffer,
  sampleRate: number,
  channels: number,
  format: string
) => Promise<Buffer>

/**
 * Player interceptor function
 * @public
 */
export type PlayerInterceptor = (player: Record<string, unknown>) => void

/**
 * Request shim for Bun/Node compatibility
 * @public
 */
export interface ReqShim {
  /**
   * HTTP method
   */
  method?: string

  /**
   * Request URL
   */
  url?: string

  /**
   * Request headers
   */
  headers: Record<string, string | string[]>

  /**
   * Socket information
   */
  socket?: {
    remoteAddress?: string
  }

  /**
   * Event listener
   */
  on?: (event: string, cb: (...args: (string | Buffer)[]) => void) => void
}

/**
 * Response shim for Bun/Node compatibility
 * @public
 */
export interface ResShim {
  /**
   * Response status code
   */
  _status: number

  /**
   * Response headers
   */
  _headers: Record<string, string | string[]>

  /**
   * Response body chunks
   */
  _body: (string | Buffer)[]

  /**
   * Sets response status and headers
   */
  writeHead: (
    status: number,
    headers?: Record<string, string | string[]>
  ) => void

  /**
   * Sets a response header
   */
  setHeader: (name: string, value: string | string[]) => void

  /**
   * Gets a response header
   */
  getHeader: (name: string) => string | string[] | undefined

  /**
   * Ends the response
   */
  end: (data?: string | Buffer) => void

  /**
   * Writes data to response
   */
  write: (data: string | Buffer) => void
}
