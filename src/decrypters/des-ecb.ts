import { Buffer } from 'node:buffer'

const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38,
  30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1,
  59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39,
  31, 23, 15, 7
]

const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14,
  54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28,
  35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9,
  49, 17, 57, 25
]

const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16,
  17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29,
  28, 29, 30, 31, 32, 1
]

const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32,
  27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25
]

const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
  27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38,
  30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4
]

const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27,
  20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34,
  53, 46, 42, 50, 36, 29, 32
]

const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]

const SBOX = [
  [
    [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7],
    [0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8],
    [4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0],
    [15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13]
  ],
  [
    [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10],
    [3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5],
    [0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15],
    [13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9]
  ],
  [
    [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8],
    [13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1],
    [13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7],
    [1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12]
  ],
  [
    [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15],
    [13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9],
    [10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4],
    [3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14]
  ],
  [
    [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9],
    [14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6],
    [4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14],
    [11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3]
  ],
  [
    [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11],
    [10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8],
    [9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6],
    [4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13]
  ],
  [
    [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1],
    [13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6],
    [1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2],
    [6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12]
  ],
  [
    [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7],
    [1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2],
    [7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8],
    [2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
  ]
]

const SP = buildSPTables()
const SUBKEY_CACHE = new Map()

function buildSPTables(): Uint32Array[] {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(64))

  for (let s = 0; s < 8; s++) {
    for (let v = 0; v < 64; v++) {
      const row = ((v & 0x20) >> 4) | (v & 0x01)
      const col = (v >> 1) & 0x0f
      const sval = (SBOX[s]?.[row]?.[col] ?? 0) & 0x0f

      const shift = 28 - s * 4
      const sWord = (sval << shift) >>> 0

      const table = tables[s]
      if (table) table[v] = permute32(sWord, P)
    }
  }

  return tables
}

function permute32(value: number, table: number[]): number {
  let out = 0
  for (let i = 0; i < 32; i++) {
    const bit = (value >>> (32 - (table[i] ?? 0))) & 1
    out = (out << 1) | bit
  }
  return out >>> 0
}

function getBitFrom64(high: number, low: number, pos: number): number {
  if (pos <= 32) return (high >>> (32 - pos)) & 1
  return (low >>> (64 - pos)) & 1
}

function getBitFrom56(c: number, d: number, pos: number): number {
  if (pos <= 28) return (c >>> (28 - pos)) & 1
  return (d >>> (56 - pos)) & 1
}

function permute64(
  high: number,
  low: number,
  table: number[]
): [number, number] {
  let outHigh = 0
  let outLow = 0
  for (let i = 0; i < 64; i++) {
    const bit = getBitFrom64(high, low, table[i] ?? 0)
    if (i < 32) outHigh = (outHigh << 1) | bit
    else outLow = (outLow << 1) | bit
  }
  return [outHigh >>> 0, outLow >>> 0]
}

function rotl28(x: number, s: number): number {
  return ((x << s) | (x >>> (28 - s))) & 0x0fffffff
}

function makeSubkeys(keyBytes: Uint8Array | Buffer): Uint8Array[] {
  const high =
    ((keyBytes[0] ?? 0) << 24) |
    ((keyBytes[1] ?? 0) << 16) |
    ((keyBytes[2] ?? 0) << 8) |
    (keyBytes[3] ?? 0)
  const low =
    ((keyBytes[4] ?? 0) << 24) |
    ((keyBytes[5] ?? 0) << 16) |
    ((keyBytes[6] ?? 0) << 8) |
    (keyBytes[7] ?? 0)

  let c = 0
  let d = 0

  for (let i = 0; i < 28; i++) {
    c = (c << 1) | getBitFrom64(high, low, PC1[i] ?? 0)
  }
  for (let i = 28; i < 56; i++) {
    d = (d << 1) | getBitFrom64(high, low, PC1[i] ?? 0)
  }

  const subkeys: Uint8Array[] = []

  for (let round = 0; round < 16; round++) {
    c = rotl28(c, SHIFTS[round] ?? 0)
    d = rotl28(d, SHIFTS[round] ?? 0)

    const k = new Uint8Array(8)
    for (let j = 0; j < 8; j++) {
      let v = 0
      for (let kbit = 0; kbit < 6; kbit++) {
        const pos = PC2[j * 6 + kbit] ?? 0
        v = (v << 1) | getBitFrom56(c, d, pos)
      }
      k[j] = v
    }
    subkeys.push(k)
  }

  return subkeys
}

