import { pipeline } from 'node:stream'

import config from '../../config.js'

import prism from 'prism-media'

class NodeLinkStream {
  constructor(stream, pipes) {
    pipes.unshift(stream)

    this.stream = pipeline(pipes, () => {})
    this.listeners = []
  
    pipes.forEach((pipe) => {
      if (pipe instanceof prism.FFmpeg) {
        this.ffmpeg = pipe
      }
      if (pipe instanceof prism.VolumeTransformer) {
        this.volume = pipe
      }
      if (pipe instanceof prism.opus.Encoder) {
        this.encoder = pipe
      }
    })

    this.stream.once('readable', () => this.started = true)
    this.stream.on('end', () => {
      this.listeners.forEach(({ event, listener }) => this.stream.removeListener(event, listener))
      this.listeners = []
    
      if (this.ffmpeg) this.ffmpeg.destroy()
      if (this.volume) this.volume.destroy()
      if (this.encoder) this.encoder.destroy()

      this.stream = null
      this.ffmpeg = null
      this.volume = null
      this.encoder = null
    })
  }

  on(event, listener) {
    this.listeners.push({ event, listener })

    this.stream.on(event, listener)
  }

  once(event, listener) {
    this.listeners.push({ event, listener })

    this.stream.once(event, listener)

    if (event == 'readable' && this.started) listener()
  }

  emit(event, ...args) {
    this.stream.emit(event, ...args)
  }

  read() {
    return this.stream?.read()
  }

  resume() {
    this.stream?.resume()
  }

  setVolume(volume) {
    this.volume.setVolume(volume)
  }
}

function createAudioResource(stream) {
  const ffmpeg = new prism.FFmpeg({
    args: [
      '-loglevel', '0',
      '-analyzeduration', '0',
      '-hwaccel', 'auto',
      '-threads', config.filters.threads,
      '-filter_threads', config.filters.threads,
      '-filter_complex_threads', config.filters.threads,
      '-i', '-',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-crf', '0'
    ]
  })

  return new NodeLinkStream(stream, [
    ffmpeg, 
    new prism.VolumeTransformer({ type: 's16le' }),
    new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 })
  ])
}

export default {
  createAudioResource
}