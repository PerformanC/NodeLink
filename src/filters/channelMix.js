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

class ChannelMix {
  constructor(data) {
    this.leftToLeft = data.leftToLeft
    this.leftToRight = data.leftToRight
    this.rightToLeft = data.rightToLeft
    this.rightToRight = data.rightToRight
  }

  process(leftSample, rightSample) {
    return {
      left: (this.leftToLeft * leftSample) + (this.rightToLeft * rightSample),
      right: (this.leftToRight * leftSample) + (this.rightToRight * rightSample)
    }
  }
}

export default ChannelMix