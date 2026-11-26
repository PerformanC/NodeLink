import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSpotifyAuthRejection,
  SpotifyAuthError
} from './spotifyAuthStatus.ts'

test('classifies explicit authentication and permission rejection as terminal', () => {
  for (const status of [401, 403]) {
    const error = new SpotifyAuthError(status)
    assert.equal(error.status, status)
    assert.equal(isSpotifyAuthRejection(error), true)
  }
})

test('does not classify transport, rate limit, or other HTTP errors as rejection', () => {
  for (const status of [400, 429, 500, 503, undefined]) {
    assert.equal(isSpotifyAuthRejection(new SpotifyAuthError(status)), false)
  }
  assert.equal(
    isSpotifyAuthRejection(new Error('Spotify Auth Error: 401')),
    false
  )
  assert.equal(isSpotifyAuthRejection(null), false)
})
