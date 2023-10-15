import EventEmitter from 'node:events'
import crypto from 'node:crypto'

function parseFrameHeader(data) {
  let startIndex = 2

  const opcode = data[0] & 0b00001111

  if (opcode == 0x0) startIndex += 2

  const isMasked = !!(data[1] & 0b10000000)
  let length = data[1] & 0b01111111

  if (length == 126) {
    startIndex += 2
    length = data.readUInt16BE(2)
  } else if (length == 127) {
    startIndex += 8
    length = data.readBigUInt64BE(2)
  }

  if (isMasked) {
    data.slice(startIndex, startIndex + 4)
    startIndex += 4
  }

  return {
    opcode,
    isMasked,
    buffer: data.slice(startIndex, startIndex + length)
  }
}

class WebsocketConnection extends EventEmitter {
  constructor(req, socket, head) {
    super()

    this.req = req
    this.socket = socket
    this.head = head

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
      'Sec-WebSocket-Version: 13'
    ]

    socket.write(headers.join('\r\n') + '\r\n\r\n')

    socket.on('data', (data) => {
      const { opcode, buffer } = parseFrameHeader(data)

      if (opcode == 0x08) {
        if (buffer.length == 0) {
          this.emit('close', 1006, '')
        } else {
          const code = buffer.readUInt16BE(0)
          const reason = buffer.slice(2).toString('utf-8')

          this.emit('close', code, reason)
        }

        return socket.end()
      }
    })

    socket.on('error', (err) => this.emit('error', err))

    socket.on('end', () => this.emit('close', 1006, ''))
  }

  send(data) {
    const payload = Buffer.from(data, 'utf-8')

    return this.sendFrame(payload, { len: payload.length, fin: true, opcode: 0x01 })
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

    this.socket.write(Buffer.concat([header, data]))

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

  handleUpgrade(req, socket, head, callback) {
    const connection = new WebsocketConnection(req, socket, head)

    if (!socket.readable || !socket.writable) return socket.destroy()

    callback(connection)
  }
}

export { WebSocketServer }