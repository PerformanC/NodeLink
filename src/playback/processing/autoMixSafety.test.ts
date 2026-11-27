import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import {
  createServer as createHttp2Server,
  type ServerHttp2Session
} from 'node:http2'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import SourcesManager from '../../managers/sourceManager.ts'
import { http1makeRequest, makeRequest } from '../../utils.ts'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import type { TemporalFeaturePoint } from '../../typings/playback/progressiveAnalysis.types.ts'
import {
  type AnalysisRequestOptions,
  AutoMixRegistry
} from './AutoMixRegistry.ts'
import {
  autoMixTrackKey,
  safeAutoMixEnd,
  trailingSilenceStart
} from './autoMixSafety.ts'
import {
  type TrackPreAnalysisProfile,
  TransitionProfileCache
} from './MusicalAnalyzer.ts'

const registry = AutoMixRegistry.getInstance()

function point(timestampMs: number, isSilence: boolean): TemporalFeaturePoint {
  return {
    timestampMs,
    isSilence,
    rms: isSilence ? 0 : 0.1,
    peak: isSilence ? 0 : 0.2,
    bands: { low: 0, mid: 0, high: 0 },
    onset: false,
    beat: false,
    vocalActivity: 0,
    confidence: 1
  }
}

function fixture(identifier: string, windowDurationMs = 1000) {
  const stream = new PassThrough()
  let fetches = 0
  const track = {
    info: { sourceName: 'test', identifier, length: 100000 }
  } as AnalysisRequestOptions['track']
  const options: AnalysisRequestOptions = {
    track,
    urlData: {} as AnalysisRequestOptions['urlData'],
    windowStartMs: 100000 - windowDurationMs,
    windowDurationMs,
    remainingMs: 0,
    priority: 'IMMINENT_TRANSITION',
    triggerSource: 'test',
    fetchResource: async () => {
      fetches++
      return {
        stream: {
          stream,
          destroy: () => stream.destroy()
        } as unknown as Extract<
          Awaited<ReturnType<AnalysisRequestOptions['fetchResource']>>,
          { stream: unknown }
        >['stream']
      }
    }
  }
  return {
    stream,
    options,
    key: autoMixTrackKey(track),
    fetches: () => fetches
  }
}

test('cache identity includes source, rendition and duration', () => {
  const track = { info: { sourceName: 'a', identifier: 'id', length: 100 } }
  const key = autoMixTrackKey(track)
  assert.notEqual(
    key,
    autoMixTrackKey({ info: { ...track.info, sourceName: 'b' } })
  )
  assert.notEqual(key, autoMixTrackKey({ ...track, audioTrackId: 'other' }))
  assert.notEqual(
    key,
    autoMixTrackKey({ info: { ...track.info, length: 101 } })
  )
})

test('only a contiguous silent tail after observed sound qualifies', () => {
  const tail = Array.from({ length: 40 }, (_, i) => point(20 + i * 20, true))
  assert.equal(trailingSilenceStart([point(0, false), ...tail]), 20)
  assert.equal(trailingSilenceStart(tail), null)
  assert.equal(
    trailingSilenceStart([point(0, false), ...tail.slice(0, 39)]),
    null
  )
  assert.equal(
    trailingSilenceStart([
      point(0, false),
      ...tail.slice(0, 20),
      ...tail.slice(23)
    ]),
    null
  )
  assert.equal(
    trailingSilenceStart([point(0, false), ...tail, point(820, false)]),
    null
  )
})

