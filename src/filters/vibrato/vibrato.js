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

import constants from '../../../constants.js'

import lfo from './lfo.js'
import RingBuffer from './ringBuffer.js'

const ADDITIONAL_DELAY = 3
const BASE_DELAY_SEC = 0.002

class Vibrato {
  constructor(data) {
    this.depth = data.depth
    this.lfo = new lfo(data.frequency)
    this.buffer = new RingBuffer(Math.ceil(BASE_DELAY_SEC * constants.opus.samplingRate * 2))
  }

  _singleProcess(sample) {
    const lfoValue = this.lfo.getValue()
    const maxDelay = Math.ceil(BASE_DELAY_SEC * constants.opus.samplingRate)

    const delay = lfoValue * this.depth * maxDelay + ADDITIONAL_DELAY

    const result = this.buffer.getHermiteAt(delay)

    this.buffer.writeMargined(sample)

    return result
  }

  process(leftSample, rightSample) {
    return {
      left: this._singleProcess(leftSample),
      right: this._singleProcess(rightSample)
    }
  }
}

export default Vibrato