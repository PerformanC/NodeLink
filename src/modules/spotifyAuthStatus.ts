/** HTTP status from an unsuccessful Spotify token request. */
export class SpotifyAuthError extends Error {
  readonly status: number | undefined

  constructor(status: number | undefined) {
    super(`Spotify Auth Error: ${status}`)
    this.name = 'SpotifyAuthError'
    this.status = status
  }
}

/** An explicit authorization rejection is terminal for this request. */
export function isSpotifyAuthRejection(error: unknown): error is SpotifyAuthError {
  return error instanceof SpotifyAuthError && (error.status === 401 || error.status === 403)
}
