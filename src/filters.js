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



  Filters of this file are based on the Java implementation of LavaDSP by natanbc,
    translated to JavaScript by ThePedroo.
*/

import { PassThrough, Transform } from 'node:stream'

import config from '../config.js'
import { debugLog, clamp16Bit, isEmpty } from './utils.js'
import voiceUtils from './voice/utils.js'
import constants from '../constants.js'
import RingBuffer from './ringbuffer.js'
import lfo from './lfo.js'

import prism from 'prism-media'

const ADDITIONAL_DELAY = 3
const BASE_DELAY_SEC = 0.002

class ChannelProcessor {
  constructor(data, type) {
    this.type = type

    switch (type) {
      case constants.filtering.types.equalizer: {
        this.history = new Array(constants.filtering.equalizerBands * 6).fill(0)
        this.bandMultipliers = data
        this.current = 0
        this.minus1 = 2
        this.minus2 = 1

        break
      }
      case constants.filtering.types.tremolo: {
        this.frequency = data.frequency
        this.depth = data.depth
        this.phase = 0
        this.offset = 1 - this.depth / 2

        break
      }
      case constants.filtering.types.rotationHz: {
        this.phase = 0
        this.rotationStep = (constants.circunferece.diameter * data.rotationHz) / constants.opus.samplingRate
        this.samplesPerCycle = constants.opus.samplingRate / (data.rotationHz * constants.circunferece.diameter)
        this.dI = data.rotationHz == 0 ? 0 : 1 / this.samplesPerCycle
        this.x = 0

        break
      }
      case constants.filtering.types.karaoke: {
        this.level = data.level
        this.monoLevel = data.monoLevel
        this.filterBand = data.filterBand
        this.filterWidth = data.filterWidth

        this.C = Math.exp(-2 * Math.PI * this.filterWidth / constants.opus.samplingRate)
        this.B = (-4 * this.C / (1 + this.C)) * Math.cos(2 * Math.PI * this.filterBand / constants.opus.samplingRate)
        this.A = Math.sqrt(1 - this.B * this.B / (4 * this.C)) * (1 - this.C)

        this.y1 = 0
        this.y2 = 0

        break
      }
      case constants.filtering.types.lowPass: {
        this.smoothing = data.smoothing
        this.value = 0
        this.initialized = false

        break
      }
      case constants.filtering.types.distortion: {
        this.sinOffset = data.sinOffset
        this.sinScale = data.sinScale
        this.cosOffset = data.cosOffset
        this.cosScale = data.cosScale
        this.tanOffset = data.tanOffset
        this.tanScale = data.tanScale
        this.offset = data.offset
        this.scale = data.scale

        break
      }
      case constants.filtering.types.channelMix: {
        this.leftToLeft = data.leftToLeft
        this.leftToRight = data.leftToRight
        this.rightToLeft = data.rightToLeft
        this.rightToRight = data.rightToRight

        break
      }
      case constants.filtering.types.vibrato: {
        this.depth = data.depth
        this.lfo = new lfo(data.frequency)
        this.buffer = new RingBuffer(Math.ceil(BASE_DELAY_SEC * constants.opus.samplingRate * 2))

        break
      }
    }
  }

  processEqualizer(band) {
    let processedBand = band * 0.25

    for (let bandIndex = 0; bandIndex < constants.filtering.equalizerBands; bandIndex++) {
      const coefficient = constants.sampleRate.coefficients[bandIndex]

      const x = bandIndex * 6
      const y = x + 3

      const bandResult = coefficient.alpha * (band - this.history[x + this.minus2]) + coefficient.gamma * this.history[y + this.minus1] - coefficient.beta * this.history[y + this.minus2]

      this.history[x + this.current] = band
      this.history[y + this.current] = bandResult

      processedBand += bandResult * this.bandMultipliers[bandIndex]
    }

    return processedBand * 4
  }