test('end boundary rejects old profiles, incomplete coverage and explicit ends', () => {
  const profile = {
    analysisVersion: 4,
    outroProfile: {
      analyzedWindowStartMs: 75000,
      analyzedWindowEndMs: 100000,
      naturalOutroPointMs: 98700,
      analysisConfidence: 0.9,
      sourceEndRms: 0
    }
  } as TrackPreAnalysisProfile
  assert.equal(safeAutoMixEnd(100000, profile, false), 98700)
  assert.equal(safeAutoMixEnd(100000, profile, true), 100000)
  assert.equal(
    safeAutoMixEnd(100000, { ...profile, analysisVersion: 3 }, false),
    100000
  )
  const partial = {
    ...profile,
    outroProfile: { ...profile.outroProfile!, analyzedWindowEndMs: 99500 }
  }
  assert.equal(safeAutoMixEnd(100000, partial, false), 100000)
})

test('stream error after 24.5 of 25 seconds does not cache or call completion', async () => {
  const f = fixture('error', 25000)
  let calls = 0
  const result = registry.requestOutroAnalysis({
    ...f.options,
    onComplete: () => {
      calls++
    }
  })
  await nextTurn()
  const pcm = Buffer.alloc(24500 * 192)
  pcm.fill(12, 0, 23700 * 192)
  f.stream.write(pcm)
  f.stream.destroy(new Error('decoder failed'))
  assert.equal(await result, null)
  assert.equal(TransitionProfileCache.get(f.key), null)
  assert.equal(calls, 0)
})

test('premature close does not produce a profile', async () => {
  const f = fixture('close')
  const result = registry.requestOutroAnalysis(f.options)
  await nextTurn()
  f.stream.write(Buffer.alloc(500 * 192))
  f.stream.destroy()
  assert.equal(await result, null)
  assert.equal(TransitionProfileCache.get(f.key), null)
})

test('incomplete timeout does not produce a profile', async () => {
  const f = fixture('timeout')
  const result = registry.requestOutroAnalysis(f.options)
  await nextTurn()
  f.stream.write(Buffer.alloc(500 * 192))
  // Keep the test process alive while the production safety timer is unref'd.
  const guard = setTimeout(() => {}, 8000)
  try {
    assert.equal(await result, null)
    assert.equal(TransitionProfileCache.get(f.key), null)
    assert.equal(f.stream.destroyed, true)
  } finally {
    clearTimeout(guard)
  }
})

test('deduplicated consumers complete exactly once and one abort does not cancel the other', async () => {
  const f = fixture('shared')
  const first = new AbortController()
  const second = new AbortController()
  let firstCalls = 0
  let secondCalls = 0
  const a = registry.requestOutroAnalysis({
    ...f.options,
    signal: first.signal,
    onComplete: () => {
      firstCalls++
    }
  })
  const b = registry.requestOutroAnalysis({
    ...f.options,
    signal: second.signal,
    onComplete: () => {
      secondCalls++
    }
  })
  await nextTurn()
  first.abort()
  assert.equal(await a, null)
  assert.equal(f.stream.destroyed, false)
  // Split a PCM frame across chunks to exercise frame alignment.
  f.stream.write(Buffer.alloc(3))
  f.stream.end(Buffer.alloc(192000 - 3))
  const profile = await b
  assert.ok(profile)
  assert.equal(profile.outroProfile?.analyzedWindowEndMs, 100000)
  assert.equal(f.fetches(), 1)
  assert.equal(firstCalls, 0)
  assert.equal(secondCalls, 1)
})

test('last subscriber abort destroys the analysis stream and suppresses completion', async () => {
  const f = fixture('abort')
  const a = new AbortController()
  const b = new AbortController()
  let calls = 0
  const first = registry.requestOutroAnalysis({
    ...f.options,
    signal: a.signal,
    onComplete: () => {
      calls++
    }
  })
  const second = registry.requestOutroAnalysis({
    ...f.options,
    signal: b.signal,
    onComplete: () => {
      calls++
    }
  })
  await nextTurn()
  a.abort()
  assert.equal(f.stream.destroyed, false)
  b.abort()
  assert.equal(await first, null)
  assert.equal(await second, null)
  assert.equal(f.stream.destroyed, true)
  assert.equal(TransitionProfileCache.get(f.key), null)
  assert.equal(calls, 0)
})

