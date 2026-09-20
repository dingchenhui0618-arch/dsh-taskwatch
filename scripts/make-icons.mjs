#!/usr/bin/env node
/**
 * 生成 PWA 图标（192 / 512，PNG）。
 *
 * 为什么手写 PNG 编码而不引依赖：这个仓库刻意保持零依赖，
 * 而所需的图形只是「深色底 + 一条折线」。用 Node 内置的 zlib 就够了。
 *
 * 输出为**满幅不透明**方形：这样同一个文件既能当普通图标，
 * 也能被 Android 当 maskable 图标裁切（图形都在中心 80% 安全区内）。
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'lib', 'icons')

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** rgba: Buffer，长度 = w*h*4。 */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // 每条扫描线前置一个 filter 字节 0（None）
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------- 图形 ----------
const BG = [0x15, 0x18, 0x1f]
const LINE = [0x3e, 0xcf, 0x8e]

/** 点到线段的最短距离。 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** 平滑过渡，用于抗锯齿。 */
function smooth(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function buildIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const s = size / 512 // 以 512 为设计基准缩放

  // 折线设计坐标（512 基准），全部落在中心 80% 安全区内
  const pts = [
    [72, 256], [160, 256], [204, 140], [256, 372], [308, 256], [440, 256],
  ].map(([x, y]) => [x * s, y * s])
  const halfWidth = 19 * s

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5

      let d = Infinity
      for (let i = 0; i + 1 < pts.length; i++) {
        const [x1, y1] = pts[i]
        const [x2, y2] = pts[i + 1]
        const seg = distToSegment(px, py, x1, y1, x2, y2)
        if (seg < d) d = seg
      }

      // 覆盖度：半宽内全描，半宽外 1px 内渐隐
      const cover = 1 - smooth(halfWidth, halfWidth + 1.2 * s, d)
      const alpha = cover
      const offset = (y * size + x) * 4
      rgba[offset] = Math.round(BG[0] * (1 - alpha) + LINE[0] * alpha)
      rgba[offset + 1] = Math.round(BG[1] * (1 - alpha) + LINE[1] * alpha)
      rgba[offset + 2] = Math.round(BG[2] * (1 - alpha) + LINE[2] * alpha)
      rgba[offset + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT, { recursive: true })
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`)
  writeFileSync(file, buildIcon(size))
  console.log(`wrote ${file}`)
}
