/*
 * Copyright 2018 natanbc
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*
 * This filter is a ported version of the original filter from the lavadsp project: https://github.com/natanbc/lavadsp
 */

import { PassThrough } from 'node:stream'

import prism from 'prism-media'

import config from '../config.js'
import { debugLog, isEmpty } from './utils.js'
import voiceUtils from './voice/utils.js'
import constants from '../constants.js'
import filters from './filters/filters.js'

class Filters {
  constructor() {
    this.command = []
    this.equalizer = null
    this.filters = []
  }

  configure(filters, decodedTrack) {
    const result = {}

    if (filters.equalizer && Array.isArray(filters.equalizer) && filters.equalizer.length && config.filters.list.equalizer) {
      this.equalizer = Array(constants.filtering.equalizerBands).fill(0).map((_, i) => ({ band: i, gain: 0 }))

      filters.equalizer.forEach((equalizedBand) => {
        const band = this.equalizer.find((i) => i.band === equalizedBand.band)
        if (band) band.gain = Math.min(Math.max(equalizedBand.gain, -0.25), 1.0)
      })

      this.filters.push({
        type: constants.filtering.types.equalizer,
        data: this.equalizer.map((band) => band.gain)
      })
    }

    if (!isEmpty(filters.karaoke) && config.filters.list.karaoke) {
      this.filters.push({
        type: constants.filtering.types.karaoke,
        name: 'karaoke',
        data: {
          level: Math.min(Math.max(filters.karaoke.level, 0.0), 1.0),
          monoLevel: Math.min(Math.max(filters.karaoke.monoLevel, 0.0), 1.0),
          filterBand: filters.karaoke.filterBand,
          filterWidth: filters.karaoke.filterWidth
        }
      })
    }

    if (!isEmpty(filters.timescale) && config.filters.list.timescale) {
      const adjustedParams = {
        speed: Math.max(filters.timescale.speed, 0.0) || 1.0,
        pitch: Math.max(filters.timescale.pitch, 0.0) || 1.0,
        rate: Math.max(filters.timescale.rate, 0.0) || 1.0
      }

      this.filters.push({
        type: 'not implemented natively',
        name: 'timescale',
        data: adjustedParams
      })

      const finalspeed = adjustedParams.timescale.speed + (1.0 - adjustedParams.timescale.pitch)
      const ratedif = 1.0 - adjustedParams.timescale.rate

      this.command.push(`asetrate=${constants.opus.samplingRate}*${adjustedParams.timescale.pitch + ratedif},atempo=${finalspeed},aresample=${constants.opus.samplingRate}`)
    }

    if (!isEmpty(filters.tremolo) && config.filters.list.tremolo) {
      this.filters.push({
        type: constants.filtering.types.tremolo,
        name: 'tremolo',
        data: {
          frequency: Math.min(Math.max(filters.tremolo.frequency, 0.0), 14.0),
          depth: Math.min(Math.max(filters.tremolo.depth, 0.0), 1.0)
        }
      })
    }

    if (!isEmpty(filters.vibrato) && config.filters.list.vibrato) {
      this.filters.push({
        type: constants.filtering.types.vibrato,
        name: 'vibrato',
        data: {
          frequency: Math.min(Math.max(filters.vibrato.frequency, 0.0), 14.0),
          depth: Math.min(Math.max(filters.vibrato.depth, 0.0), 1.0)
        }
      })
    }

    if (!isEmpty(filters.rotation?.rotationHz) && config.filters.list.rotation) {
      this.filters.push({
        type: constants.filtering.types.rotationHz,
        name: 'rotation',
        data: { 
          rotationHz: filters.rotation.rotationHz
        }
      })
    }

    if (!isEmpty(filters.distortion) && config.filters.list.distortion) {
      this.filters.push({
        type: constants.filtering.types.distortion,
        name: 'distortion',
        data: {
          sinOffset: filters.distortion.sinOffset,
          sinScale: filters.distortion.sinScale,
          cosOffset: filters.distortion.cosOffset,
          cosScale: filters.distortion.cosScale,
          tanOffset: filters.distortion.tanOffset,
          tanScale: filters.distortion.tanScale,
          offset: filters.distortion.offset,
          scale: filters.distortion.scale
        }
      })
    }

    if (filters.channelMix && filters.channelMix.leftToLeft !== undefined && filters.channelMix.leftToRight !== undefined && filters.channelMix.rightToLeft !== undefined && filters.channelMix.rightToRight !== undefined && config.filters.list.channelMix) {
      this.filters.push({
        type: constants.filtering.types.channelMix,
        name: 'channelMix',
        data: {
          leftToLeft: Math.min(Math.max(filters.channelMix.leftToLeft, 0.0), 1.0),
          leftToRight: Math.min(Math.max(filters.channelMix.leftToRight, 0.0), 1.0),
          rightToLeft: Math.min(Math.max(filters.channelMix.rightToLeft, 0.0), 1.0),
          rightToRight: Math.min(Math.max(filters.channelMix.rightToRight, 0.0), 1.0)
        }
      })
    }

    if (filters.lowPass?.smoothing !== undefined && config.filters.list.lowPass) {
      this.filters.push({
        type: constants.filtering.types.lowPass,
        name: 'lowPass',
        data: {
          smoothing: result.lowPass.smoothing
        }
      })
    }

    if (filters.seek !== undefined)
      this.result.startTime = decodedTrack.length !== -1 ? Math.min(filters.seek, decodedTrack.length) : filters.seek

    return this.result
  }

