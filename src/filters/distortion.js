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

class Distortion {
  constructor(data) {
    this.sinOffset = data.sinOffset
    this.sinScale = data.sinScale
    this.cosOffset = data.cosOffset
    this.cosScale = data.cosScale
    this.tanOffset = data.tanOffset
    this.tanScale = data.tanScale
    this.offset = data.offset
    this.scale = data.scale
  }

  _singleProcess(sample) {
    const sampleSin = this.sinOffset + Math.sin(sample * this.sinScale)
    const sampleCos = this.cosOffset + Math.cos(sample * this.cosScale)
    const sampleTan = this.tanOffset + Math.tan(sample * this.tanScale)

    return sample * (this.offset + this.scale * (this.sinScale !== 1 ? sampleSin : 1) * (this.cosScale !== 1 ? sampleCos : 1) * (this.tanScale !== 1 ? sampleTan : 1))
  }

  process(leftSample, rightSample) {
    return {
      left: this._singleProcess(leftSample),
      right: this._singleProcess(rightSample)
    }
  }
}

export default Distortion