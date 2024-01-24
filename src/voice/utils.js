import config from '../../config.js'
import constants from '../../constants.js'

import prism from 'prism-media'

class NodeLinkStream {
  constructor(stream, pipes) {
    pipes.unshift(stream)

    for (let i = 0; i < pipes.length - 1; i++) {
      const pipe = pipes[i]

      pipe.pipe(pipes[i + 1])

      if (pipe instanceof prism.FFmpeg) {
        this.ffmpeg = pipe
      }
      if (pipe instanceof prism.VolumeTransformer) {
        this.volume = pipe
      }
      if (pipe instanceof prism.opus.Encoder) {
        this.encoder = pipe
      }
    }

    this.stream = pipes[pipes.length - 1]

    this.listeners = []
    this.pipes = pipes

    this.stream.on('close', () => this._end())
  }

  _end() {
    this.listeners.forEach(({ event, listener }) => this.stream.removeListener(event, listener))
    this.listeners = []
  
    this.pipes.forEach((_, i) => {
      if (this.pipes[i].destroy) this.pipes[i].destroy()
      delete this.pipes[i]
    })

    if (this.stream) { 
      this.stream.destroy()
      this.stream = null
    }
    this.ffmpeg = null
    this.volume = null
    this.encoder = null
  }

  on(event, listener) {
    this.listeners.push({ event, listener })

    this.stream.on(event, listener)
  }

  once(event, listener) {
    this.listeners.push({ event, listener })

    this.stream.once(event, listener)
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

  destroy() {
    this._end()
  }

  setVolume(volume) {
    this.volume.setVolume(volume)
  }
}

function createAudioResource(stream, type) {
  if ([ 'webm/opus', 'ogg/opus' ].includes(type)) {
    return new NodeLinkStream(stream, [
      new prism.opus[type == 'webm/opus' ? 'WebmDemuxer' : 'OggDemuxer'](),
      new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }),
      new prism.VolumeTransformer({ type: 's16le' }),
      new prism.opus.Encoder({
        rate: constants.opus.samplingRate,
        channels: constants.opus.channels,
        frameSize: constants.opus.frameSize
      })
    ])
  }

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
    new prism.opus.Encoder({
      rate: constants.opus.samplingRate,
      channels: constants.opus.channels,
      frameSize: constants.opus.frameSize
    })
  ])
}

export default {
  NodeLinkStream,
  createAudioResource
}
