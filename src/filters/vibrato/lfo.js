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
 * This file is a ported version of the original work from the lavadsp project: https://github.com/natanbc/lavadsp
 */

import constants from '../../../constants.js'

class lfo {
  constructor(frequency) {
    this.frequency = frequency
    this.phase = 0
  }

  getValue() {
    const dp = 2 * Math.PI * this.frequency / constants.opus.samplingRate
    const value = ((Math.sin(this.phase) + 1) * 0.5)
    this.phase += dp

    while (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI
  
    return value
  }
}

export default lfo