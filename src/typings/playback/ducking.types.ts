/**
 * Configuration options for the DuckingController.
 */
export interface DuckingConfig {
  /** Whether ducking is currently enabled. */
  enabled: boolean
  /** Fade duration in milliseconds when ducking activates/deactivates. */
  duration: number
  /** Target volume multiplier when someone is speaking (0.0 to 1.0). */
  targetVolume: number
  /** Fade curve name to use for transitions. */
  curve: string
}

/**
 * Callback interface for the DuckingController to control audio stream volume.
 */
export interface DuckingStreamControl {
  /** Fades the audio stream to a target volume over a duration. */
  fadeTo: (volume: number, durationMs: number, curve?: string) => void
}
