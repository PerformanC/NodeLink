import https from 'https'
import fs from 'fs'

import config from '../config.js'

import * as djsVoice from '@discordjs/voice'
import prism from 'prism-media'

class Filters {
  constructor(filters, metadata, guildId, startedAt) {
    this.filters = filters
    this.metadata = metadata
    this.guildId = guildId
    this.startedAt = startedAt
    this.command = []
    this.result = {}
  }

  configure() {
    if (this.filters.volume && config.filters.list.volume) {
      this.result.volume = this.filters.volume

      this.command.push(`volume=${this.filters.volume}`)
    }

		if (this.filters.equalizer && Array.isArray(this.filters.equalizer) && this.filters.equalizer.length && config.filters.list.equalizer) {
      this.result.equalizer = this.filters.equalizer

			const bandSettings = [ { band: 0, gain: 0.2 }, { band: 1, gain: 0.2 }, { band: 2, gain: 0.2 }, { band: 3, gain: 0.2 }, { band: 4, gain: 0.2 }, { band: 5, gain: 0.2 }, { band: 6, gain: 0.2 }, { band: 7, gain: 0.2 }, { band: 8, gain: 0.2 }, { band: 9, gain: 0.2 }, { band: 10, gain: 0.2 }, { band: 11, gain: 0.2 }, { band: 12, gain: 0.2 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.2 }]

      this.filters.equalizer.forEach((eq) => {
        const cur = bandSettings.find(i => i.band == eq.band)
				if (cur) cur.gain = eq.gain
      })

      this.command.push(this.filters.equalizer.map((eq) => `equalizer=f=${eq.band}:width_type=h:width=1:g=${eq.gain}`).join(','))
		}

    if (this.filters.karaoke && this.filters.karaoke.level && this.filters.karaoke.monoLevel && this.filters.karaoke.filterBand && this.filters.karaoke.filterWidth && config.filters.list.karaoke) {
      this.result.karaoke = { level: this.filters.karaoke.level, monoLevel: this.filters.karaoke.monoLevel, filterBand: this.filters.karaoke.filterBand, filterWidth: this.filters.karaoke.filterWidth }

      this.command.push(`stereotools=mlev=${this.filters.karaoke.monoLevel}:mwid=${this.filters.karaoke.filterWidth}:k=${this.filters.karaoke.level}:kc=${this.filters.karaoke.filterBand}`)
    }
    if (this.filters.timescale && this.filters.timescale.speed && this.filters.timescale.pitch && this.filters.timescale.rate && config.filters.list.timescale) {
      this.result.timescale = { speed: this.filters.timescale.speed, pitch: this.filters.timescale.pitch, rate: this.filters.timescale.rate }

      const finalspeed = this.filters.timescale.speed + (1.0 - this.filters.timescale.pitch)
      const ratedif = 1.0 - this.filters.timescale.rate

      this.command.push(`asetrate=48000*${this.filters.timescale.pitch + ratedif},atempo=${finalspeed},aresample=48000`)
		}

    if (this.filters.tremolo && this.filters.tremolo.frequency && this.filters.tremolo.depth && config.filters.list.tremolo) {
      this.result.tremolo = { frequency: this.filters.tremolo.frequency, depth: this.filters.tremolo.depth }

      this.command.push(`tremolo=f=${this.filters.tremolo.frequency}:d=${this.filters.tremolo.depth}`)
    }

    if (this.filters.vibrato && this.filters.vibrato.frequency && this.filters.vibrato.depth && config.filters.list.vibrato) {
      this.result.vibrato = { frequency: this.filters.vibrato.frequency, depth: this.filters.vibrato.depth }

      this.command.push(`vibrato=f=${this.filters.vibrato.frequency}:d=${this.filters.vibrato.depth}`)
    }

    if (this.filters.rotation && this.filters.rotation.rotationHz && config.filters.list.rotation) {
      this.result.rotation = { rotationHz: this.filters.rotation.rotationHz }

      this.command.push(`apulsator=hz=${this.filters.rotation.rotationHz}`)
    }

    if (this.filters.distortion && this.filters.distortion.sinOffset && this.filters.distortion.sinScale && this.filters.distortion.cosOffset && this.filters.distortion.cosScale && this.filters.distortion.tanOffset && this.filters.distortion.tanScale && this.filters.distortion.offset && this.filters.distortion.scale && config.filters.list.distortion) {
      this.result.distortion = { sinOffset: this.filters.distortion.sinOffset, sinScale: this.filters.distortion.sinScale, cosOffset: this.filters.distortion.cosOffset, cosScale: this.filters.distortion.cosScale, tanOffset: this.filters.distortion.tanOffset, tanScale: this.filters.distortion.tanScale, offset: this.filters.distortion.offset, scale: this.filters.distortion.scale }

      this.command.push(`afftfilt=real='hypot(re,im)*sin(0.1*${this.filters.distortion.sinOffset}*PI*t)*${this.filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${this.filters.distortion.cosOffset}*PI*t)*${this.filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${this.filters.distortion.tanOffset}*PI*t)*${this.filters.distortion.tanScale}+${this.filters.distortion.offset}':imag='hypot(re,im)*sin(0.1*${this.filters.distortion.sinOffset}*PI*t)*${this.filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${this.filters.distortion.cosOffset}*PI*t)*${this.filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${this.filters.distortion.tanOffset}*PI*t)*${this.filters.distortion.tanScale}+${this.filters.distortion.offset}':win_size=512:overlap=0.75:scale=${this.filters.distortion.scale}`)
    }

    if (this.filters.channelMix && this.filters.channelMix.leftToLeft && this.filters.channelMix.leftToRight && this.filters.channelMix.rightToLeft && this.filters.channelMix.rightToRight && config.filters.list.channelMix) {
      this.result.channelMix = { leftToLeft: this.filters.channelMix.leftToLeft, leftToRight: this.filters.channelMix.leftToRight, rightToLeft: this.filters.channelMix.rightToLeft, rightToRight: this.filters.channelMix.rightToRight }

      this.command.push(`pan=stereo|c0<c0*${this.filters.channelMix.leftToLeft}+c1*${this.filters.channelMix.rightToLeft}|c1<c0*${this.filters.channelMix.leftToRight}+c1*${this.filters.channelMix.rightToRight}`)
    }

    if (this.filters.lowPass && this.filters.lowPass.smoothing && config.filters.list.lowPass) {
      this.result.lowPass = { smoothing: this.filters.lowPass.smoothing }

      this.command.push(`lowpass=f=${this.filters.lowPass.smoothing / 500}`)
    }

    return this.result
  }

