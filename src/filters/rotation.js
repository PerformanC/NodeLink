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

class RotationHz {
  constructor(data) {
    this.phase = 0
    this.rotationStep = (constants.circunferece.diameter * data.rotationHz) / constants.opus.samplingRate
    this.samplesPerCycle = constants.opus.samplingRate / (data.rotationHz * constants.circunferece.diameter)
    this.dI = data.rotationHz == 0 ? 0 : 1 / this.samplesPerCycle
    this.x = 0
  }

  process(leftSample, rightSample) {
    const sin = Math.sin(this.x)
    this.x += this.dI

    return {
      left: leftSample * (sin + 1) / 2,
      right: rightSample * (-sin + 1) / 2
    }
  }
}

export default RotationHz