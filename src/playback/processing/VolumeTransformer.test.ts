import assert from 'node:assert/strict'
import { test } from 'node:test'
import { VolumeTransformer } from './VolumeTransformer.ts'

function render(chunks: number[]) {
  const volume = new VolumeTransformer({ volume: 0, sampleRate: 48000, channels: 2, fadeDurationMs: 10, fadeCurve: 'linear', enableAGC: false, lookaheadMs: 0 })
  volume.setVolume(1)
  const output: Buffer[] = []
  for (const frames of chunks) {
    const buffer = Buffer.alloc(frames * 8)
    for (let offset = 0; offset < buffer.length; offset += 4) buffer.writeFloatLE(0.5, offset)
    output.push(volume.processFloat32(buffer))
  }
  volume.destroy()
  return Buffer.concat(output)
}

test('protected gain ramp is frame-coherent and independent of chunk boundaries', () => {
  const one = render([960])
  const split = render([1, 79, 200, 3, 197, 480])
  assert.deepEqual(one, split)
  for (let i = 0; i < 960; i++) {
    const left = one.readFloatLE(i * 8)
    assert.equal(left, one.readFloatLE(i * 8 + 4))
    assert.ok(Math.abs(left - 0.5 * Math.min(1, (i + 1) / 480)) < 1e-7)
  }
})

test('protected volume preserves headroom and rejects incomplete stereo frames', () => {
  const volume = new VolumeTransformer({ volume: 2, enableAGC: false })
  try {
    const input = Buffer.alloc(8)
    input.writeFloatLE(0.8, 0)
    input.writeFloatLE(-0.8, 4)
    const output = volume.processFloat32(input)
    assert.ok(output.readFloatLE(0) > 1)
    assert.ok(output.readFloatLE(4) < -1)
    assert.throws(() => volume.processFloat32(Buffer.alloc(4)), RangeError)
  } finally {
    volume.destroy()
  }
})
