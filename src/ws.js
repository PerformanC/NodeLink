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
      console.log(data)

      this.emit('message', data)
    })

    socket.on('close', () => {
      this.emit('close')
    })

    socket.on('error', (err) => {
      this.emit('error', err)
    })
  }

  send(data) {
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

    this.socket.write(Buffer.concat([header, payload]))

    return true
  }

  close() {
    this.socket.end()

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