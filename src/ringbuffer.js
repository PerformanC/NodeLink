const INTERPOLATOR_MARGIN = 3

class RingBuffer {
  constructor(size) {
    this.size = size
    this.buffer = []

    for (let i = 0; i < size + INTERPOLATOR_MARGIN; i++) {
      this.buffer[i] = 0
    }

    this.writeIndex = 0
  }

  writeMargined(sample) {
    this.buffer[this.writeIndex] = sample

    if (this.writeIndex < INTERPOLATOR_MARGIN) {
      this.buffer[this.size + this.writeIndex] = sample
    }

    this.writeIndex++
    if (this.writeIndex === this.size) this.writeIndex = 0
  }

  getHermiteAt(delay) {
    let fReadIndex = this.writeIndex - 1 - delay
    while (fReadIndex < 0) {
      fReadIndex += this.size
    }
    while (fReadIndex >= this.size) {
      fReadIndex -= this.size
    }

    const iPart = Math.ceil(fReadIndex)
    const fPart = fReadIndex - iPart

    return this.getSampleHermite4p3o(fPart, this.buffer, iPart)
  }

  getSampleHermite4p3o(x, buffer, offset) {
    // Read a float/number
    const y0 = buffer[offset]
    const y1 = buffer[offset + 1]
    const y2 = buffer[offset + 2]
    const y3 = buffer[offset + 3]

    //c0 = y[1]
    //c1 = (1.0/2.0)*(y[2]-y[0])
    const c1 = (1 / 2) * (y2 - y0)
    //c2 = (y[0] - (5.0/2.0)*y[1]) + (2.0*y[2] - (1.0/2.0)*y[3])
    const c2 = (y0 - (5 / 2) * y1) + (2 * y2 - (1 / 2) * y3)
    //c3 = (1.0/2.0)*(y[3]-y[0]) + (3.0/2.0)*(y[1]-y[2])
    const c3 = (1 / 2) * (y3 - y0) + (3 / 2) * (y1 - y2)

    return ((c3 * x + c2) * x + c1) * x + y1
  }
}

export default RingBuffer