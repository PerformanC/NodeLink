/** biome-ignore-all lint/complexity/useLiteralKeys: <for performance> */
import { SAMPLE_RATE } from '../../../constants.ts'
import { Waveforms } from './waves.ts'

/**
 * Low Frequency Oscillator for modulating audio parameters.
 * @public
 */
export default class LFO {
  public phase: number
  private waveform: (phase: number) => number
  private _frequency: number
  private _depth: number

  /**
   * Creates a new LFO.
   * @param waveformName - The waveform type (e.g., 'SINE', 'SQUARE').
   * @param frequency - The modulation frequency in Hz.
   * @param depth - The modulation depth.
   */
  constructor(waveformName = 'SINE', frequency = 0, depth = 0) {
    this.phase = 0
    const wf = Waveforms[waveformName] ?? Waveforms['SINE']
    this.waveform = (wf as (phase: number) => number) ?? Waveforms['SINE']
    this._frequency = frequency
    this._depth = depth
  }

  /**
   * Returns the current frequency.
   */
  public get frequency(): number {
    return this._frequency
  }

  /**
   * Returns the current depth.
   */
  public get depth(): number {
    return this._depth
  }

  /**
   * Sets the waveform generator.
   * @param waveformName - The waveform type.
   */
  public setWaveform(waveformName: string): void {
    const wf = Waveforms[waveformName] ?? Waveforms['SINE']
    this.waveform = (wf as (phase: number) => number) ?? Waveforms['SINE']
  }

  /**
   * Updates the modulation parameters.
   * @param frequency - The new frequency in Hz.
   * @param depth - The new modulation depth.
   */
  public update(frequency: number, depth: number): void {
    this._frequency = frequency
    this._depth = depth
  }

  /**
   * Calculates the current oscillation value and advances the phase.
   * @returns The current LFO value.
   */
  public getValue(): number {
    if (this._frequency === 0) {
      return 0
    }
    const value = this.waveform(this.phase)
    this.phase += (2 * Math.PI * this._frequency) / SAMPLE_RATE
    if (this.phase > 2 * Math.PI) {
      this.phase -= 2 * Math.PI
    }
    return value
  }

  /**
   * Processes the LFO to get a modulation factor.
   * @returns A modulation factor (typically 0.0 to 1.0).
   */
  public process(): number {
    if (this._depth === 0 || this._frequency === 0) {
      return 1.0
    }
    const lfoValue = this.getValue()
    const normalizedLfo = (lfoValue + 1) / 2

    return 1.0 - this._depth * normalizedLfo
  }
}
