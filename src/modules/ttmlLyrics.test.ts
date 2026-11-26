import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTtmlLyrics, parseTtmlTime } from './ttmlLyrics.ts'

test('preserves timed nested spans and separates simultaneous background vocals', () => {
  const xml =
    '<tt><body><div itunes:songPart="Chorus"><p begin="1s" end="4s" ttm:agent="v1"><span begin="1s" end="2s"><span>Hel</span>lo</span> <span begin="2s" end="3s">world</span><span ttm:role="x-bg" ttm:agent="v2" begin="2s" end="4s"><span begin="2s" end="4s">Echo</span></span></p></div></body></tt>'
  const result = parseTtmlLyrics(xml)
  assert.equal(result.synced, true)
  assert.deepEqual(result.lines, [
    {
      text: 'Hello world',
      time: 1000,
      duration: 3000,
      words: [
        { text: 'Hello', time: 1000, duration: 1000 },
        { text: 'world', time: 2000, duration: 1000 }
      ],
      section: 'Chorus',
      agent: 'v1'
    },
    {
      text: 'Echo',
      time: 2000,
      duration: 2000,
      words: [{ text: 'Echo', time: 2000, duration: 2000 }],
      section: 'Chorus',
      agent: 'v2',
      isBackground: true
    }
  ])
})

test('keeps different voices, excludes alternate text and does not invent timing', () => {
  const result = parseTtmlLyrics(
    '<tt><body><p ttm:agent="a">Primary<span ttm:role="x-translation">Alternate</span></p><p ttm:agent="b">Other &amp; &#x1F600;</p></body></tt>'
  )
  assert.equal(result.synced, false)
  assert.deepEqual(
    result.lines.map(({ text, agent }) => ({ text, agent })),
    [
      { text: 'Primary', agent: 'a' },
      { text: 'Other & 😀', agent: 'b' }
    ]
  )
})

test('malformed XML and external declarations are rejected', () => {
  assert.deepEqual(parseTtmlLyrics('<tt><p>Broken</tt>'), {
    lines: [],
    synced: false
  })
  assert.deepEqual(
    parseTtmlLyrics(
      '<!DOCTYPE tt [<!ENTITY ext SYSTEM "file:///example">]><tt><p>&ext;</p></tt>'
    ),
    { lines: [], synced: false }
  )
  assert.equal(
    parseTtmlLyrics('<tt><p>&#99999999;</p></tt>').lines[0]?.text,
    '&#99999999;'
  )
})

test('validates clock and offset timing', () => {
  assert.equal(parseTtmlTime('01:02.345'), 62345)
  assert.equal(parseTtmlTime('1:02:03.5'), 3723500)
  assert.equal(parseTtmlTime('1.5s'), 1500)
  assert.equal(parseTtmlTime('0ms'), 0)
  assert.equal(parseTtmlTime('00:75'), undefined)
  assert.equal(parseTtmlTime('00:01:02:15'), undefined)
  assert.equal(parseTtmlTime('-1s'), undefined)
})

test('preserves explicit translations and romanization outside the primary text', () => {
  const result = parseTtmlLyrics(
    '<tt><body><p begin="1s" end="2s">Hello<span ttm:role="x-translation" xml:lang="es">Hola</span><span ttm:role="x-romanization">Hello</span></p></body></tt>'
  )
  assert.equal(result.lines[0]?.text, 'Hello')
  assert.deepEqual(result.lines[0]?.alternatives, [
    { kind: 'translation', text: 'Hola', language: 'es' },
    { kind: 'romanization', text: 'Hello' }
  ])
})
