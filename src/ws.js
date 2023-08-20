import EventEmitter from 'node:events'

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
      'Sec-WebSocket-Accept: ' + req.headers['sec-websocket-key'],
      'Sec-WebSocket-Version: 13'
    ]

    socket.write(headers.join('\r\n') + '\r\n\r\n')

    socket.on('data', (data) => {
      this.emit('message', data)
    })

    socket.on('close', () => {
      this.emit('close', 1000, 'Connection closed')
    })

    socket.on('end', () => {
      this.emit('close', 1000, 'Connection ended')
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
    header[0] = 0b00000001

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

    const target = Buffer.allocUnsafe(payloadStartIndex)

    target[0] = options.fin ? options.opcode | 0x80 : options.opcode
    target[1] = payloadLength

    if (payloadLength == 126) {
      target.writeUInt16BE(options.len, 2)
    } else if (payloadLength == 127) {
      target[2] = target[3] = 0
      target.writeUIntBE(options.len, 4, 6)
    }

    if (!this.socket.write(Buffer.concat([target, data]))) {
      this.socket.end()

      return false
    }

    return true
  }

  close() {
    if (socket.destroyed || !socket.writable) return false

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