  getTremoloMultiplier() {
    let env = this.frequency * this.phase / constants.opus.samplingRate
    env = Math.sin(2 * Math.PI * ((env + 0.25) % 1.0))

    this.phase++

    return env * (1 - Math.abs(this.offset)) + this.offset
  }

  processRotationHz(leftSample, rightSample) {
    const sin = Math.sin(this.x)
    this.x += this.dI

    return {
      left: leftSample * (sin + 1) / 2,
      right: rightSample * (-sin + 1) / 2
    }
  }

  processKaraoke(leftSample, rightSample) {
    const y = (this.A * ((leftSample + rightSample) / 2) - this.B * this.y1) - this.C * this.y2
    this.y2 = this.y1
    this.y1 = y

    const output = y * this.monoLevel * this.level

    return {
      left: leftSample - (rightSample * this.level) + output,
      right: rightSample - (leftSample * this.level) + output
    }
  }

  processLowPass(sample) {
    this.value += (sample - this.value) / this.smoothing

    return this.value
  }

  processDistortion(sample) {
    const sampleSin = this.sinOffset + Math.sin(sample * this.sinScale)
    const sampleCos = this.cosOffset + Math.cos(sample * this.cosScale)
    const sampleTan = this.tanOffset + Math.tan(sample * this.tanScale)

    return sample * (this.offset + this.scale * (this.sinScale !== 1 ? sampleSin : 1) * (this.cosScale !== 1 ? sampleCos : 1) * (this.tanScale !== 1 ? sampleTan : 1))
  }

  processChannelMix(leftSample, rightSample) {
    return {
      left: (this.leftToLeft * leftSample) + (this.rightToLeft * rightSample),
      right: (this.leftToRight * leftSample) + (this.rightToRight * rightSample)
    }
  }

  processVibrato(sample) {
    const lfoValue = this.lfo.getValue()
    const maxDelay = Math.ceil(BASE_DELAY_SEC * constants.opus.samplingRate)

    const delay = lfoValue * this.depth * maxDelay + ADDITIONAL_DELAY

    const result = this.buffer.getHermiteAt(delay)

    this.buffer.writeMargined(sample)

    return result
  }

  process(samples) {
    let bytes = constants.pcm.bytes

    if (this.type === constants.filtering.types.lowPass && !this.initialized) {
      this.value = samples.readInt16LE(0)
      this.initialized = true
    }

    for (let i = 0; i < samples.length - constants.pcm.bytes; i += bytes * 2) {
      const sample = samples.readInt16LE(i)
      
      switch (this.type) {
        case constants.filtering.types.equalizer: {
          const result = this.processEqualizer(sample)
          const rightResult = this.processEqualizer(samples.readInt16LE(i + 2))

          if (++this.current === 3) this.current = 0
          if (++this.minus1 === 3) this.minus1 = 0
          if (++this.minus2 === 3) this.minus2 = 0

          samples.writeInt16LE(clamp16Bit(result), i)
          samples.writeInt16LE(clamp16Bit(rightResult), i + 2)

          break
        }
        case constants.filtering.types.tremolo: {
          const multiplier = this.getTremoloMultiplier()

          const rightSample = samples.readInt16LE(i + 2)

          samples.writeInt16LE(clamp16Bit(sample * multiplier), i)
          samples.writeInt16LE(clamp16Bit(rightSample * multiplier), i + 2)

          break
        }
        case constants.filtering.types.rotationHz: {
          const { left, right } = this.processRotationHz(sample, samples.readInt16LE(i + 2))

          samples.writeInt16LE(clamp16Bit(left), i)
          samples.writeInt16LE(clamp16Bit(right), i + 2)

          break
        }
        case constants.filtering.types.karaoke: {
          const { left, right } = this.processKaraoke(sample, samples.readInt16LE(i + 2))

          samples.writeInt16LE(clamp16Bit(left), i)
          samples.writeInt16LE(clamp16Bit(right), i + 2)

          break
        }
        case constants.filtering.types.lowPass: {
          const leftSample = this.processLowPass(sample)
          const rightSample = this.processLowPass(samples.readInt16LE(i + 2))

          samples.writeInt16LE(clamp16Bit(leftSample), i)
          samples.writeInt16LE(clamp16Bit(rightSample), i + 2)

          break
        }
        case constants.filtering.types.distortion: {
          const leftSample = this.processDistortion(sample)
          const rightSample = this.processDistortion(samples.readInt16LE(i + 2))

          samples.writeInt16LE(clamp16Bit(leftSample), i)
          samples.writeInt16LE(clamp16Bit(rightSample), i + 2)

          break
        }
        case constants.filtering.types.channelMix: {
          const { left, right } = this.processChannelMix(sample, samples.readInt16LE(i + 2))

          samples.writeInt16LE(clamp16Bit(left), i)
          samples.writeInt16LE(clamp16Bit(right), i + 2)

          break
        }
        case constants.filtering.types.vibrato: {
          const leftSample = this.processVibrato(sample)

          samples.writeInt16LE(clamp16Bit(leftSample), i)
          samples.writeInt16LE(clamp16Bit(leftSample), i + 2)

          break
        }
      }
    }

    return samples
  }
}

