import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { MusicAnalysis } from './MusicAnalysis.ts'

test('an estimator failure does not interrupt PCM output', async () => {
  const observer = new MusicAnalysis()
  const errors: unknown[] = []
  const output: Buffer[] = []
  observer.on('analysisFailure', (error) => errors.push(error))
  observer.on('data', (chunk: Buffer) => output.push(chunk))
  const internals = observer as unknown as { musical: { pushPcm: (frame: Buffer) => void } }
  internals.musical.pushPcm = () => { throw new Error('fixture failure') }
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
