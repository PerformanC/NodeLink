import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { acquireAnalysisResource } from './analysisResource.ts'

test('aborted acquisition releases late resource exactly once', async () => {
  const controller = new AbortController()
  let complete!: (value: { id: number }) => void
  let disposed = 0
  const pending = acquireAnalysisResource(
    () => new Promise<{ id: number }>(resolve => { complete = resolve }),
    () => { disposed++ }, controller.signal, 1000
  )
  await nextTurn()
  controller.abort()
  assert.equal(await pending, null)
  complete({ id: 1 })
  await nextTurn()
  assert.equal(disposed, 1)
})
test('timeout releases late resource and settles promptly', async () => {
  let complete!: (value: { id: number }) => void
  let disposed = 0
  const pending = acquireAnalysisResource(
    () => new Promise<{ id: number }>(resolve => { complete = resolve }),
    () => { disposed++ }, new AbortController().signal, 10
  )
  assert.equal(await pending, null)
  complete({ id: 1 })
  await nextTurn()
  assert.equal(disposed, 1)
})
test('normal completion does not dispose a returned resource', async () => {
  const resource = { id: 1 }
  const controller = new AbortController()
  let disposed = 0
  assert.equal(await acquireAnalysisResource(async () => resource, () => { disposed++ }, controller.signal, 100), resource)
  controller.abort()
  assert.equal(disposed, 0)
})

test('already aborted acquisition does not invoke the source', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  assert.equal(await acquireAnalysisResource(async () => { calls++; return {} }, () => {}, controller.signal, 100), null)
  assert.equal(calls, 0)
})

test('rejected acquisition settles without an unhandled rejection', async () => {
  assert.equal(await acquireAnalysisResource(async () => { throw new Error('source') }, () => {}, new AbortController().signal, 100), null)
})

test('acquisition timeout aborts the actual signal passed to the source', async () => {
  let cancelled = false
  const result = await acquireAnalysisResource(
    (signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        cancelled = true
        reject(signal.reason)
      }, { once: true })
    }),
    () => {},
    new AbortController().signal,
    10
  )
  assert.equal(result, null)
  assert.equal(cancelled, true)
})
