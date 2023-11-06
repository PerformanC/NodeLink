import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'

import config from '../config.js'
import utils from './utils.js'

import * as djsVoice from '@discordjs/voice'
import prism from 'prism-media'

class Filters {
  constructor() {
    this.command = []
  }

  configure(filters) {
    const result = {}

    if (filters.volume && config.filters.list.volume) {
      result.volume = filters.volume

      this.command.push(`volume=${filters.volume}`)
    }

		if (filters.equalizer && Array.isArray(filters.equalizer) && filters.equalizer.length && config.filters.list.equalizer) {
      result.equalizer = filters.equalizer

			const bandSettings = [ { band: 0, gain: 0.2 }, { band: 1, gain: 0.2 }, { band: 2, gain: 0.2 }, { band: 3, gain: 0.2 }, { band: 4, gain: 0.2 }, { band: 5, gain: 0.2 }, { band: 6, gain: 0.2 }, { band: 7, gain: 0.2 }, { band: 8, gain: 0.2 }, { band: 9, gain: 0.2 }, { band: 10, gain: 0.2 }, { band: 11, gain: 0.2 }, { band: 12, gain: 0.2 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.2 }]

      filters.equalizer.forEach((eq) => {
        const cur = bandSettings.find(i => i.band == eq.band)
				if (cur) cur.gain = eq.gain
      })

      this.command.push(filters.equalizer.map((eq) => `equalizer=f=${eq.band}:width_type=h:width=1:g=${eq.gain}`).join(','))
		}

    if (filters.karaoke && filters.karaoke.level && filters.karaoke.monoLevel && filters.karaoke.filterBand && filters.karaoke.filterWidth && config.filters.list.karaoke) {
      result.karaoke = { level: filters.karaoke.level, monoLevel: filters.karaoke.monoLevel, filterBand: filters.karaoke.filterBand, filterWidth: filters.karaoke.filterWidth }

      this.command.push(`stereotools=mlev=${filters.karaoke.monoLevel}:mwid=${filters.karaoke.filterWidth}:k=${filters.karaoke.level}:kc=${filters.karaoke.filterBand}`)
    }
    if (filters.timescale && filters.timescale.speed && filters.timescale.pitch && filters.timescale.rate && config.filters.list.timescale) {
      result.timescale = { speed: filters.timescale.speed, pitch: filters.timescale.pitch, rate: filters.timescale.rate }

      const finalspeed = filters.timescale.speed + (1.0 - filters.timescale.pitch)
      const ratedif = 1.0 - filters.timescale.rate

      this.command.push(`asetrate=48000*${filters.timescale.pitch + ratedif},atempo=${finalspeed},aresample=48000`)
		}

    if (filters.tremolo && filters.tremolo.frequency && filters.tremolo.depth && config.filters.list.tremolo) {
      result.tremolo = { frequency: filters.tremolo.frequency, depth: filters.tremolo.depth }

      this.command.push(`tremolo=f=${filters.tremolo.frequency}:d=${filters.tremolo.depth}`)
    }

    if (filters.vibrato && filters.vibrato.frequency && filters.vibrato.depth && config.filters.list.vibrato) {
      result.vibrato = { frequency: filters.vibrato.frequency, depth: filters.vibrato.depth }

      this.command.push(`vibrato=f=${filters.vibrato.frequency}:d=${filters.vibrato.depth}`)
    }

    if (filters.rotation && filters.rotation.rotationHz && config.filters.list.rotation) {
      result.rotation = { rotationHz: filters.rotation.rotationHz }

      this.command.push(`apulsator=hz=${filters.rotation.rotationHz}`)
    }

    if (filters.distortion && filters.distortion.sinOffset && filters.distortion.sinScale && filters.distortion.cosOffset && filters.distortion.cosScale && filters.distortion.tanOffset && filters.distortion.tanScale && filters.distortion.offset && filters.distortion.scale && config.filters.list.distortion) {
      result.distortion = { sinOffset: filters.distortion.sinOffset, sinScale: filters.distortion.sinScale, cosOffset: filters.distortion.cosOffset, cosScale: filters.distortion.cosScale, tanOffset: filters.distortion.tanOffset, tanScale: filters.distortion.tanScale, offset: filters.distortion.offset, scale: filters.distortion.scale }

      this.command.push(`afftfilt=real='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':imag='hypot(re,im)*sin(0.1*${filters.distortion.sinOffset}*PI*t)*${filters.distortion.sinScale}+hypot(re,im)*cos(0.1*${filters.distortion.cosOffset}*PI*t)*${filters.distortion.cosScale}+hypot(re,im)*tan(0.1*${filters.distortion.tanOffset}*PI*t)*${filters.distortion.tanScale}+${filters.distortion.offset}':win_size=512:overlap=0.75:scale=${filters.distortion.scale}`)
    }

    if (filters.channelMix && filters.channelMix.leftToLeft && filters.channelMix.leftToRight && filters.channelMix.rightToLeft && filters.channelMix.rightToRight && config.filters.list.channelMix) {
      result.channelMix = { leftToLeft: filters.channelMix.leftToLeft, leftToRight: filters.channelMix.leftToRight, rightToLeft: filters.channelMix.rightToLeft, rightToRight: filters.channelMix.rightToRight }

      this.command.push(`pan=stereo|c0<c0*${filters.channelMix.leftToLeft}+c1*${filters.channelMix.rightToLeft}|c1<c0*${filters.channelMix.leftToRight}+c1*${filters.channelMix.rightToRight}`)
    }

    if (filters.lowPass && filters.lowPass.smoothing && config.filters.list.lowPass) {
      result.lowPass = { smoothing: filters.lowPass.smoothing }

      this.command.push(`lowpass=f=${filters.lowPass.smoothing / 500}`)
    }

    return result
  }

  getResource(guildId, decodedTrack, protocol, url, endTime, cache, oldFFmpeg, additionalData) {
    return new Promise((resolve) => {
      if (oldFFmpeg) oldFFmpeg.destroy()

      // Deezer is not properly working

      // const trackData = await sources.getTrackStream(decodedTrack, url, protocol, additionalData)

      // if (trackData.exception) {
      //   utils.debugLog('retrieveStream', 4, { type: 2, sourceName: decodedTrack.sourceName, query: decodedTrack.title, message: trackData.exception.message })

      //   resolve({ status: 1, exception: { message: trackData.exception.message, severity: 'fault', cause: 'Unknown' } })
      // }

      const ffmpeg = new prism.FFmpeg({
        args: [
          '-loglevel', '0',
          '-analyzeduration', '0',
          '-hwaccel', 'auto',
          '-threads', config.filters.threads,
          '-filter_threads', config.filters.threads,
          '-filter_complex_threads', config.filters.threads,
          ...(cache ? ['-ss', `${(new Date() - cache.startedAt) - cache.pauseTime[1]}ms`] : []),
          '-i', `"${url}"`,
          '-af', this.command.join(','),
          ...(endTime ? ['-t', `${endTime}ms`] : []),
          '-f', 's16le',
          '-ar', '48000',
          '-ac', '2'
        ]
      })

      ffmpeg._stdout.once('data', () => {
        return resolve({ stream: new djsVoice.AudioResource([], [ffmpeg._stdout, new prism.VolumeTransformer({ type: 's16le' }), new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 }) ], null, 5), ffmpeg })
      })

      ffmpeg.on('error', (err) => console.error(err))
    })
  }
}

export default Filters