import assert from 'node:assert/strict'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import WebSocketServer from '@performanc/pwsl-server'

import type NodelinkServer from '../index.ts'
import AdmissionManager from '../managers/admissionManager.ts'
import type { AdmissionConfig } from '../typings/admission/admission.types.ts'
import { createHttpServer } from './httpServer.ts'
import { setupWebSocketEvents } from './wsRouter.ts'

const PASSWORD = 'test-password'

interface Harness {
  url: string
  admission: AdmissionManager
  socketBus: WebSocketServer
  close: () => Promise<void>
}

async function startServer(config: Partial<AdmissionConfig>): Promise<Harness> {
  const options = {
    server: { password: PASSWORD },
    playback: { voiceReceive: { enabled: false } },
    cluster: {}
  }
  const admission = new AdmissionManager(
    { options } as unknown as ConstructorParameters<typeof AdmissionManager>[0],
    config
  )
  const socketBus = new WebSocketServer()
  const context = {
    options,
    admissionManager: admission,
    socket: socketBus,
    sessions: { isResumable: () => false },
    pluginManager: { callHook: () => {} }
  } as unknown as NodelinkServer

  setupWebSocketEvents(context)
  socketBus.removeAllListeners('/v4/websocket')

  const server = createHttpServer(context, () =>
    Promise.reject(new Error('REST is not used in this test'))
  ) as http.Server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `ws://127.0.0.1:${port}/v4/websocket`,
    admission,
    socketBus,
    close: async () => {
      admission.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function connect(
  url: string,
  forwardedFor?: string
): Promise<WebSocket | null> {
  const headers: Record<string, string> = {
    Authorization: PASSWORD,
    'Client-Name': 'release-test/1.0.0',
    'User-Id': '123456789012345678'
  }
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor

  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as unknown as string[])
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => resolve(null), { once: true })
  })
}

async function closeClient(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return
  const closed = new Promise((resolve) =>
    ws.addEventListener('close', resolve, { once: true })
  )
  ws.close(1000, 'done')
  await closed
}

/* INFO: The server releases on its own close handling, which can trail the client's close event */
async function connectEventually(
  url: string,
  forwardedFor?: string
): Promise<WebSocket | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ws = await connect(url, forwardedFor)
    if (ws) return ws
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

test('direct peers get their socket slots back after normal closes', async (t) => {
  const harness = await startServer({
    ip: { maxConcurrentSockets: 2 } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  for (let round = 0; round < 3; round++) {
    const first = await connectEventually(harness.url)
    const second = await connectEventually(harness.url)
    assert.ok(first && second, `round ${round}: both connections open`)
    assert.equal(await connect(harness.url), null, 'third is over the limit')

    await closeClient(first)
    await closeClient(second)
  }
})

test('proxied clients release both per-client and proxy pools', async (t) => {
  const harness = await startServer({
    trustProxy: true,
    trustedProxies: ['127.0.0.1'],
    ip: {
      maxConcurrentSockets: 2,
      maxProxySockets: 3
    } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  for (let round = 0; round < 3; round++) {
    const a1 = await connectEventually(harness.url, '198.51.100.1')
    const a2 = await connectEventually(harness.url, '198.51.100.1')
    assert.ok(a1 && a2, `round ${round}: client A gets two sockets`)
    assert.equal(
      await connect(harness.url, '198.51.100.1'),
      null,
      'client A is capped per client'
    )

    const b1 = await connectEventually(harness.url, '198.51.100.2')
    assert.ok(b1, 'client B is unaffected by client A')
    assert.equal(
      await connect(harness.url, '198.51.100.3'),
      null,
      'proxy aggregate pool is full'
    )

    await closeClient(a1)
    await closeClient(a2)
    await closeClient(b1)
  }
})

test('server-side destroy releases the slot', async (t) => {
  const harness = await startServer({
    ip: { maxConcurrentSockets: 1 } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  harness.socketBus.on('/v4/websocket', (ws: { destroy: () => void }) => {
    setTimeout(() => ws.destroy(), 10)
  })

  for (let round = 0; round < 3; round++) {
    const ws = await connectEventually(harness.url)
    assert.ok(ws, `round ${round}: slot available after server destroy`)
    await new Promise((resolve) =>
      ws.readyState === WebSocket.CLOSED
        ? resolve(null)
        : ws.addEventListener('close', resolve, { once: true })
    )
  }
})
