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

class LowPass {
  constructor(data) {
    this.smoothing = data.smoothing
    this.value = 0
    this.initialized = false
  }

  _singleProcess(sample) {
    if (!this.initialized) {
      this.value = sample
      this.initialized = true
    }

    this.value += (sample - this.value) / this.smoothing

    return this.value
  }

  process(leftSample, rightSample) {
    return {
      left: this._singleProcess(leftSample),
      right: this._singleProcess(rightSample)
    }
  }
}

export default LowPass