import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseTtmlLyrics, parseTtmlTime } from './ttmlLyrics.ts'

test('TTML rejects external entity definitions and over-deep input', () => {
  assert.deepEqual(
    parseTtmlLyrics(
      '<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///fixture">]><tt><p>&x;</p></tt>'
    ),
    { lines: [], synced: false }
  )
  assert.deepEqual(
    parseTtmlLyrics(
      '<tt>' +
        '<div>'.repeat(65) +
        '<p>word</p>' +
        '</div>'.repeat(65) +
        '</tt>'
    ),
    { lines: [], synced: false }
  )
})

test('TTML keeps explicitly timed tokens and does not invent missing duration', () => {
  const result = parseTtmlLyrics(
    '<tt><body><div><p begin="1s" end="2s"><span begin="1s">hello</span></p></div></body></tt>'
  )
  assert.equal(result.synced, true)
  assert.equal(result.lines[0]?.time, 1000)
  assert.equal(result.lines[0]?.duration, 1000)
  assert.equal(result.lines[0]?.words?.[0]?.duration, 0)
  assert.equal(parseTtmlTime('12f'), undefined)
})

test('mixed timed and untimed TTML does not claim full synchronization', () => {
  const result = parseTtmlLyrics(
    '<tt><body><div><p begin="1s">timed</p><p>untimed</p></div></body></tt>'
  )
  assert.equal(result.lines.length, 2)
  assert.equal(result.synced, false)
})