function feistel(r: number, subkey: Uint8Array): number {
  let out = 0
  for (let j = 0; j < 8; j++) {
    let v = 0
    for (let b = 0; b < 6; b++) {
      const pos = E[j * 6 + b] ?? 0
      v = (v << 1) | ((r >>> (32 - pos)) & 1)
    }
    v ^= subkey[j] ?? 0
    out |= (SP[j] ?? [])[v] ?? 0
  }
  return out >>> 0
}

function desBlockAt(
  input: Buffer | Uint8Array,
  offset: number,
  subkeys: Uint8Array[],
  decrypt: boolean,
  out: Buffer | Uint8Array
) {
  const high =
    ((input[offset] ?? 0) << 24) |
    ((input[offset + 1] ?? 0) << 16) |
    ((input[offset + 2] ?? 0) << 8) |
    (input[offset + 3] ?? 0)
  const low =
    ((input[offset + 4] ?? 0) << 24) |
    ((input[offset + 5] ?? 0) << 16) |
    ((input[offset + 6] ?? 0) << 8) |
    (input[offset + 7] ?? 0)

  let [l, r] = permute64(high >>> 0, low >>> 0, IP)

  for (let i = 0; i < 16; i++) {
    const k = decrypt
      ? (subkeys[15 - i] ?? new Uint8Array(8))
      : (subkeys[i] ?? new Uint8Array(8))
    const nextL = r
    const nextR = (l ^ feistel(r, k)) >>> 0
    l = nextL
    r = nextR
  }

  const preHigh = r
  const preLow = l
  const [fHigh, fLow] = permute64(preHigh, preLow, FP)

  out[offset] = (fHigh >>> 24) & 0xff
  out[offset + 1] = (fHigh >>> 16) & 0xff
  out[offset + 2] = (fHigh >>> 8) & 0xff
  out[offset + 3] = fHigh & 0xff
  out[offset + 4] = (fLow >>> 24) & 0xff
  out[offset + 5] = (fLow >>> 16) & 0xff
  out[offset + 6] = (fLow >>> 8) & 0xff
  out[offset + 7] = fLow & 0xff
}

function pkcs7Unpad(buf: Buffer | Uint8Array): Buffer | Uint8Array {
  if (!buf.length) return buf
  const pad = buf[buf.length - 1] ?? 0
  if (pad <= 0 || pad > 8) return buf
  for (let i = buf.length - pad; i < buf.length; i++) {
    if ((buf[i] ?? 0) !== pad) return buf
  }
  return buf.subarray(0, buf.length - pad)
}

/**
 * Decrypts a Base64-encoded encrypted string using DES in ECB mode and returns the result as a UTF-8 string.
 * @param encryptedBase64 - The Base64-encoded encrypted data.
 * @param key - The 8-byte DES encryption key.
 * @returns The decrypted UTF-8 string.
 * @throws Error if the key length is not 8 bytes or if the data length is not a multiple of 8.
 */
export function desEcbDecryptBase64ToUtf8(
  encryptedBase64: string,
  key: string | Buffer | Uint8Array
): string {
  if (!encryptedBase64) return ''

  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(key)
  if (keyBuf.length !== 8) {
    throw new Error(`Invalid DES key length: ${keyBuf.length}`)
  }

  const data = Buffer.from(encryptedBase64, 'base64')
  if (data.length % 8 !== 0) {
    throw new Error('Invalid DES block size')
  }

  const cacheKey = keyBuf.toString('hex')
  let subkeys = SUBKEY_CACHE.get(cacheKey)
  if (!subkeys) {
    subkeys = makeSubkeys(keyBuf)
    SUBKEY_CACHE.set(cacheKey, subkeys)
  }

  const out = Buffer.allocUnsafe(data.length)
  for (let i = 0; i < data.length; i += 8) {
    desBlockAt(data, i, subkeys, true, out)
  }

  const unpadded = pkcs7Unpad(out)
  return unpadded.toString('utf8')
}