class Filtering extends Transform {
  constructor(data, type) {
    super()

    this.type = type
    this.channel = new ChannelProcessor(data, type)
  }

  process(input) {
    this.channel.process(input)
  }

  _transform(data, _encoding, callback) {
    this.process(data)

    return callback(null, data)
  }
}

class Filters {
  constructor() {
    this.command = []
    this.equalizer = Array(constants.filtering.equalizerBands).fill(0).map((_, i) => ({ band: i, gain: 0 }))
    this.result = {}
  }

  configure(filters, decodedTrack) {
    const result = {}

    if (filters.equalizer && Array.isArray(filters.equalizer) && filters.equalizer.length && config.filters.list.equalizer) {
      filters.equalizer.forEach((equalizedBand) => {
        const band = this.equalizer.find((i) => i.band === equalizedBand.band)
        if (band) band.gain = Math.min(Math.max(equalizedBand.gain, -0.25), 1.0)
      })

      result.equalizer = this.equalizer
    }

    if (!isEmpty(filters.karaoke) && config.filters.list.karaoke) {
      result.karaoke = {
        level: Math.min(Math.max(filters.karaoke.level, 0.0), 1.0),
        monoLevel: Math.min(Math.max(filters.karaoke.monoLevel, 0.0), 1.0),
        filterBand: filters.karaoke.filterBand,
        filterWidth: filters.karaoke.filterWidth
      }
    }

    if (!isEmpty(filters.timescale) && config.filters.list.timescale) {
      result.timescale = {
        speed: Math.max(filters.timescale.speed, 0.0) || 1.0,
        pitch: Math.max(filters.timescale.pitch, 0.0) || 1.0,
        rate: Math.max(filters.timescale.rate, 0.0) || 1.0
      }

      const finalspeed = result.timescale.speed + (1.0 - result.timescale.pitch)
      const ratedif = 1.0 - result.timescale.rate

      this.command.push(`asetrate=${constants.opus.samplingRate}*${result.timescale.pitch + ratedif},atempo=${finalspeed},aresample=${constants.opus.samplingRate}`)
    }

    if (!isEmpty(filters.tremolo) && config.filters.list.tremolo) {
      result.tremolo = {
        frequency: Math.min(Math.max(filters.tremolo.frequency, 0.0), 14.0),
        depth: Math.min(Math.max(filters.tremolo.depth, 0.0), 1.0)
      }
    }

    if (!isEmpty(filters.vibrato) && config.filters.list.vibrato) {
      result.vibrato = {
        frequency: Math.min(Math.max(filters.vibrato.frequency, 0.0), 14.0),
        depth: Math.min(Math.max(filters.vibrato.depth, 0.0), 1.0)
      }
    }

    if (!isEmpty(filters.rotation?.rotationHz) && config.filters.list.rotation) {
      result.rotation = { 
        rotationHz: filters.rotation.rotationHz
      }
    }

    if (!isEmpty(filters.distortion) && config.filters.list.distortion) {
      result.distortion = {
        sinOffset: filters.distortion.sinOffset,
        sinScale: filters.distortion.sinScale,
        cosOffset: filters.distortion.cosOffset,
        cosScale: filters.distortion.cosScale,
        tanOffset: filters.distortion.tanOffset,
        tanScale: filters.distortion.tanScale,
        offset: filters.distortion.offset,
        scale: filters.distortion.scale
      }
    }

    if (filters.channelMix && filters.channelMix.leftToLeft !== undefined && filters.channelMix.leftToRight !== undefined && filters.channelMix.rightToLeft !== undefined && filters.channelMix.rightToRight !== undefined && config.filters.list.channelMix) {
      result.channelMix = {
        leftToLeft: Math.min(Math.max(filters.channelMix.leftToLeft, 0.0), 1.0),
        leftToRight: Math.min(Math.max(filters.channelMix.leftToRight, 0.0), 1.0),
        rightToLeft: Math.min(Math.max(filters.channelMix.rightToLeft, 0.0), 1.0),
        rightToRight: Math.min(Math.max(filters.channelMix.rightToRight, 0.0), 1.0)
      }
    }

    if (filters.lowPass?.smoothing !== undefined && config.filters.list.lowPass) {
      result.lowPass = {
        smoothing: Math.max(filters.lowPass.smoothing, 1.0)
      }
    }

    if (filters.seek !== undefined)
      result.startTime = decodedTrack.length !== -1 ? Math.min(filters.seek, decodedTrack.length) : filters.seek

    this.result = result

    return result
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

          if (this.equalizer.some((band) => band.gain !== 0)) {
            pipelines.push(
              new Filtering(
                this.equalizer.map((band) => band.gain),
                constants.filtering.types.equalizer
              )
            )
          }

          if (this.result.tremolo) {
            pipelines.push(
              new Filtering({
                frequency: this.result.tremolo.frequency,
                depth: this.result.tremolo.depth
              },
              constants.filtering.types.tremolo)
            )
          }

          if (this.result.rotation) {
            pipelines.push(
              new Filtering({
                rotationHz: this.result.rotation.rotationHz
              }, constants.filtering.types.rotationHz)
            )
          }

          if (this.result.karaoke) {
            pipelines.push(
              new Filtering({
                level: this.result.karaoke.level,
                monoLevel: this.result.karaoke.monoLevel,
                filterBand: this.result.karaoke.filterBand,
                filterWidth: this.result.karaoke.filterWidth
              }, constants.filtering.types.karaoke)
            )
          }

          if (this.result.lowPass) {
            pipelines.push(
              new Filtering({
                smoothing: this.result.lowPass.smoothing
              }, constants.filtering.types.lowPass)
            )
          }

          if (this.result.distortion) {
            pipelines.push(
              new Filtering({
                sinOffset: this.result.distortion.sinOffset,
                sinScale: this.result.distortion.sinScale,
                cosOffset: this.result.distortion.cosOffset,
                cosScale: this.result.distortion.cosScale,
                tanOffset: this.result.distortion.tanOffset,
                tanScale: this.result.distortion.tanScale,
                offset: this.result.distortion.offset,
                scale: this.result.distortion.scale
              }, constants.filtering.types.distortion)
            )
          }

          if (this.result.channelMix) {
            pipelines.push(
              new Filtering({
                leftToLeft: this.result.channelMix.leftToLeft,
                leftToRight: this.result.channelMix.leftToRight,
                rightToLeft: this.result.channelMix.rightToLeft,
                rightToRight: this.result.channelMix.rightToRight
              }, constants.filtering.types.channelMix)
            )
          }

          if (this.result.vibrato) {
            pipelines.push(
              new Filtering({
                frequency: this.result.vibrato.frequency,
                depth: this.result.vibrato.depth
              }, constants.filtering.types.vibrato)
            )
          }

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