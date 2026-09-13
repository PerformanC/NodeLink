import {
  Transform,
  type TransformCallback,
  type TransformOptions
} from 'node:stream'
import type {
  FilterClass,
  FilterInstance,
  FilterSettings,
  FiltersManagerContext
} from '../../typings/playback/filters.types.ts'
import type { FiltersState } from '../../typings/playback/player.types.ts'
import type { IFiltersManager } from '../../typings/playback/processing.types.ts'

import ChannelMix from '../filters/channelMix.ts'
import Chorus from '../filters/chorus.ts'
import Compressor from '../filters/compressor.ts'
import Distortion from '../filters/distortion.ts'
import Echo from '../filters/echo.ts'
import Equalizer from '../filters/equalizer.ts'
import Flanger from '../filters/flanger.ts'
import Highpass from '../filters/highpass.ts'
import Karaoke from '../filters/karaoke.ts'
import Lowpass from '../filters/lowpass.ts'
import Phaser from '../filters/phaser.ts'
import Phonograph from '../filters/phonograph.ts'
import Reverb from '../filters/reverb.ts'
import Rotation from '../filters/rotation.ts'
import Spatial from '../filters/spatial.ts'
import Tesseract from '../filters/tesseract.ts'
import Timescale from '../filters/timescale.ts'
import Tremolo from '../filters/tremolo.ts'
import Vibrato from '../filters/vibrato.ts'

const FILTER_CLASSES: Record<string, FilterClass> = {
  tremolo: Tremolo,
  vibrato: Vibrato,
  lowpass: Lowpass,
  highpass: Highpass,
  rotation: Rotation,
  karaoke: Karaoke,
  distortion: Distortion,
  channelMix: ChannelMix,
  equalizer: Equalizer,
  chorus: Chorus,
  compressor: Compressor,
  echo: Echo,
  phaser: Phaser,
  timescale: Timescale,
  spatial: Spatial,
  reverb: Reverb,
  flanger: Flanger,
  phonograph: Phonograph,
  tesseract: Tesseract
}
const CANONICAL_KEY_MAP: Record<string, string> = {}
for (const key in FILTER_CLASSES) {
  CANONICAL_KEY_MAP[key.toLowerCase()] = key
}

/**
 * Manages the active filter chain and applies it to PCM buffers.
 * @example
 * ```ts
 * const manager = new FiltersManager(nodelink, { filters: { timescale: { speed: 1.1 } } })
 * stream.pipe(manager).on('data', (chunk) => console.log(chunk.length))
 * ```
 * @public
 */
export class FiltersManager extends Transform implements IFiltersManager {
  /**
   * NodeLink context containing configuration and extensions.
   * @internal
   */
  private readonly nodelink: FiltersManagerContext

  /**
   * Ordered sequence of filter instances currently processing the audio stream.
   * @internal
   */
  private activeFilters: FilterInstance[]

  /**
   * Map of all available filter instances by their canonical name.
   * @internal
   */
  private filterInstances: Record<string, FilterInstance>

  /**
   * When true, _transform passes chunks through without processing.
   * Used by transition handling to avoid double-processing: the upstream
   * _transform would advance stateful filter buffers (echo delay lines,
   * reverb decay) with Track A data while filterProcessor separately
   * processes Track B — causing cross-contamination and 2x state advance.
   */
  public bypass = false

  /**
   * Creates a new filter manager.
   * @param nodelink - NodeLink context for extensions.
   * @param initialFilters - Initial filter payload.
   * @param options - Transform options for the stream pipeline.
   */
  constructor(
    nodelink: FiltersManagerContext,
    initialFilters: FiltersState = {},
    options: TransformOptions = {}
  ) {
    super(options)
    this.nodelink = nodelink
    this.activeFilters = []
    this.filterInstances = {}

    if (this.nodelink.extensions?.filters) {
      for (const [name, filter] of this.nodelink.extensions.filters) {
        this.filterInstances[name] = filter
      }
    }

    this.update(initialFilters)
  }

