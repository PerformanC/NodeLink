import assert from 'node:assert/strict'
import { test } from 'node:test'
import { protectedProcessingOptions } from './protectedProcessingOptions.ts'

test('defaults preserve existing protected settings', () => {
  assert.deepEqual(protectedProcessingOptions(), { targetLoudnessLufs: -14, ceilingDbTP: -2.4, lookaheadMs: 5, releaseMs: 80, telemetry: false })
})
test('invalid and nonfinite settings fall back to safe defaults', () => {
  assert.deepEqual(protectedProcessingOptions({ targetLoudnessLufs: Infinity, ceilingDbTP: 0, lookaheadMs: NaN, releaseMs: 501 }), protectedProcessingOptions())
})
test('accepted boundary values and explicit telemetry are preserved', () => {
  assert.deepEqual(protectedProcessingOptions({ targetLoudnessLufs: -30, ceilingDbTP: -12, lookaheadMs: 20, releaseMs: 500, telemetry: true }), { targetLoudnessLufs: -30, ceilingDbTP: -12, lookaheadMs: 20, releaseMs: 500, telemetry: true })
})
