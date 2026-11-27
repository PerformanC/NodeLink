import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { AudioVisualization } from './AudioVisualization.ts'

async function render(input: Buffer, sizes: number[] = [input.length]) {
  const observer = new AudioVisualization()
  const chunks: Buffer[] = []
  observer.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = once(observer, 'end')
  let offset = 0
  let index = 0
  while (offset < input.length) {
    const size = sizes[index++ % sizes.length]!
    observer.write(input.subarray(offset, offset + size))
    offset += size
  }
  observer.end()
  await done
  assert.deepEqual(Buffer.concat(chunks), input)
  return observer.snapshot()
}

test('peak outside the original 1024-frame window is retained', async () => {
  const input = Buffer.alloc(4800 * 4)
  input.writeInt16LE(16384, 2400 * 4)
  input.writeInt16LE(-24576, 2400 * 4 + 2)
  const snapshot = await render(input)
  assert.ok(snapshot)
  assert.equal(snapshot.outputFrame, 4800)
  assert.deepEqual(snapshot.peak, [0.5, 0.75])
  assert.equal(snapshot.waveform[16], 0.75)
  assert.ok(Math.abs(snapshot.rms[0] - 0.5 / Math.sqrt(4800)) < 1e-12)
})

test('partial frames preserve bytes and statistics', async () => {
  const input = Buffer.alloc(4800 * 4)
  for (let i = 0; i < 4800; i++) {
    input.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 1000 * i) / 48000) * 12000),
      i * 4
    )
    input.writeInt16LE(-input.readInt16LE(i * 4), i * 4 + 2)
  }
  const a = await render(input)
  const b = await render(input, [1, 3, 819, 4097, 2])
  assert.ok(a && b)
  assert.deepEqual({ ...a, capturedAt: 0 }, { ...b, capturedAt: 0 })
  const strongest = [...a.spectrum].sort((x, y) => y.magnitude - x.magnitude)[0]
  assert.equal(strongest?.hz, 1000)
})

test('interval statistics reset after a loud interval', async () => {
  const input = Buffer.alloc(9600 * 4)
  input.writeInt16LE(32767, 20 * 4)
  const snapshot = await render(input)
  assert.ok(snapshot)
  assert.equal(snapshot.outputFrame, 9600)
  assert.deepEqual(snapshot.peak, [0, 0])
  assert.deepEqual(snapshot.rms, [0, 0])
})

test('snapshot expiry and caller mutation do not leak observer state', async () => {
  const observer = new AudioVisualization()
  observer.resume()
  const done = once(observer, 'end')
  observer.end(Buffer.alloc(4800 * 4))
  await done
  const snapshot = observer.snapshot()
  assert.ok(snapshot)
  snapshot.waveform[0] = 1
  assert.equal(observer.snapshot()?.waveform[0], 0)
  const clock = Date.now
  try {
    Date.now = () => snapshot.capturedAt + 1001
    assert.equal(observer.snapshot(), null)
  } finally {
    Date.now = clock
  }
})
