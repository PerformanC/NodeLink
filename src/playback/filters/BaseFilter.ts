import type {
  FilterInstance,
  FilterSettings
} from '../../typings/playback/filters.types.ts'

/**
 * Base class for all audio filters.
 * @abstract
 * @public
 */
export abstract class BaseFilter implements FilterInstance {
  public audioCapabilities?: FilterInstance['audioCapabilities']
  /**
   * The priority of the filter. Lower values run first.
   */
  public abstract priority: number

  /**
   * Processes a PCM audio buffer.
   * @param chunk - PCM audio chunk.
   * @returns The processed PCM audio chunk.
   */
  public abstract process(chunk: Buffer): Buffer

  /**
   * Updates the filter settings.
   * @param settings - Filter settings payload.
   */
  public abstract update(settings: FilterSettings): void

  /**
   * Flushes any pending buffered data.
   * @returns The remaining PCM audio data.
   */
  public abstract flush(): Buffer
}
