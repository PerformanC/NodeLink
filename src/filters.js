import { PassThrough } from 'node:stream'

import prism from 'prism-media'

import constants from '../constants.js'
import config from '../config.js'
import { debugLog, isEmpty, replacePart, addPartAt } from './utils.js'
import voiceUtils from './voice/utils.js'
import sources from './sources.js'
import filters from './filters/filters.js'

class Filters {
  constructor() {
    this.command = []
    this.filters = []
  }

  configure(filters, decodedTrack) {
    const result = {}

    if (filters.equalizer && Array.isArray(filters.equalizer) && filters.equalizer.length && config.filters.list.equalizer) {
      const equalizer = Array(constants.filtering.equalizerBands).fill(0).map((_, i) => ({ band: i, gain: 0 }))

      filters.equalizer.forEach((equalizedBand) => {
        const band = equalizer.find((i) => i.band === equalizedBand.band)
        if (band) band.gain = Math.min(Math.max(equalizedBand.gain, -0.25), 1.0)
      })

      this.filters.push({
        type: constants.filtering.types.equalizer,
        name: 'equalizer',
        data: equalizer.map((band) => band.gain)
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

      const finalspeed = adjustedParams.speed + (1.0 - adjustedParams.pitch)
      const ratedif = 1.0 - adjustedParams.rate

      this.command.push(`asetrate=${constants.opus.samplingRate}*${adjustedParams.pitch + ratedif},atempo=${finalspeed},aresample=${constants.opus.samplingRate}`)
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
        type: constants.filtering.types.rotation,
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
          smoothing: filters.lowPass.smoothing
        }
      })
    }

    if (filters.seek !== undefined) {
      this.filters.push({
        type: 'not implemented natively',
        name: 'seek',
        data: decodedTrack.length !== -1 ? Math.min(filters.seek, decodedTrack.length) : filters.seek
      })
    }

    if (filters.endTime !== undefined) {
      this.filters.push({
        type: 'not implemented natively',
        name: 'endTime',
        data: decodedTrack.length !== -1 ? Math.max(filters.endTime, decodedTrack.length) : filters.endTime
      })
    }
  }

  getResource(decodedTrack, streamInfo, realTime, currentStream) {
    return new Promise(async (resolve) => {
      try {
        const startTime = this.filters.find((filter) => filter.name === 'seek')?.data
        const endTime = this.filters.find((filter) => filter.name === 'endTime')?.data

        const isDecodedInternally = voiceUtils.isDecodedInternally(currentStream, streamInfo.format)
        if (startTime === undefined && isDecodedInternally !== false && this.command.length === 0 && !endTime) {
          const filtersClasses = []

          this.filters.forEach((filter) => {
            if (!filters.isValid(filter)) return;

            filtersClasses.push(new filters.Interface(filter.type, filter.data))
          })

          if (currentStream && (currentStream.ffmpegState !== 1 || !currentStream.ffmpegState)) {
            if (currentStream.filtersIndex.length === 0) {
              currentStream.detach()
              currentStream.pipes = addPartAt(currentStream.pipes, isDecodedInternally, filtersClasses)
              currentStream.rewindPipes()
            } else {
              currentStream.detach()
              currentStream.pipes = replacePart(currentStream.pipes, currentStream.filtersIndex[0], currentStream.filtersIndex[1], filtersClasses)
              currentStream.rewindPipes()
            }

            if (filtersClasses.length === 0) currentStream.filtersIndex = []
            else currentStream.filtersIndex = [ isDecodedInternally, isDecodedInternally + filtersClasses.length ]

            resolve({})
          } else {
            const filterClasses = []

            this.filters.forEach((filter) => {
              if (!filters.isValid(filter)) return;

              filterClasses.push(new filters.Interface(filter.type, filter.data))
            })

            const pureStream = await sources.getTrackStream(decodedTrack, streamInfo.url, streamInfo.protocol)

            const stream = new voiceUtils.createAudioResource(pureStream.stream, streamInfo.format, filterClasses, 0)

            resolve({ stream })
          }
        } else {
          if (decodedTrack.sourceName === 'deezer') {
            debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Filtering does not support Deezer platform.' })
  
            return resolve({
              status: 1,
              exception: {
                message: 'Non-native filtering does not support Deezer platform',
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
              ...(startTime !== undefined ? ['-ss', `${startTime}ms`] : [ '-ss', `${realTime}ms` ]),
              '-i', streamInfo.url,
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

            const onlySeeked = Object.keys(this.filters).length === 1 && this.filters.find((filter) => filter.name === 'seek')
            const ffmpegState = (this.command.length !== 0 || !onlySeeked) ? 1 : 2

            resolve({ stream: new voiceUtils.NodeLinkStream(stream, pipelines, ffmpegState) })
          })
        }
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