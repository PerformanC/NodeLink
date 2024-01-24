import { PassThrough, Transform } from 'node:stream'

import config from '../config.js'
import { debugLog, clamp16Bit } from './utils.js'
import soundcloud from './sources/soundcloud.js'
import voiceUtils from './voice/utils.js'
import constants from '../constants.js'

import prism from 'prism-media'

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
    const panning = Math.sin(this.phase)
  
    const leftMultiplier = panning <= 0 ? 1 : 1 - panning
    const rightMultiplier = panning >= 0 ? 1 : 1 + panning
  
    this.phase += this.rotationStep
    if (this.phase > constants.circunferece.diameter)
      this.phase -= constants.circunferece.diameter
  
    return {
      left: leftSample * leftMultiplier,
      right: rightSample * rightMultiplier
    }
  }

  process(samples) {
    let bytes = constants.pcm.bytes
    if ([ constants.filtering.types.rotationHz, constants.filtering.types.tremolo ].includes(this.type)) bytes *= 2

    for (let i = 0; i < samples.length - constants.pcm.bytes; i += bytes) {
      const sample = samples.readInt16LE(i)
      let result = null
      
      switch (this.type) {
        case constants.filtering.types.equalizer: {
          result = this.processEqualizer(sample)

          if (++this.current == 3) this.current = 0
          if (++this.minus1 == 3) this.minus1 = 0
          if (++this.minus2 == 3) this.minus2 = 0

          samples.writeInt16LE(clamp16Bit(result), i)

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
          const { left, right } = this.processRotationHz(sample, rightSample)

          samples.writeInt16LE(clamp16Bit(left), i)
          samples.writeInt16LE(clamp16Bit(right), i + 2)

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
      for (const equalizedBand of filters.equalizer) {
        const band = this.equalizer.find(i => i.band == equalizedBand.band)
        if (band) band.gain = Math.min(Math.max(equalizedBand.gain, -0.25), 1.0)
      }

      result.equalizer = this.equalizer
		}

    if (filters.karaoke && filters.karaoke.level && filters.karaoke.monoLevel && filters.karaoke.filterBand && filters.karaoke.filterWidth && config.filters.list.karaoke) {
      result.karaoke = {
        level: Math.min(Math.max(filters.karaoke.level, 0.0), 1.0),
        monoLevel: Math.min(Math.max(filters.karaoke.monoLevel, 0.0), 1.0),
        filterBand: filters.karaoke.filterBand,
        filterWidth: filters.karaoke.filterWidth
      }

      this.command.push(`stereotools=mlev=${result.karaoke.monoLevel}:mwid=${result.karaoke.filterWidth}:k=${result.karaoke.level}:kc=${result.karaoke.filterBand}`)
    }

    if (filters.timescale && filters.timescale.speed && filters.timescale.pitch && filters.timescale.rate && config.filters.list.timescale) {
      result.timescale = {
        speed: Math.max(filters.timescale.speed, 0.0),
        pitch: Math.max(filters.timescale.pitch, 0.0),
        rate: Math.max(filters.timescale.rate, 0.0)
      }

      const finalspeed = result.timescale.speed + (1.0 - result.timescale.pitch)
      const ratedif = 1.0 - result.timescale.rate

      this.command.push(`asetrate=${constants.opus.samplingRate}*${result.timescale.pitch + ratedif},atempo=${finalspeed},aresample=${constants.opus.samplingRate}`)
		}

    if (filters.tremolo && filters.tremolo.frequency && filters.tremolo.depth && config.filters.list.tremolo) {
      result.tremolo = {
        frequency: Math.min(Math.max(filters.tremolo.frequency, 0.0), 14.0),
        depth: Math.min(Math.max(filters.tremolo.depth, 0.0), 1.0)
      }
    }

    if (filters.vibrato && filters.vibrato.frequency && filters.vibrato.depth && config.filters.list.vibrato) {
      result.vibrato = {
        frequency: Math.min(Math.max(filters.vibrato.frequency, 0.0), 14.0),
        depth: Math.min(Math.max(filters.vibrato.depth, 0.0), 1.0)
      }

      this.command.push(`vibrato=f=${result.vibrato.frequency}:d=${result.vibrato.depth}`)
    }

    if (filters.rotation && filters.rotation.rotationHz && config.filters.list.rotation) {
      result.rotation = { 
        rotationHz: filters.rotation.rotationHz
      }
    }

    if (filters.distortion && filters.distortion.sinOffset && filters.distortion.sinScale && filters.distortion.cosOffset && filters.distortion.cosScale && filters.distortion.tanOffset && filters.distortion.tanScale && filters.distortion.offset && filters.distortion.scale && config.filters.list.distortion) {
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

      this.command.push(`afftfilt=real='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':imag='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':win_size=512:overlap=0.75:scale=${filters.distortion.scale}`)
    }

    if (filters.channelMix && filters.channelMix.leftToLeft && filters.channelMix.leftToRight && filters.channelMix.rightToLeft && filters.channelMix.rightToRight && config.filters.list.channelMix) {
      result.channelMix = {
        leftToLeft: Math.min(Math.max(filters.channelMix.leftToLeft, 0.0), 1.0),
        leftToRight: Math.min(Math.max(filters.channelMix.leftToRight, 0.0), 1.0),
        rightToLeft: Math.min(Math.max(filters.channelMix.rightToLeft, 0.0), 1.0),
        rightToRight: Math.min(Math.max(filters.channelMix.rightToRight, 0.0), 1.0)
      }

      this.command.push(`pan=stereo|c0<c0*${result.channelMix.leftToLeft}+c1*${result.channelMix.rightToLeft}|c1<c0*${result.channelMix.leftToRight}+c1*${result.channelMix.rightToRight}`)
    }

    if (filters.lowPass && filters.lowPass.smoothing && config.filters.list.lowPass) {
      result.lowPass = {
        smoothing: Math.max(filters.lowPass.smoothing, 1.0)
      }

      this.command.push(`lowpass=f=${filters.lowPass.smoothing / 500}`)
    }

    if (filters.seek) {
      result.startTime = Math.min(filters.seek, decodedTrack.length)
    }

    this.result = result

    return result
  }

  getResource(decodedTrack, protocol, url, startTime, endTime, oldFFmpeg, additionalData) {
    return new Promise(async (resolve) => {
      if (decodedTrack.sourceName == 'deezer') {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: 'Filtering does not support Deezer platform.' })

        resolve({ status: 1, exception: { message: err.message, severity: 'fault', cause: 'Filtering does not support Deezer platform.' } })
      }

      if (decodedTrack.sourceName == 'soundcloud')
        url = await soundcloud.loadFilters(url, protocol)

      const ffmpeg = new prism.FFmpeg({
        args: [
          '-loglevel', '0',
          '-analyzeduration', '0',
          '-hwaccel', 'auto',
          '-threads', config.filters.threads,
          '-filter_threads', config.filters.threads,
          '-filter_complex_threads', config.filters.threads,
          ...(this.result.startime || startTime ? ['-ss', `${this.result.startTime || startTime}ms`] : []),
          '-i', encodeURI(url),
          ...(this.command.length != 0 ? [ '-af', this.command.join(',') ] : [] ),
          ...(endTime ? ['-t', `${endTime}ms`] : []),
          '-f', 's16le',
          '-ar', constants.opus.samplingRate,
          '-ac', '2',
          '-crf', '0'
        ]
      })

      const stream = PassThrough()

      ffmpeg.process.stdout.on('data', (data) => stream.write(data))
      ffmpeg.process.stdout.on('end', () => stream.end())
      ffmpeg.on('error', (err) => {
        debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: err.message })

        resolve({ status: 1, exception: { message: err.message, severity: 'fault', cause: 'Unknown' } })
      })

      ffmpeg.process.stdout.once('readable', () => {
        const pipelines = [
          new prism.VolumeTransformer({ type: 's16le' })
        ]

        if (this.equalizer.some((band) => band.gain != 0)) {
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
              rotationHz: this.result.rotation.rotationHz / 2
            }, constants.filtering.types.rotationHz)
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
    })
  }
}

export default Filters