import constants from '../constants.js'

class lfo {
  constructor(frequency) {
    this.frequency = frequency
    this.phase = 0
  }

  getValue() {
    const dp = 2 * Math.PI * this.frequency / constants.opus.samplingRate
    const value = ((Math.sin(this.phase) + 1) * 0.5)
    this.phase += dp

    while (this.phase > 2 * Math.PI) {
      this.phase -= 2 * Math.PI
    }
  
    return value
  }
}

export default lfo