import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioVisualization } from './AudioVisualization.ts'

test('observes a stereo tone without changing bytes, even across partial frames', () => {
  const tap = new AudioVisualization()
  const audio = Buffer.alloc(4800 * 4)
  for (let i = 0; i < 4800; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 1000 * i) / 48000) * 16000)
    audio.writeInt16LE(v, i * 4)
    audio.writeInt16LE(-v, i * 4 + 2)
  }
  const chunks: Buffer[] = []
  tap.on('data', (chunk) => chunks.push(chunk))
  tap.write(audio.subarray(0, 3))
  tap.write(audio.subarray(3, 105))
  tap.end(audio.subarray(105))
  assert.deepEqual(Buffer.concat(chunks), audio)
  const result = tap.snapshot()
  assert.ok(result)
  assert.ok(Math.abs(result.rms[0] - 0.345) < 0.02)
  assert.ok(Math.abs(result.peak[1] - 16000 / 32768) < 0.01)
  assert.equal(
    result.spectrum.reduce((best, item) =>
      item.magnitude > best.magnitude ? item : best
    ).hz,
    1000
  )
  assert.equal(result.waveform.length, 32)
})
test('silence is zero and stale snapshots expire', (t) => {
  let now = 1000
  t.mock.method(Date, 'now', () => now)
  const tap = new AudioVisualization()
  tap.resume()
  tap.write(Buffer.alloc(4800 * 4))
  assert.deepEqual(tap.snapshot()?.peak, [0, 0])
  assert.ok(tap.snapshot()?.spectrum.every((v) => v.magnitude === 0))
  now += 1001
  assert.equal(tap.snapshot(), null)
  tap.destroy()
})