  /**
   * Updates the active filter chain using a new filter payload.
   * @param filters - Filter settings (supports `{ filters: {...} }` or direct map).
   */
  update(filters: FiltersState | FilterSettings): void {
    const settings = this._normalizeFilters(filters)

    const normalizedSettings: Record<string, unknown> = {}
    for (const name in settings) {
      const canonical =
        CANONICAL_KEY_MAP[name.toLowerCase()] ?? name.toLowerCase()
      normalizedSettings[canonical] = (settings as Record<string, unknown>)[
        name
      ]
    }

    const updatedKeys = new Set<string>()

    for (const name in normalizedSettings) {
      const config = normalizedSettings[name]
      if (!config) continue

      updatedKeys.add(name)

      if (FILTER_CLASSES[name] && !this.filterInstances[name]) {
        this.filterInstances[name] = new FILTER_CLASSES[name]()
      }

      const instance = this.filterInstances[name]
      if (instance?.update) {
        instance.update(normalizedSettings as FilterSettings)
      }
    }

    this.activeFilters = []
    for (const name in this.filterInstances) {
      const instance = this.filterInstances[name]
      if (!instance) continue

      if (updatedKeys.has(name)) {
        this.activeFilters.push(instance)
      } else if (instance.isActive?.()) {
        this.activeFilters.push(instance)
      }
    }

    this.activeFilters.sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  }

  /**
   * Processes a PCM buffer through the active filter chain.
   * @param chunk - PCM audio chunk.
   */
  process(chunk: Buffer): Buffer {
    if (this.bypass) return chunk
    if (this.activeFilters.length === 0) return chunk

    let processed = chunk
    for (const filter of this.activeFilters) {
      if (filter.isActive?.() === false) continue
      processed = filter.process(processed)
    }
    return processed
  }

  /**
   * Flushes any buffered filter data.
   */
  flush(): Buffer {
    const flushedChunks: Buffer[] = []
    let totalLength = 0

    for (const filter of this.activeFilters) {
      if (filter.flush) {
        const flushed = filter.flush()
        if (flushed && flushed.length > 0) {
          flushedChunks.push(flushed)
          totalLength += flushed.length
        }
      }
    }

    if (flushedChunks.length === 0) return Buffer.alloc(0)
    if (flushedChunks.length === 1) return flushedChunks[0] as Buffer
    return Buffer.concat(flushedChunks, totalLength)
  }

  /**
   * Returns the current playback rate from the timescale filter.
   * When bypass is active, the timescale filter is not processing audio
   * so the effective rate is always 1.0 regardless of the filter's
   * configured value.
   */
  getRate(): number {
    if (this.bypass) return 1.0
    const timescale = this.filterInstances.timescale as
      | { getRate?: () => number }
      | undefined
    return timescale?.getRate?.() ?? 1.0
  }

  /**
   * Hard-resets the entire filter chain: flushes state buffers, deletes
   * standard filter instances, and clears the active list.
   *
   * Unlike the previous implementation, this does NOT re-apply
   * _lastRawFilters.  Re-applying was causing zombie filter instances:
   * the old automix filters (lowpass, echo, reverb, etc.) got re-created
   * with fresh transition timers.  When transition completion later called
   * update({}), these zombies survived via isActive()===true (animation
   * still pending), leaking 4+ seconds of dying filters onto Track C
   * (the "filtro retardatário" bug).
   *
   * Standard filter instances (listed in FILTER_CLASSES) are deleted
   * outright and will be re-created on demand by update() when the
   * player sets new filters.  Extension filters (from plugins) are
   * preserved but flushed.
   *
   * Called when blend handling finishes (bypass goes
   * ON immediately before this, so no audio flows through filters).
   */
  resetState(): void {
    for (const name in this.filterInstances) {
      const instance = this.filterInstances[name]
      if (instance?.flush) {
        instance.flush()
      }

      if (name in FILTER_CLASSES) {
        delete this.filterInstances[name]
      }
    }
    this.activeFilters = []
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    if (this.bypass) {
      this.push(chunk)
      callback()
      return
    }
    this.push(this.process(chunk))
    callback()
  }

  override _flush(callback: TransformCallback): void {
    const remaining = this.flush()
    if (remaining.length > 0) this.push(remaining)
    callback()
  }

  /**
   * Normalizes incoming filter payloads to a simple settings map.
   * @param filters - Filter payload in any supported shape.
   */
  private _normalizeFilters(
    filters: FiltersState | FilterSettings
  ): FilterSettings {
    let normalized: FilterSettings = {}
    if (filters && typeof filters === 'object') {
      if ('filters' in filters) {
        normalized = (filters as FiltersState).filters ?? {}
      } else {
        normalized = filters as FilterSettings
      }
    }

    return normalized
  }

  override _destroy(
    _err: Error | null,
    cb: (error?: Error | null) => void
  ): void {
    for (const name in this.filterInstances) {
      const instance = this.filterInstances[name]
      instance?.destroy?.()
      delete this.filterInstances[name]
    }
    this.activeFilters = []
    cb(null)
  }
}
