import { Transform } from 'node:stream'

import constants from '../../constants.js'
import Vibrato from './vibrato/vibrato.js'
import ChannelMix from './channelMix.js'
import Distortion from './distortion.js'
import Equalizer from './equalizer.js'
import Karaoke from './karaoke.js'
import LowPass from './lowPass.js'
import Rotation from './rotation.js'
import Tremolo from './tremolo.js'
import { clamp16Bit } from '../utils.js'

const CHANNEL_COUNT = 2

class Interface extends Transform {
  constructor(type, data) {
    super()

    switch (type) {
      /* volume */
      case constants.filtering.types.equalizer: {
        this.filter = new Equalizer(data)

        break
      }
      case constants.filtering.types.karaoke: {
        this.filter = new Karaoke(data)

        break
      }
      /* timescale */
      case constants.filtering.types.tremolo: {
        this.filter = new Tremolo(data)

        break
      }
      case constants.filtering.types.vibrato: {
        this.filter = new Vibrato(data)

        break
      }
      case constants.filtering.types.rotation: {
        this.filter = new Rotation(data)

        break
      }
      case constants.filtering.types.distortion: {
        this.filter = new Distortion(data)

        break
      }
      case constants.filtering.types.channelMix: {
        this.filter = new ChannelMix(data)

        break
      }
      case constants.filtering.types.lowPass: {
        this.filter = new LowPass(data)

        break
      }
    }
  }

  _transform(samples, _encoding, callback) {
    for (let i = 0; i < samples.length - constants.pcm.bytes - 1; i += constants.pcm.bytes * CHANNEL_COUNT) {
      const leftSample = samples.readInt16LE(i)
      const rightSample = samples.readInt16LE(i + 2)

      const results = this.filter.process(leftSample, rightSample)

      samples.writeInt16LE(clamp16Bit(results.left), i)
      samples.writeInt16LE(clamp16Bit(results.right), i + 2)
    }

    return callback(null, samples)
  }
}

function isValid(filter) {
  return filter.name in constants.filtering.types
}

export default {
  Interface,
  isValid
}