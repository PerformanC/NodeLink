import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activeLyricsIndices,
  buildPlaybackLyrics,
  hasCompleteLyricsTiming,
  nextLyricsExpiry
} from './playbackLyrics.ts'

test('zero is a valid timestamp, missing and invalid times are not', () => {
  assert.equal(
    hasCompleteLyricsTiming({
      synced: true,
      lines: [{ time: 0 }, { time: 120 }]
    }),
    true
  )
  for (const time of [undefined, null, NaN, Infinity, -1, '', 'no']) {
    assert.equal(
      hasCompleteLyricsTiming({
        synced: true,
        lines: [{ time: 100 }, { time }]
      }),
      false
    )
  }
  assert.equal(
    hasCompleteLyricsTiming({ synced: false, lines: [{ time: 0 }] }),
    false
  )
  assert.equal(hasCompleteLyricsTiming({ synced: true, lines: [] }), false)
})

test('overlapping voices are removed at their actual end', () => {
  const lines = [
    { timestamp: 100, duration: 2000, line: 'main', words: [], plugin: {} },
    {
      timestamp: 200,
      duration: 200,
      line: 'bg',
      words: [],
      plugin: { isBackground: true }
    }
  ]
  assert.deepEqual(activeLyricsIndices(lines, 250), [0, 1])
  assert.deepEqual(activeLyricsIndices(lines, 400), [0])
})

test('partially timed payload stays in provider order', () => {
  const data = {
    synced: true,
    provider: 'fixture',
    lines: [
      { time: 1200, duration: 500, text: 'first' },
      { time: NaN, duration: 0, text: 'second' }
    ]
  } as Parameters<typeof buildPlaybackLyrics>[0]
  assert.equal(hasCompleteLyricsTiming(data), false)
  assert.deepEqual(
    buildPlaybackLyrics(data).map((line) => line.line),
    ['first', 'second']
  )
})

test('expiry of a background voice is scheduled before the primary line ends', () => {
  const lines = [
    { timestamp: 100, duration: 2000, line: 'main', words: [], plugin: {} },
    {
      timestamp: 200,
      duration: 200,
      line: 'bg',
      words: [],
      plugin: { isBackground: true }
    }
  ]
  assert.equal(nextLyricsExpiry(lines, 250), 400)
  assert.equal(nextLyricsExpiry(lines, 400), 2100)
  assert.equal(nextLyricsExpiry(lines, 2100), undefined)
})
