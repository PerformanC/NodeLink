import EventEmitter from 'node:events'
import crypto from 'node:crypto'

function parseFrameHeader(buffer) {
  let startIndex = 2

  const opcode = buffer[0] & 0b00001111
  const fin = (buffer[0] & 0b10000000) == 0b10000000
  const isMasked = (buffer[1] & 0x80) == 0x80
  let payloadLength = buffer[1] & 0b01111111

  if (payloadLength == 126) {
    startIndex += 2
    payloadLength = buffer.readUInt16BE(2)
  } else if (payloadLength == 127) {
    const buf = buffer.subarray(startIndex, startIndex + 8)

    payloadLength = buf.readUInt32BE(0) * Math.pow(2, 32) + buf.readUInt32BE(4)
    startIndex += 8
  }

  let mask = null

  if (isMasked) {
    mask = buffer.subarray(startIndex, startIndex + 4)
    startIndex += 4

    buffer = buffer.subarray(startIndex, startIndex + payloadLength)
    
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] ^= mask[i & 3];
    }
  } else {
    buffer = buffer.subarray(startIndex, startIndex + payloadLength)
  }

  return {
    opcode,
    fin,
    buffer,
    payloadLength
  }
}

class WebsocketConnection extends EventEmitter {
  constructor(req, socket, head, addHeaders) {
    super()

    this.req = req
    this.socket = socket

    socket.setNoDelay()
    socket.setKeepAlive(true)

    if (head.length != 0) socket.unshift(head)

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
      'Sec-WebSocket-Version: 13',
    ]

    if (addHeaders) {
      for (const [key, value] of Object.entries(addHeaders)) {
        headers.push(`${key}: ${value}`)
      }
    }

    socket.write(headers.join('\r\n') + '\r\n\r\n')

    const cachedData = []

    socket.on('data', (data) => {
      const headers = parseFrameHeader(data)

      switch (headers.opcode) {
        case 0x0: {
          this.cachedData.push(headers.buffer)

          if (headers.fin) {
            this.emit('message', Buffer.concat(this.cachedData).toString())

            this.cachedData = []
          }

          break
        }
        case 0x1: {
          this.emit('message', headers.buffer.toString())

          break
        }
        case 0x2: {
          throw new Error('Binary data is not supported.')

          break
        }
        case 0x8: {
          if (headers.buffer.length == 0) {
            this.emit('close', 1006, '')
          } else {
            const code = headers.buffer.readUInt16BE(0)
            const reason = headers.buffer.subarray(2).toString('utf-8')

            this.emit('close', code, reason)
          }

          socket.end()

          break
        }
        case 0x9: {
          const pong = Buffer.allocUnsafe(2)
          pong[0] = 0x8a
          pong[1] = 0x00

          this.socket.write(pong)

          break
        }
        case 0x10: {
          this.emit('pong')
        }
      }

      if (headers.buffer.length > headers.payloadLength)
        this.socket.unshift(headers.buffer)
    })

    socket.on('error', (err) => {
      socket.end()

      this.emit('error', err)
    })

    socket.on('end', () => {
      socket.end()

      this.emit('close', 1006, '')
    })
  }

  send(data) {
    const payload = Buffer.from(data, 'utf-8')

    return this.sendFrame(payload, { len: payload.length, fin: true, opcode: 0x01 })
  }

  destroy() {
    this.socket.destroy()
    this.socket = null
    this.req = null
  }

  sendFrame(data, options) {
    let payloadStartIndex = 2
    let payloadLength = options.len

    if (options.len >= 65536) {
      payloadStartIndex += 8
      payloadLength = 127
    } else if (options.len > 125) {
      payloadStartIndex += 2
      payloadLength = 126
    }

    const header = Buffer.allocUnsafe(payloadStartIndex)
    header[0] = options.fin ? options.opcode | 0x80 : options.opcode
    header[1] = payloadLength

    if (payloadLength == 126) {
      header.writeUInt16BE(options.len, 2)
    } else if (payloadLength == 127) {
      header[2] = header[3] = 0
      header.writeUIntBE(options.len, 4, 6)
    }

    if (this.socket) this.socket.write(Buffer.concat([header, data]))

    return true
  }

  close(code, reason) {
    const data = Buffer.allocUnsafe(2 + Buffer.byteLength(reason || 'normal close'))
    data.writeUInt16BE(code || 1000)
    data.write(reason || 'normal close', 2)

    this.sendFrame(data, { len: data.length, fin: true, opcode: 0x08 })

    return true
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super()
  }

  handleUpgrade(req, socket, head, headers, callback) {
    const connection = new WebsocketConnection(req, socket, head, headers)

    if (!socket.readable || !socket.writable) return socket.destroy()

    callback(connection)
  }
}

export { WebSocketServer }