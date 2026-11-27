import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MusicAnalysis } from './MusicAnalysis.ts'
import { MusicalAnalyzer } from './MusicalAnalyzer.ts'

test('an estimator failure does not interrupt PCM output', async () => {
  const observer = new MusicAnalysis()
  const errors: unknown[] = []
  const output: Buffer[] = []
  observer.on('analysisFailure', (error) => errors.push(error))
  observer.on('data', (chunk: Buffer) => output.push(chunk))
  const internals = observer as unknown as {
    musical: { pushPcm: (frame: Buffer) => void }
  }
  internals.musical.pushPcm = () => {
    throw new Error('fixture failure')
  }
  const done = once(observer, 'end')
  const first = Buffer.alloc(3840, 1)
  const second = Buffer.alloc(3840, 2)
  observer.write(first)
  observer.end(second)
  await done
  assert.equal(errors.length, 1)
  assert.equal(observer.snapshot(), null)
  assert.deepEqual(Buffer.concat(output), Buffer.concat([first, second]))
})

test('output clock rolls over bounded analysis windows without dropping PCM', async () => {
  const observer = new MusicAnalysis()
  let bytes = 0
  observer.on('data', (chunk: Buffer) => {
    bytes += chunk.length
  })
  const frame = Buffer.alloc(3840)
  const done = once(observer, 'end')
  for (let i = 0; i < 800; i++) observer.write(frame)
  observer.end()
  await done
  assert.equal(bytes, 800 * frame.length)
  const snapshot = observer.snapshot()
  assert.ok(snapshot)
  assert.equal(snapshot.outputWindowStartMs, 12000)
  assert.equal(snapshot.outputWindowEndMs, 16000)
  assert.equal(snapshot.analyzedMs, 4000)
  assert.equal(snapshot.silenceRatio, 1)
  assert.equal(snapshot.bpm, null)
  assert.equal(snapshot.key, null)
})

test('brief audible bursts do not expose tempo or key estimates', async () => {
  const observer = new MusicAnalysis()
  observer.resume()
  const done = once(observer, 'end')
  const frame = Buffer.alloc(3840)
  for (let i = 0; i < 960; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 12000)
    frame.writeInt16LE(sample, i * 4)
    frame.writeInt16LE(sample, i * 4 + 2)
  }
  for (let i = 0; i < 20; i++) observer.write(frame)
  observer.end(Buffer.alloc(180 * 3840))
  await done
  const snapshot = observer.snapshot()
  assert.ok(snapshot)
  assert.equal(snapshot.bpm, null)
  assert.equal(snapshot.bpmConfidence, 0)
  assert.equal(snapshot.key, null)
  assert.equal(snapshot.keyConfidence, 0)
})

test('chroma filter advances its feedback state', () => {
  const analyzer = new MusicalAnalyzer()
  const frame = Buffer.alloc(3840)
  frame.writeInt16LE(12000, 0)
  frame.writeInt16LE(12000, 2)
  analyzer.pushPcm(frame)
  const internals = analyzer as unknown as {
    chromaFilters: Array<{ y1: number; y2: number }>
  }
  assert.ok(internals.chromaFilters.every((filter) => Number.isFinite(filter.y1)))
  assert.ok(internals.chromaFilters.some((filter) => Math.abs(filter.y1) > 1e-9))
})
