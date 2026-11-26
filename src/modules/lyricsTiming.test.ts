import assert from 'node:assert/strict'
import test from 'node:test'
import type { LyricsData } from '../managers/lyricsManager.ts'
import { alignLyrics } from './lyricsAligner.ts'
import {
  enrichTemporalMetadata,
  getLyricsQualityTier,
  readLyricsTimestamp
} from './lyricsTiming.ts'

test('invalid tokens do not imply token synchronization', () => {
  const data: LyricsData = {
    synced: true,
    lines: [
      {
        text: 'Example',
        time: 0,
        duration: 1000,
        words: [{ text: 'Example', time: 'bad' }]
      }
    ]
  }
  enrichTemporalMetadata(data, 2000)
  assert.deepEqual(data.timing, {
    granularity: 'line',
    totalLines: 1,
    timedLines: 1,
    tokenTimedLines: 0
  })
  assert.equal(getLyricsQualityTier({ loadType: 'lyrics', data }), 2)
  assert.equal(readLyricsTimestamp(''), undefined)
  assert.equal(readLyricsTimestamp('0'), 0)
})

test('mixed coverage is explicit and overlapping vocals use the latest ending', () => {
  const data: LyricsData = {
    synced: true,
    lines: [
      {
        text: 'Lead',
        time: 1000,
        duration: 5000,
        words: [{ text: 'Lead', timestamp: '1000' }]
      },
      { text: 'Harmony', time: 2000, duration: 500, isBackground: true }
    ]
  }
  enrichTemporalMetadata(data, 8000)
  assert.deepEqual(data.timing, {
    granularity: 'token',
    totalLines: 2,
    timedLines: 2,
    tokenTimedLines: 1
  })
  assert.equal(data.introEndMs, 1000)
  assert.equal(data.outroStartMs, 6000)
})

test('unknown ending and unsynchronized lines never invent an outro', () => {
  const data: LyricsData = {
    synced: true,
    lines: [{ text: 'Ending', time: 1000, duration: 0 }]
  }
  enrichTemporalMetadata(data, 3000)
  assert.equal(data.outroStartMs, undefined)
  data.synced = false
  enrichTemporalMetadata(data, 3000)
  assert.equal(data.timing?.granularity, 'none')
  assert.equal(getLyricsQualityTier({ loadType: 'lyrics', data }), 1)
  assert.equal(
    getLyricsQualityTier({ loadType: 'lyrics', data: { lines: [] } }),
    0
  )
})

test('alignment preserves unmatched text and timestamps', () => {
  const original = [{ text: 'alpha beta gamma', time: 1000, duration: 1000 }]
  const captions = {
    lines: [{ text: 'different words entirely', time: 3000, duration: 1000 }]
  }
  assert.deepEqual(alignLyrics(original, captions), original)
})

test('alignment supports Unicode and numeric-string token timestamps', () => {
  const original = [
    {
      text: '世界 你好',
      time: 1000,
      duration: 1000,
      words: [{ text: '世界', time: '1000', duration: 400 }]
    }
  ]
  const captions = {
    lines: [{ text: '世界 你好', time: 3000, duration: 1000 }]
  }
  const aligned = alignLyrics(original, captions)
  assert.equal(aligned[0]?.time, 3000)
  assert.equal(aligned[0]?.words?.[0]?.time, '3000')
})
