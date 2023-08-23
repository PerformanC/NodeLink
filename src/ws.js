import EventEmitter from 'node:events'
import crypto from 'node:crypto'

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

    socket.on('close', () => {
      this.emit('close', 1006, 'Connection closed')
    })

    socket.on('end', () => {
      this.emit('close', 1006, 'Connection ended')
    })

    socket.on('error', (err) => {
      this.emit('error', err)
    })
  }

  send(data) {
    if (this.socket.destroyed || !this.socket.writable) return false

    const payload = Buffer.from(data, 'utf-8')
    const payloadLength = payload.length

    let headerLength = 2

    if (payloadLength <= 125) {
      // No additional bytes required in header
    } else if (payloadLength <= 0xFFFF) {
      headerLength += 2
    } else {
      headerLength += 8
    }

    const header = Buffer.alloc(headerLength)
    header[0] = 0x01 | 0x80

    if (payloadLength <= 125) {
      header[1] = payloadLength
    } else if (payloadLength <= 0xFFFF) {
      header[1] = 126
      header.writeUInt16BE(payloadLength, 2)
    } else {
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payloadLength), 2)
    }

    if (!this.socket.write(Buffer.concat([header, payload]))) {
      this.socket.end()

      return false
    }

    return true
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

    if (!this.socket.write(Buffer.concat([header, data]))) {
      this.socket.end()

      return false
    }

    return true
  }

  close() {
    if (this.socket.destroyed || !this.socket.writable) return false

    this.sendFrame(Buffer.alloc(0), { len: 0, fin: true, opcode: 0x08 })

    return true
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super()
  }

  handleUpgrade(req, socket, head, callback) {
    const connection = new WebsocketConnection(req, socket, head)

    callback(connection)
  }
}

export { WebSocketServer }