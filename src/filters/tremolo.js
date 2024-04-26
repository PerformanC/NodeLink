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

class Tremolo {
  constructor(data) {
    this.frequency = data.frequency
    this.depth = data.depth
    this.offset = 1 - data.depth / 2
    this.phase = 0
  }

  getTremoloMultiplier() {
    let env = this.frequency * this.phase / constants.opus.samplingRate
    env = Math.sin(2 * Math.PI * ((env + 0.25) % 1.0))

    this.phase++

    return env * (1 - Math.abs(this.offset)) + this.offset
  }

  process(leftSample, rightSample) {
    const multiplier = this.getTremoloMultiplier()

    return {
      left: leftSample * multiplier,
      right: rightSample * multiplier
    }
  }
}

export default Tremolo