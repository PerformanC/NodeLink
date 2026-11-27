import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
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
  return { stream, options, key: autoMixTrackKey(track), fetches: () => fetches }
}

test('cache identity includes source, rendition and duration', () => {
  const track = { info: { sourceName: 'a', identifier: 'id', length: 100 } }
  const key = autoMixTrackKey(track)
  assert.notEqual(key, autoMixTrackKey({ info: { ...track.info, sourceName: 'b' } }))
  assert.notEqual(key, autoMixTrackKey({ ...track, audioTrackId: 'other' }))
  assert.notEqual(key, autoMixTrackKey({ info: { ...track.info, length: 101 } }))
})

test('only a contiguous silent tail after observed sound qualifies', () => {
  const tail = Array.from({ length: 40 }, (_, i) => point(20 + i * 20, true))
  assert.equal(trailingSilenceStart([point(0, false), ...tail]), 20)
  assert.equal(trailingSilenceStart(tail), null)
  assert.equal(trailingSilenceStart([point(0, false), ...tail.slice(0, 39)]), null)
  assert.equal(trailingSilenceStart([point(0, false), ...tail.slice(0, 20), ...tail.slice(23)]), null)
  assert.equal(trailingSilenceStart([point(0, false), ...tail, point(820, false)]), null)
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
  assert.equal(safeAutoMixEnd(100000, { ...profile, analysisVersion: 3 }, false), 100000)
  const partial = {
    ...profile,
    outroProfile: { ...profile.outroProfile!, analyzedWindowEndMs: 99500 }
  }
  assert.equal(safeAutoMixEnd(100000, partial, false), 100000)
})

test('stream error after 24.5 of 25 seconds does not cache or call completion', async () => {
  const f = fixture('error', 25000)
  let calls = 0
  const result = registry.requestOutroAnalysis({ ...f.options, onComplete: () => { calls++ } })
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
  const a = registry.requestOutroAnalysis({ ...f.options, signal: first.signal, onComplete: () => { firstCalls++ } })
  const b = registry.requestOutroAnalysis({ ...f.options, signal: second.signal, onComplete: () => { secondCalls++ } })
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
  const first = registry.requestOutroAnalysis({ ...f.options, signal: a.signal, onComplete: () => { calls++ } })
  const second = registry.requestOutroAnalysis({ ...f.options, signal: b.signal, onComplete: () => { calls++ } })
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
  const result = registry.requestOutroAnalysis({ ...f.options, onComplete: () => { calls++ } })
  await nextTurn()
  f.stream.end(Buffer.alloc(192000))
  assert.ok(await result)
  assert.equal(calls, 1)
})
