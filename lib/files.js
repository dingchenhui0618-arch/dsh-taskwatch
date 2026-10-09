/**
 * 交付文件解析 —— 把「手机页要显示的图片 / PDF / 文本」映射成一个**受限的**本地读操作。
 *
 * 为什么单独成模块，而不是写进路由闭包里：
 * 白名单与目录穿越防护是这个功能真正的安全边界。放在闭包里，契约测试就只能靠读代码
 * 相信它；抽成纯函数之后，测试可以直接断言 `../../.credentials.yaml` 会被拒。
 *
 * 边界（三条，缺一条这个功能就不该上线）：
 *   1. 只服务白名单根目录之下的文件 —— 默认只有宿主附件库与交付 outbox；
 *   2. 解析后必须**再按真实路径（realpath）复查一次** —— 字符串检查挡不住根目录里的符号链接；
 *   3. 只服务白名单扩展名，`.svg` / `.html` / `.js` 一律拒绝 —— 它们与本页面同源，
 *      一旦内联就是可执行内容（存储型 XSS），而"看图看 PDF"根本不需要它们。
 */
import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'

/** 可服务的类型。每条都写明用途，避免以后有人"顺手"往里加。 */
const MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.zip', 'application/zip'],
])

/** 显式拒绝：与页面同源的可执行内容。命中就报 denied-type，不做任何降级。 */
const DENIED = new Set(['.svg', '.svgz', '.html', '.htm', '.xhtml', '.js', '.mjs', '.cjs', '.css', '.xml'])

/** 单文件上限。手机流量 + 内存都要有数，超了直接 413，不偷偷截断。 */
export const MAX_BYTES = 32 * 1024 * 1024

/** 默认白名单：宿主附件库（用户上传 / 模型读过的图）与交付 outbox（模型产出的文件）。 */
export function defaultRoots(home) {
  const h = home || homedir()
  return [join(h, '.dsh', 'attachments'), join(h, '.dsh', 'outbox')]
}

/** `~` 展开。只认开头的 `~` / `~/` / `~\`，中间出现的 `~` 是普通字符。 */
export function expandHome(input, home) {
  const h = home || homedir()
  const p = String(input == null ? '' : input)
  if (p === '~') return h
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(h, p.slice(2))
  return p
}

/** 环境变量覆盖（`;` 分隔）。没配就回默认两条。 */
export function rootsFrom(value, home) {
  if (typeof value === 'string' && value.trim()) {
    const out = []
    for (const part of value.split(';')) {
      const p = part.trim()
      if (!p) continue
      out.push(resolve(expandHome(p, home)))
    }
    if (out.length) return out
  }
  return defaultRoots(home)
}

/** 严格包含判断：`/a/bc` 不算在 `/a/b` 之下（前缀检查最容易在这里写错）。 */
export function withinRoot(abs, root) {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root
  return abs === r || abs.startsWith(r + sep)
}

/** 扩展名 → 类型。返回 { ok, mime } 或 { ok:false, error, ext }。 */
export function mimeFor(abs) {
  const ext = extname(String(abs)).toLowerCase()
  if (DENIED.has(ext)) return { ok: false, error: 'denied-type', ext }
  const mime = MIME.get(ext)
  if (!mime) return { ok: false, error: 'unsupported-type', ext }
  return { ok: true, mime, ext }
}

/** 大类：页面靠它决定"铺大图"还是"给一张卡片"。 */
export function kindOf(mime) {
  const m = String(mime || '')
  if (m.startsWith('image/')) return 'image'
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('text/') || m === 'application/json; charset=utf-8') return 'text'
  if (m.startsWith('video/')) return 'video'
  return 'file'
}

/** 图片 / PDF / 文本直接内嵌，其余作为附件下载。 */
export function dispositionFor(mime, name) {
  const kind = kindOf(mime)
  const safe = String(name || 'file').replace(/["\\\r\n]/g, '_')
  return (kind === 'file' ? 'attachment' : 'inline') + '; filename="' + safe + '"'
}

/**
 * 把请求里的 path 解析成一个可读的绝对路径。
 * 返回 { ok:true, abs, mime, bytes, name, kind } 或 { ok:false, error }。
 * 不抛异常 —— 拒绝理由要原样回给调用方（也回给测试）。
 */
export function resolveTarget(input, roots, home) {
  const h = home || homedir()
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'missing-path' }
  const raw = expandHome(input.trim(), h)
  if (!isAbsolute(raw)) return { ok: false, error: 'not-absolute' }
  const abs = resolve(raw)
  const list = (Array.isArray(roots) && roots.length ? roots : defaultRoots(h)).map((r) => resolve(expandHome(r, h)))
  if (!list.some((r) => withinRoot(abs, r))) return { ok: false, error: 'outside-roots' }

  const types = mimeFor(abs)
  if (!types.ok) return { ok: false, error: types.error, ext: types.ext }

  let real
  try {
    real = realpathSync(abs)
  } catch {
    return { ok: false, error: 'not-found' }
  }
  // 复查真实路径：根目录里存在指向外部的符号链接时，上面的字符串检查会放行。
  if (!list.some((r) => withinRoot(real, r))) return { ok: false, error: 'outside-roots' }

  let st
  try {
    st = statSync(real)
  } catch {
    return { ok: false, error: 'not-found' }
  }
  if (!st.isFile()) return { ok: false, error: 'not-a-file' }
  if (st.size > MAX_BYTES) return { ok: false, error: 'too-large', bytes: st.size }

  return { ok: true, abs: real, mime: types.mime, bytes: st.size, name: basename(real), kind: kindOf(types.mime) }
}

/** 给页面文件卡片用的元数据（不读字节）。 */
export function infoOf(hit) {
  return { name: hit.name, bytes: hit.bytes, mime: hit.mime, kind: hit.kind }
}