test('initial requester callback is delivered exactly once', async () => {
  const f = fixture('single')
  let calls = 0
  const result = registry.requestOutroAnalysis({
    ...f.options,
    onComplete: () => {
      calls++
    }
  })
  await nextTurn()
  f.stream.end(Buffer.alloc(192000))
  assert.ok(await result)
  assert.equal(calls, 1)
})

test('clean but incomplete EOF cannot produce a reusable profile', async () => {
  const f = fixture('short-eof')
  const result = registry.requestOutroAnalysis(f.options)
  await nextTurn()
  f.stream.end(Buffer.alloc(500 * 192))
  assert.equal(await result, null)
  assert.equal(TransitionProfileCache.get(f.key), null)
})

test('an already aborted consumer never starts a fetch', async () => {
  const f = fixture('pre-abort')
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    await registry.requestOutroAnalysis({
      ...f.options,
      signal: controller.signal
    }),
    null
  )
  assert.equal(f.fetches(), 0)
  f.stream.destroy()
})

test('last subscriber abort closes a pending source request and releases the worker', async () => {
  const first = new AbortController()
  const last = new AbortController()
  const f = fixture('pending-acquisition')
  const state = registry as unknown as {
    activeWorkers: number
    pendingResourceFetches: number
  }
  const idle = async () => {
    const deadline = Date.now() + 2000
    while (state.activeWorkers !== 0 || state.pendingResourceFetches !== 0) {
      if (Date.now() > deadline) throw new Error('analysis worker not released')
      await nextTurn()
    }
  }
  await idle()
  let notifyRequest!: () => void
  let notifyClosed!: () => void
  const requested = new Promise<void>((resolve) => {
    notifyRequest = resolve
  })
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve
  })
  let requests = 0
  const server = createServer((_req, res) => {
    requests++
    if (requests === 1) {
      res.once('close', notifyClosed)
      notifyRequest()
      // Deliberately send no headers until the client cancels.
      return
    }
    res.end(Buffer.alloc(16))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const manager = new SourcesManager({ options: {} } as ConstructorParameters<
    typeof SourcesManager
  >[0])
  let sourceSignal: AbortSignal | undefined
  const source = {
    loadStream: async (
      _track: unknown,
      input: string,
      _protocol: unknown,
      data: Record<string, unknown>
    ) => {
      sourceSignal = data.signal as AbortSignal
      const response = await http1makeRequest(input, {
        streamOnly: true,
        maxRetries: 0
      })
      return { stream: response.stream, type: 'pcm' }
    }
  } as unknown as NonNullable<ReturnType<typeof manager.sourceMap.get>>
  manager.sourceMap.set('test', source)
  const fetchResource: AnalysisRequestOptions['fetchResource'] = async (
    track,
    _data,
    _position,
    _pcm,
    _background,
    signal
  ) => {
    const result = await manager.getTrackStream(
      track,
      url,
      undefined,
      {},
      signal
    )
    result.stream?.destroy()
    return { exception: { message: 'fixture completed' } }
  }
  try {
    const a = registry.requestOutroAnalysis({
      ...f.options,
      fetchResource,
      signal: first.signal
    })
    const b = registry.requestOutroAnalysis({
      ...f.options,
      fetchResource,
      signal: last.signal
    })
    await Promise.race([
      requested,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('source did not receive request')),
          2000
        )
        timer.unref?.()
      })
    ])
    assert.equal(state.activeWorkers, 1)
    assert.equal(requests, 1)
    first.abort()
    assert.equal(await a, null)
    assert.equal(sourceSignal?.aborted, false)
    last.abort()
    assert.equal(await b, null)
    assert.equal(sourceSignal?.aborted, true)
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('upstream connection remained open')),
          2000
        )
        timer.unref?.()
      })
    ])
    await idle()
    assert.equal(state.activeWorkers, 0)
    assert.equal(state.pendingResourceFetches, 0)
    // Same key may be requested again only after the cancelled fetch is released.
    assert.equal(
      await registry.requestOutroAnalysis({ ...f.options, fetchResource }),
      null
    )
    await idle()
    assert.equal(requests, 2)
  } finally {
    first.abort()
    last.abort()
    f.stream.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('an uncooperative source cannot start a duplicate acquisition for the cancelled key', async () => {
  const f = fixture('pending-duplicate')
  const controller = new AbortController()
  let calls = 0
  let release!: () => void
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const fetchResource: AnalysisRequestOptions['fetchResource'] = async () => {
    calls++
    await new Promise<void>((resolve) => {
      release = resolve
      started()
    })
    return { exception: { message: 'fixture complete' } }
  }
  const state = registry as unknown as {
    activeWorkers: number
    pendingResourceFetches: number
  }
  const deadline = Date.now() + 2000
  while (state.activeWorkers !== 0 || state.pendingResourceFetches !== 0) {
    if (Date.now() > deadline) throw new Error('previous worker not released')
    await nextTurn()
  }
  try {
    const result = registry.requestOutroAnalysis({
      ...f.options,
      fetchResource,
      signal: controller.signal
    })
    await ready
    controller.abort()
    assert.equal(await result, null)
    assert.equal(
      await registry.requestOutroAnalysis({ ...f.options, fetchResource }),
      null
    )
    assert.equal(calls, 1)
  } finally {
    controller.abort()
    release?.()
    f.stream.destroy()
    await nextTurn()
  }
})

test('pending HTTP/2 source acquisition is cancelled without fallback or retry', async () => {
  const controller = new AbortController()
  const f = fixture('pending-http2')
  let notifyRequest!: () => void
  let notifyClosed!: () => void
  const requested = new Promise<void>((resolve) => {
    notifyRequest = resolve
  })
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve
  })
  const sessions = new Set<ServerHttp2Session>()
  let requests = 0
  const server = createHttp2Server()
  server.on('session', (session) => {
    sessions.add(session)
    session.once('close', () => sessions.delete(session))
  })
  server.on('stream', (stream) => {
    requests++
    stream.once('close', notifyClosed)
    stream.on('error', () => {})
    notifyRequest()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  const manager = new SourcesManager({ options: {} } as ConstructorParameters<
    typeof SourcesManager
  >[0])
  const source = {
    loadStream: async (_track: unknown, input: string) => {
      const result = await makeRequest(input, {
        streamOnly: true,
        maxRetries: 0
      })
      return { stream: result.stream, type: 'pcm' }
    }
  } as unknown as NonNullable<ReturnType<typeof manager.sourceMap.get>>
  manager.sourceMap.set('test', source)
  const fetchResource: AnalysisRequestOptions['fetchResource'] = async (
    track,
    _data,
    _position,
    _pcm,
    _background,
    signal
  ) => {
    const result = await manager.getTrackStream(
      track,
      url,
      undefined,
      {},
      signal
    )
    result.stream?.destroy()
    return { exception: { message: 'fixture completed' } }
  }
  const state = registry as unknown as {
    activeWorkers: number
    pendingResourceFetches: number
  }
  const within = async (promise: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('HTTP/2 cancellation deadline exceeded')),
            2000
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const pending = registry.requestOutroAnalysis({
      ...f.options,
      fetchResource,
      signal: controller.signal
    })
    await within(requested)
    controller.abort()
    assert.equal(await pending, null)
    await within(closed)
    const deadline = Date.now() + 2000
    while (state.activeWorkers !== 0 || state.pendingResourceFetches !== 0) {
      if (Date.now() > deadline) throw new Error('HTTP/2 worker not released')
      await nextTurn()
    }
    assert.equal(requests, 1)
  } finally {
    controller.abort()
    f.stream.destroy()
    for (const session of sessions) session.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
