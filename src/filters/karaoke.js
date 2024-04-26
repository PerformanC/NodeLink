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

class Karaoke {
  constructor(data) {
    this.level = data.level
    this.monoLevel = data.monoLevel
    this.filterBand = data.filterBand
    this.filterWidth = data.filterWidth

    this.C = Math.exp(-2 * Math.PI * this.filterWidth / constants.opus.samplingRate)
    this.B = (-4 * this.C / (1 + this.C)) * Math.cos(2 * Math.PI * this.filterBand / constants.opus.samplingRate)
    this.A = Math.sqrt(1 - this.B * this.B / (4 * this.C)) * (1 - this.C)

    this.y1 = 0
    this.y2 = 0
  }

  process(leftSample, rightSample) {
    const y = (this.A * ((leftSample + rightSample) / 2) - this.B * this.y1) - this.C * this.y2
    this.y2 = this.y1
    this.y1 = y

    const output = y * this.monoLevel * this.level

    return {
      left: leftSample - (rightSample * this.level) + output,
      right: rightSample - (leftSample * this.level) + output
    }
  }
}

export default Karaoke