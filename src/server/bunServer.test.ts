import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import AdmissionManager from '../managers/admissionManager.ts'
import type { AdmissionConfig } from '../typings/admission/admission.types.ts'
import { type BunServerContext, createBunServer } from './bunServer.ts'

/* INFO: Bun-only regression; run with `bun test src/server/bunServer.test.ts` */
const skip = typeof Bun === 'undefined' ? 'requires the Bun runtime' : false

const PASSWORD = 'test-password'

async function startBunServer(config: Partial<AdmissionConfig>) {
  const options = {
    server: { host: '127.0.0.1', port: 0, password: PASSWORD },
    playback: { voiceReceive: { enabled: false } },
    cluster: {}
  }
  const admission = new AdmissionManager(
    { options } as unknown as ConstructorParameters<typeof AdmissionManager>[0],
    config
  )
  const socketBus = new EventEmitter()
  const context = {
    options,
    admissionManager: admission,
    socket: socketBus,
    sessions: { isResumable: () => false }
  } as unknown as BunServerContext

  const server = createBunServer(context, () =>
    Promise.reject(new Error('REST is not used in this test'))
  )

  return {
    url: `ws://127.0.0.1:${server.port}/v4/websocket`,
    socketBus,
    close: async () => {
      admission.destroy()
      await server.stop(true)
    }
  }
}

function connect(
  url: string,
  forwardedFor?: string
): Promise<WebSocket | null> {
  const headers: Record<string, string> = {
    Authorization: PASSWORD,
    'Client-Name': 'bun-release-test/1.0.0',
    'User-Id': '123456789012345678'
  }
  if (forwardedFor) headers['X-Forwarded-For'] = forwardedFor

  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as unknown as string[])
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => resolve(null), { once: true })
  })
}

async function closeAll(sockets: Array<WebSocket | null>): Promise<void> {
  await Promise.all(
    sockets.map(
      (ws) =>
        new Promise((resolve) => {
          if (!ws || ws.readyState === WebSocket.CLOSED) return resolve(null)
          ws.addEventListener('close', resolve, { once: true })
          ws.close(1000, 'done')
        })
    )
  )
  /* INFO: The server-side close handler releases capacity after the client sees the close */
  await new Promise((resolve) => setTimeout(resolve, 50))
}

test('Bun caps direct peers and releases slots on close', {
  skip
}, async (t) => {
  const harness = await startBunServer({
    ip: { maxConcurrentSockets: 2 } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  for (let round = 0; round < 3; round++) {
    const open = [await connect(harness.url), await connect(harness.url)]
    assert.ok(open[0] && open[1], `round ${round}: both connections open`)
    assert.equal(await connect(harness.url), null, 'third is over the limit')
    await closeAll(open)
  }
})

test('Bun caps proxied clients and the proxy pool, releasing both', {
  skip
}, async (t) => {
  const harness = await startBunServer({
    trustProxy: true,
    trustedProxies: ['127.0.0.1'],
    ip: {
      maxConcurrentSockets: 2,
      maxProxySockets: 3
    } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  for (let round = 0; round < 3; round++) {
    const a1 = await connect(harness.url, '198.51.100.1')
    const a2 = await connect(harness.url, '198.51.100.1')
    assert.ok(a1 && a2, `round ${round}: client A gets two sockets`)
    assert.equal(await connect(harness.url, '198.51.100.1'), null)

    const b1 = await connect(harness.url, '198.51.100.2')
    assert.ok(b1, 'client B is unaffected by client A')
    assert.equal(
      await connect(harness.url, '198.51.100.3'),
      null,
      'proxy aggregate pool is full'
    )

    await closeAll([a1, a2, b1])
  }
})

test('Bun releases slots when the server closes the socket', {
  skip
}, async (t) => {
  const harness = await startBunServer({
    ip: { maxConcurrentSockets: 1 } as AdmissionConfig['ip']
  })
  t.after(() => harness.close())

  harness.socketBus.on('/v4/websocket', (wrapper: { close: () => void }) => {
    setTimeout(() => wrapper.close(), 10)
  })

  for (let round = 0; round < 3; round++) {
    const ws = await connect(harness.url)
    assert.ok(ws, `round ${round}: slot available after server close`)
    await new Promise((resolve) =>
      ws.readyState === WebSocket.CLOSED
        ? resolve(null)
        : ws.addEventListener('close', resolve, { once: true })
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
})