  createResource(oldFFmpeg) {
    return new Promise((resolve, reject) => {
      https.get(this.metadata, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
          'Range': 'bytes=0-'
        }
      }, (res) => {
        res.on('error', () => {})

        if (res.statusCode != 206) {
          res.destroy()

          utils.debugLog('trackException', 2, { track: decodedTrack, guildId: this.guildId, exception: resource.exception })

          return resolve({
            exception: {
              message: 'Failed to get the stream from source.',
              severity: 'UNCOMMON',
              cause: 'unknown'
            }
          })
        }

        const file = fs.createWriteStream(`./cache/${this.guildId}.webm`)
        res.pipe(file)

        file.on('finish', async () => {
          file.close()

          if (oldFFmpeg) oldFFmpeg.destroy()

          const ffmpeg = new prism.FFmpeg({
            args: [
              '-loglevel', '0',
              '-analyzeduration', '0',
              '-threads', config.filters.threads,
              '-filter_threads', config.filters.threads,
              '-filter_complex_threads', config.filters.threads,
              '-y',
              '-i', `./cache/${this.guildId}.webm`,
              '-ss', this.filters.seek ? this.filters.seek : `${new Date() - this.startedAt}ms`,
              ...(this.filters.endTime ? ['-t', this.filters.endTime] : []),
              '-af', this.command.join(','),              
              '-f', 's16le',
              '-ar', '48000',
              '-ac', '2'
            ]
          })

          return resolve({ stream: new djsVoice.AudioResource([], [ffmpeg.process.stdout, new prism.VolumeTransformer({ type: 's16le' }), new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 }) ], this.metadata, 5), ffmpeg: ffmpeg })
        })
      })
    })
  }
}

export default Filters