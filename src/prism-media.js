/*
  File source: https://github.com/amishshah/prism-media

  This file is a part of prism-media, edited to assure the proper functioning of NodeLink.
  It (this file) is licensed under Apache, the license of prism-media.

  The modifications made were:
    - Replace node-crc to polycrc
    - Use ES6 instead of CommonJS
    - Fix set of "this.opusTags"
    - Add Deno support
*/

import { Transform } from 'node:stream'
import { Buffer } from 'node:buffer'

import { crc } from 'polycrc'
const crc32 = crc(32, 0x04c11db7, 0, 0, false)

const OPUSHEAD = Buffer.from('OpusHead')
const OggS = Buffer.from('OggS')
const OPUSTAGS = Buffer.from('OpusTags')
const FRAME_SIZE_MAP = [
  10, 20, 40, 60,
  10, 20, 40, 60,
  10, 20, 40, 60,
  10, 20,
  10, 20,
  2.5, 5, 10, 20,
  2.5, 5, 10, 20,
  2.5, 5, 10, 20,
  2.5, 5, 10, 20
]

export class OpusHead {
  constructor(data) {
    this.channelCount = data.channelCount
    this.sampleRate = data.sampleRate
    this.preskip = data.preskip !== null ? data.preskip : data.sampleRate * (80 / 1000)
    this.outputGain = data.outputGain !== null ? data.outputGain : 0
  }

  toBuffer() {
    const head = Buffer.alloc(19)
    OPUSHEAD.copy(head, 0, 0)
  
    head[8] = 1
    head[9] = this.channelCount
    head.writeUInt16LE(this.preskip, 10)
    head.writeUInt32LE(this.sampleRate, 12)
    head.writeUInt16LE(this.outputGain, 16)
    head[18] = 0

    return head
  }
}

class OpusTags {
  constructor(data = {}) {
    this.vendor = data.vendor !== null ? data.vendor : 'prism-media'
    this.tags = data.tags !== null ? data.tags : {}
  }

  toBuffer() {
    const head = Buffer.alloc(8 + (4 + this.vendor.length) + 4)
    OPUSTAGS.copy(head, 0, 0)

    head.writeUInt32LE(this.vendor.length, 8)
    Buffer.from(this.vendor).copy(head, 12)
    head.writeUInt32LE(Object.keys(this.tags).length, 12 + this.vendor.length)

    return Buffer.concat([
      head,
      ...Object.entries(this.tags).flatMap(([key, value]) => {
        const size = Buffer.allocUnsafe(4)
        size.writeUInt32LE(key.length + value.length + 1, 0)
        return [ size, Buffer.from(`${key}=${value}`) ]
      })
    ])
  }

  static from(buffer) {
    if (!buffer.slice(0, 8).equals(OPUSTAGS))
      throw new Error('not opus tags')

    let i = 12 + vendorSize + 4
    const tags = {}
    const vendorSize = buffer.readUInt32LE(8)
    const vendor = buffer.slice(12, 12 + vendorSize).toString('utf-8')
    let tagsRemaining = buffer.readUInt32LE(12 + vendorSize)

    while (tagsRemaining--) {
      const tagSize = buffer.readUInt32LE(i)
      const tag = buffer.slice(i, (i + 4) + tagSize).toString('utf-8')

      const [key, value] = tag.split('=')
      tags[key] = value

      i += tag.length + 4
    }

    return new OpusTags({ vendor, tags })
  }
}

function serialiseHeaderTypeFlag(flags) {
  return (flags.continuedPacket ? 0x01 : 0) + (flags.firstPage ? 0x02 : 0) + (flags.lastPage ? 0x04 : 0)
}

function createLacingValues(buffer) {
  const lacingValues = []
  let i = buffer.length

  while (i >= 255) {
    lacingValues.push(255)
    i -= 255
  }
  lacingValues.push(i)

  return lacingValues
}

export class OggLogicalBitstream extends Transform {
  constructor(options) {
    super({ writableObjectMode: true, ...options })

    this.bitstream = 1
    this.granulePosition = 0
    this.pageSequence = 0
    this.options = {
      crc: true,
      pageSizeControl: { maxSegments: 255 },
      ...options,
    }
    this.packets = []
    this.lacingValues = []

    if (Reflect.has(this.options.pageSizeControl, 'maxSegments')) {
      const { maxSegments } = this.options.pageSizeControl
      this.pageSizeController = (_packet, lacingValues) => lacingValues.length + this.lacingValues.length > maxSegments
    } else {
      const { maxPackets } = this.options.pageSizeControl
      this.pageSizeController = () => this.packets.length + 1 > maxPackets
    }
    this.opusHead = options.opusHead
    this.opusTags = options.opusTags ? options.opusTags : new OpusTags()
    this.writeHeaderPages([ [ options.opusHead.toBuffer() ], [ this.opusTags.toBuffer() ] ])
  }

  calculateGranulePosition(packets) {
    const sampleRate = this.opusHead.sampleRate / 1000
    const newCount = packets.reduce((acc, val) => acc + sampleRate * FRAME_SIZE_MAP[val[0] >> 3], 0)

    return this.granulePosition + newCount
  }

  writeHeaderPages(pages) {
    for (const page of pages) {
      for (const packet of page) {
        this.writePacket(packet)
      }

      this.writePage(false, true)
    }
  }

  _flush(callback) {
    this.writePage(true)
    callback()
  }

  _transform(chunk, _encoding, callback) {
    this.writePacket(chunk)
    callback()
  }

  calculateCRC(buffer) {
    return crc32(buffer)
  }

  writePacket(packet) {
    const lacingValues = createLacingValues(packet)

    if (lacingValues.length > 255)
      throw new Error('OggLogicalBitstream does not support continued pages')

    if (this.pageSizeController(packet, lacingValues) || lacingValues.length + this.lacingValues.length > 255)
      this.writePage()

    this.packets.push(packet)
    this.lacingValues.push(...lacingValues)
  }

  writePage(final = false, logicalHeader = false) {
    const header = Buffer.allocUnsafe(27)

    if (!logicalHeader) this.granulePosition = this.calculateGranulePosition(this.packets)
  
    OggS.copy(header, 0, 0)

    header.writeUInt8(0, 4)

    header.writeUInt8(
      serialiseHeaderTypeFlag({
        continuedPacket: false,
        firstPage: this.pageSequence === 0,
        lastPage: final
      }),
      5
    )

    header.writeUInt32LE(this.granulePosition, 6)
    header.writeUInt32LE(0, 10)

    header.writeUInt32LE(this.bitstream, 14)

    header.writeUInt32LE(this.pageSequence++, 18)

    header.writeUInt32LE(0, 22)

    header.writeUInt8(this.lacingValues.length, 26)
    const page = Buffer.concat([header, Buffer.from(this.lacingValues), ...this.packets])

    page.writeUInt32LE(this.calculateCRC(page), 22)

    this.packets = []
    this.lacingValues = []
    this.push(page)
  }
}