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
 */

/*
 * This filter is a ported version of the original filter from the lavadsp project: https://github.com/natanbc/lavadsp
 */

import constants from '../../constants.js'

class Equalizer {
  constructor(bands) {
    this.history = new Array(constants.filtering.equalizerBands * 6).fill(0)
    this.bandMultipliers = bands
    this.current = 0
    this.minus1 = 2
    this.minus2 = 1
  }

  _singleProcess(sample) {
    let processedBand = sample * 0.25

    for (let bandIndex = 0; bandIndex < constants.filtering.equalizerBands; bandIndex++) {
      const coefficient = constants.sampleRate.coefficients[bandIndex]

      const x = bandIndex * 6
      const y = x + 3

      const bandResult = coefficient.alpha * (sample - this.history[x + this.minus2]) + coefficient.gamma * this.history[y + this.minus1] - coefficient.beta * this.history[y + this.minus2]

      this.history[x + this.current] = sample
      this.history[y + this.current] = bandResult

      processedBand += bandResult * this.bandMultipliers[bandIndex]
    }

    return processedBand * 4
  }

  process(leftSample, rightSample) {
    const results = {
      left: this._singleProcess(leftSample),
      right: this._singleProcess(rightSample)
    }
    
    if (++this.current === 3) this.current = 0
    if (++this.minus1 === 3) this.minus1 = 0
    if (++this.minus2 === 3) this.minus2 = 0

    return results
  }
}

export default Equalizer