  getResource(decodedTrack, protocol, url, startTime, endTime, oldFFmpeg, additionalData) {
    return new Promise(async (resolve) => {
      try {
        if (decodedTrack.sourceName === 'deezer') {
          debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Filtering does not support Deezer platform.' })

          return resolve({
            status: 1,
            exception: {
              message: 'Filtering does not support Deezer platform',
              severity: 'fault',
              cause: 'Unimplemented feature.'
            }
          })
        }

        const ffmpeg = new prism.FFmpeg({
          args: [
            '-loglevel', '0',
            '-analyzeduration', '0',
            '-hwaccel', 'auto',
            '-threads', config.filters.threads,
            '-filter_threads', config.filters.threads,
            '-filter_complex_threads', config.filters.threads,
            ...(this.result.startTime !== undefined || startTime ? ['-ss', `${this.result.startTime !== undefined ? this.result.startTime : startTime}ms`] : []),
            '-i', url,
            ...(this.command.length !== 0 ? [ '-af', this.command.join(',') ] : [] ),
            ...(endTime ? ['-t', `${endTime}ms`] : []),
            '-f', 's16le',
            '-ar', constants.opus.samplingRate,
            '-ac', '2',
            '-crf', '0'
          ]
        })

        const stream = PassThrough()

        ffmpeg.process.stdout.on('data', (data) => stream.write(data))
        ffmpeg.process.stdout.on('end', () => stream.emit('finishBuffering'))
        ffmpeg.on('error', (err) => {
          debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: err.message })

          resolve({ status: 1, exception: { message: err.message, severity: 'fault', cause: 'Unknown' } })
        })

        ffmpeg.process.stdout.once('readable', () => {
          const pipelines = [
            new prism.VolumeTransformer({ type: 's16le' })
          ]

          this.filters.forEach((filter) => {
            if (!filters.isValid(filter)) return;

            pipelines.push(new filters.Interface(filter.type, filter.data))
          })

          pipelines.push(
            new prism.opus.Encoder({
              rate: constants.opus.samplingRate,
              channels: constants.opus.channels,
              frameSize: constants.opus.frameSize
            })
          )

          resolve({ stream: new voiceUtils.NodeLinkStream(stream, pipelines) })
        })
      } catch (err) {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: err.message })

        resolve({
          status: 1,
          exception: {
            message: err.message,
            severity: 'fault',
            cause: 'Unknown'
          }
        })
      }
    })
  }
}

export default Filters