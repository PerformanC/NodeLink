import config from '../../config.js'
import constants from '../../constants.js'

import prism from 'prism-media'

class NodeLinkStream {
  constructor(stream, pipes, ffmpegState) {
    pipes.unshift(stream)

    for (let i = 0; i < pipes.length - 1; i++) {
      const pipe = pipes[i]

      pipe.pipe(pipes[i + 1])
    }

    this.stream = pipes[pipes.length - 1]

    this.listeners = []
    this.pipes = pipes
    this.filtersIndex = []
    this.ffmpegState = ffmpegState

    /* @performanc/voice event */
    stream.on('finishBuffering', () => this.emit('finishBuffering'))
  }

  detach() {
    this.pipes.forEach((_, i) => {
      this.pipes[i].unpipe()
    })
  }

  rewindPipes() {
    this.pipes.forEach((_, i) => {
      if (i < this.pipes.length - 1) {
        this.pipes[i].pipe(this.pipes[i + 1])
      }
    })
  }

  _end() {
    this.listeners.forEach(({ event, listener }) => this.stream.removeListener(event, listener))
    this.listeners = []

    if (this.stream) { 
      this.stream.destroy()
      this.stream.removeAllListeners()
    }
  
    this.pipes.forEach((_, i) => {
      if (this.pipes[i].destroy) this.pipes[i].destroy()
      delete this.pipes[i]
    })
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

  removeListener(event, listener) {
    this.stream.removeListener(event, listener)
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
    this.pipes.find((pipe) => pipe instanceof prism.VolumeTransformer)?.setVolume(volume)
  }
}

function isDecodedInternally(stream, type) {
  switch (type) {
    case 'webm/opus':
    case 'ogg/opus': return 3 + 1 + (stream.ffmpegState === 2 ? -2 : 0)
    case 'wav': return 2 + 1 + (stream.ffmpegState === 2 ? -2 : 0)
    default: return false
  }
}

function createAudioResource(stream, type, additionalPipes = [], ffmpegState = false) {
  if ([ 'webm/opus', 'ogg/opus' ].includes(type)) {
    return new NodeLinkStream(stream, [
      new prism.opus[type === 'webm/opus' ? 'WebmDemuxer' : 'OggDemuxer'](),
      new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }),
      new prism.VolumeTransformer({ type: 's16le' }),
      ...additionalPipes,
      new prism.opus.Encoder({
        rate: constants.opus.samplingRate,
        channels: constants.opus.channels,
        frameSize: constants.opus.frameSize
      })
    ], ffmpegState)
  }

  if (type === 'wav') {
    return new NodeLinkStream(stream, [
      new prism.VolumeTransformer({ type: 's16le' }),
      ...additionalPipes,
      new prism.opus.Encoder({
        rate: constants.opus.samplingRate / 2,
        channels: constants.opus.channels / 2,
        frameSize: constants.opus.frameSize / 2
      })
    ], ffmpegState)
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
    ...additionalPipes,
    new prism.opus.Encoder({
      rate: constants.opus.samplingRate,
      channels: constants.opus.channels,
      frameSize: constants.opus.frameSize
    })
  ], ffmpegState)
}

export default {
  NodeLinkStream,
  isDecodedInternally,
  createAudioResource
}
