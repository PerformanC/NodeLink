import assert from 'node:assert/strict'
import type http from 'node:http'
import test from 'node:test'

import type NodelinkServer from '../index.ts'
import type { Session, SessionSocket } from '../typings/index.types.ts'
import type { ClientInfo } from '../typings/shared.types.ts'
import { handleClientWebSocket } from './wsSession.ts'

type CloseListener = (...args: (string | Buffer | number)[]) => void

function createFakeSocket(): SessionSocket {
  const listeners = new Map<string, CloseListener[]>()
  const sent: string[] = []
  const socket = {
    on(event: string, listener: CloseListener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return socket
    },
    send(data: string) {
      sent.push(data)
    },
    emitClose(code = 1000, reason = 'test') {
      for (const listener of listeners.get('close') ?? []) listener(code, reason)
    }
  }
  return socket as unknown as SessionSocket
}

function createFakeContext(session?: Session): {
  context: NodelinkServer
  sessionsMap: Map<string, Session>
} {
  const sessionsMap = new Map<string, Session>()
  if (session) sessionsMap.set(session.id, session)

  const context = {
    sessions: {
      get: (id: string) => sessionsMap.get(id),
      pause: (id: string) => {
        const s = sessionsMap.get(id)
        if (s) {
          s.isPaused = true
          s.socket = null
        }
      },
      shutdown: (id: string) => {
        sessionsMap.delete(id)
      },
      resume: (id: string, socket: SessionSocket) => {
        const s = sessionsMap.get(id)
        if (s) {
          s.isPaused = false
          s.socket = socket
          return s
        }
        return null
      },
      create: () => {
        if (session) sessionsMap.set(session.id, session)
        return session ? session.id : 'new-session-id'
      },
      activeCount: 1
    },
    statsManager: {
      setWebsocketConnections: () => {},
      incrementSessionResume: () => {}
    },
    admissionManager: {
      recordSessionResume: () => {},
      recordSessionConnect: () => {}
    },
    pluginManager: {
      callHook: () => {}
    },
    extensions: { wsInterceptors: [] },
    sourceHealthManager: null
  } as unknown as NodelinkServer

  return { context, sessionsMap }
}

const clientInfo: ClientInfo = { name: 'test-client', version: '1.0.0' } as ClientInfo

function makeSession(id: string, socket: SessionSocket, resuming: boolean): Session {
  return {
    id,
    clientInfo,
    userId: 'user-id',
    socket,
    players: { players: new Map() } as unknown as Session['players'],
    groups: { destroy: () => {} } as unknown as Session['groups'],
    resuming,
    timeout: 60,
    isPaused: false,
    eventQueue: [],
    timeoutFuture: null,
    queueOrSend: () => {}
  }
}

test('stale socket close does not pause a session resumed on a newer socket', () => {
  const oldSocket = createFakeSocket()
  const session = makeSession('session-1', oldSocket, true)
  const { context } = createFakeContext(session)

  handleClientWebSocket(context, oldSocket, {} as http.IncomingMessage, clientInfo, undefined)

  const newSocket = createFakeSocket()
  handleClientWebSocket(context, newSocket, {} as http.IncomingMessage, clientInfo, 'session-1')

  assert.equal(session.socket, newSocket)
  assert.equal(session.isPaused, false)

  // The replaced socket finally reports its close (half-open TCP expiry)
  ;(oldSocket as unknown as { emitClose: () => void }).emitClose()

  assert.equal(session.isPaused, false, 'session must not be paused by a stale socket close')
  assert.equal(session.socket, newSocket, 'session socket must remain the resumed one')
})

test('current socket close still pauses resuming sessions', () => {
  const socket = createFakeSocket()
  const session = makeSession('session-2', socket, true)
  const { context } = createFakeContext(session)

  handleClientWebSocket(context, socket, {} as http.IncomingMessage, clientInfo, undefined)
  ;(socket as unknown as { emitClose: () => void }).emitClose()

  assert.equal(session.isPaused, true, 'live socket close must pause the resuming session')
  assert.equal(session.socket, null)
})
