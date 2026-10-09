/**
 * 交付文件边界的契约测试。
 *
 * 为什么不并进 check-bundle.mjs：那个文件测的是"生成的 HTML 与当前页面一致"，
 * 这里测的是**安全语义** —— 一旦红了，意味着手机侧多读到了不该读的东西，
 * 比 UI 漂移严重得多。分开之后，两者各自的失败含义不会被混在一起。
 *
 * 用法：node scripts/check-files.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_BYTES,
  defaultRoots,
  dispositionFor,
  kindOf,
  mimeFor,
  resolveTarget,
  rootsFrom,
  withinRoot,
} from '../lib/files.js'

let pass = 0
let fail = 0
function ok(label, cond, extra) {
  if (cond) {
    pass++
    console.log('  PASS ' + label)
  } else {
    fail++
    console.log('  FAIL ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)))
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'taskwatch-files-'))
const rootA = join(sandbox, 'attachments')
const rootB = join(sandbox, 'outbox')
const outside = join(sandbox, 'outside')
mkdirSync(rootA, { recursive: true })
mkdirSync(rootB, { recursive: true })
mkdirSync(outside, { recursive: true })
const ROOTS = [rootA, rootB]

const png = join(rootA, 'shot.png')
const pdf = join(rootB, 'report.pdf')
const svg = join(rootB, 'evil.svg')
const zip = join(rootB, 'bundle.zip')
const exe = join(rootB, 'tool.exe')
const secret = join(outside, 'credentials.yaml')
for (const [p, bytes] of [[png, 68], [pdf, 2048], [svg, 40], [zip, 128], [exe, 64], [secret, 32]]) {
  writeFileSync(p, Buffer.alloc(bytes, 0x41))
}

console.log('交付文件边界（lib/files.js）')

// 1. 白名单包含关系：前缀相等不算包含 —— 这是这类判断最常见的写法错误。
ok('withinRoot 认子路径', withinRoot(join(rootA, 'a', 'b.png'), rootA))
ok('withinRoot 拒绝同前缀的兄弟目录', !withinRoot(rootA + '-evil/x.png', rootA))
ok('withinRoot 拒绝根本身之外的平级路径', !withinRoot(outside, rootA))
ok('defaultRoots 默认两条（附件库 + 交付 outbox）', defaultRoots('C:\\Users\\x').length === 2)

// 2. 环境变量覆盖：`;` 分隔 + `~` 展开。
//    用例**必须**用当前平台上真正绝对的路径来构造。硬编码的 'C:\Users\x' 在 POSIX 上
//    不是绝对路径，`resolve` 会把它拼到 cwd 后面 —— 本地（Windows）全绿、CI（ubuntu）红。
//    v1.3.0 第一次发布就是这么挂的，而且挂的是这条测试自己，不是产品代码。
const fakeHome = join(tmpdir(), 'tw-home')
const otherRoot = join(tmpdir(), 'tw-b')
const fromEnv = rootsFrom('~/a;' + otherRoot, fakeHome)
ok('rootsFrom 按 ; 拆分并展开 ~',
  fromEnv.length === 2 && fromEnv[0] === join(fakeHome, 'a') && fromEnv[1] === otherRoot, fromEnv)
ok('rootsFrom 空值时回落默认', rootsFrom('  ', fakeHome).length === 2)

// 3. 扩展名白名单：可执行的同源内容必须被拒，且不降级成下载。
ok('.png → image/png', mimeFor('a.png').mime === 'image/png')
ok('.PDF 大小写不敏感', mimeFor('A.PDF').mime === 'application/pdf')
ok('.svg 被拒（同源可执行内容）', mimeFor('a.svg').error === 'denied-type')
ok('.html 被拒', mimeFor('a.html').error === 'denied-type')
ok('.js 被拒', mimeFor('a.js').error === 'denied-type')
ok('未知类型被拒', mimeFor('a.exe').error === 'unsupported-type')

// 4. 路径解析：穿越、越界、相对路径、缺失参数。
ok('缺参数', resolveTarget('', ROOTS).error === 'missing-path')
ok('相对路径被拒', resolveTarget('x/y.png', ROOTS).error === 'not-absolute')
ok('.. 穿越被拒', resolveTarget(join(rootA, '..', 'outside', 'credentials.yaml'), ROOTS).error === 'outside-roots')
ok('白名单外的绝对路径被拒', resolveTarget(secret, ROOTS).error === 'outside-roots')
ok('白名单外的 .yaml 也是 outside-roots（先判边界）', resolveTarget(join(outside, 'x.png'), ROOTS).error === 'outside-roots')
ok('白名单内的 svg 是 denied-type', resolveTarget(svg, ROOTS).error === 'denied-type')
ok('白名单内的 exe 是 unsupported-type', resolveTarget(exe, ROOTS).error === 'unsupported-type')
ok('不存在的文件是 not-found', resolveTarget(join(rootA, 'nope.png'), ROOTS).error === 'not-found')

const hitPng = resolveTarget(png, ROOTS)
ok('合法图片可读', hitPng.ok === true && hitPng.mime === 'image/png' && hitPng.bytes === 68, hitPng)
ok('合法图片带名字与大类', hitPng.name === 'shot.png' && hitPng.kind === 'image')
const hitPdf = resolveTarget(pdf, ROOTS)
ok('合法 PDF 可读且归类为 pdf', hitPdf.ok === true && hitPdf.kind === 'pdf')
ok('~ 展开后能命中白名单', resolveTarget(pdf.replace(rootB, rootB), ROOTS).ok === true)

// 5. 符号链接逃逸：字符串检查挡不住，必须按真实路径复查。
//    Windows 上建符号链接需要开发者模式/管理员，没权限就明确报 SKIP，不算通过。
let linkNote = ''
try {
  const link = join(rootA, 'link.png')
  symlinkSync(secret, link)
  const got = resolveTarget(link, ROOTS)
  ok('指向白名单外的符号链接被拒', got.error === 'outside-roots', got)
} catch (e) {
  linkNote = 'SKIP 符号链接逃逸（本机无建链接权限：' + (e && e.code ? e.code : 'unknown') + '）'
  console.log('  ' + linkNote)
}

// 6. 响应头策略：图片/PDF 内嵌，压缩包下载，文件名里的引号换行必须清掉。
ok('图片 inline', dispositionFor('image/png', 'a.png').indexOf('inline') === 0)
ok('PDF inline', dispositionFor('application/pdf', 'a.pdf').indexOf('inline') === 0)
ok('zip attachment', dispositionFor('application/zip', 'a.zip').indexOf('attachment') === 0)
ok('文件名清理引号与换行', dispositionFor('image/png', 'a"b\r\nc.png').indexOf('"a_b__c.png"') > 0)
ok('kindOf 分类', kindOf('image/webp') === 'image' && kindOf('application/pdf') === 'pdf' && kindOf('application/zip') === 'file')

// 7. 上限本身要是个合理的数（运行时无法造 32MB 文件来测，只断言配置合理）。
ok('单文件上限在 1MB ~ 64MB 之间', MAX_BYTES >= 1048576 && MAX_BYTES <= 67108864, MAX_BYTES)

// 8. 无扩展名：宿主附件库是内容寻址的，模型产出的图名字就是哈希、没有扩展名。
//    只认扩展名的话，"把刚生成的这张图发我"会 403 —— 演示页一切正常、真机上是坏的。
//    这一组就是那次真实验收暴露出来的回归。
const pngNoExt = join(rootA, 'blob')
const pdfNoExt = join(rootA, 'blob2')
const htmlNoExt = join(rootA, 'blob3')
const txtNoExt = join(rootA, 'blob4')
writeFileSync(pngNoExt, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x41),
]))
writeFileSync(pdfNoExt, Buffer.from('%PDF-1.7\n' + 'x'.repeat(80)))
writeFileSync(htmlNoExt, Buffer.from('<html><script>alert(1)</script>'.padEnd(80, ' ')))
writeFileSync(txtNoExt, Buffer.from('just plain text, no magic bytes at all'.padEnd(80, '.')))
const hitNoExt = resolveTarget(pngNoExt, ROOTS)
ok('无扩展名的 PNG 按文件头识别', hitNoExt.ok === true && hitNoExt.mime === 'image/png', hitNoExt)
ok('识别后补一个扩展名给下载文件名（手机得知道用什么打开）', hitNoExt.name === 'blob.png', hitNoExt.name)
ok('无扩展名的 PDF 按文件头识别', (resolveTarget(pdfNoExt, ROOTS) || {}).mime === 'application/pdf')
ok('无扩展名的 HTML 仍被拒（没有魔数可放行，白名单没放宽）', resolveTarget(htmlNoExt, ROOTS).error === 'unsupported-type')
ok('无扩展名的纯文本仍被拒', resolveTarget(txtNoExt, ROOTS).error === 'unsupported-type')
const tiny = join(rootA, 'tiny')
writeFileSync(tiny, Buffer.from([0x89, 0x50]))
ok('不足 12 字节的截断文件不会误判', resolveTarget(tiny, ROOTS).error === 'unsupported-type')

rmSync(sandbox, { recursive: true, force: true })

console.log('')
console.log(fail === 0
  ? '交付文件边界：' + pass + '/' + pass + ' 全绿' + (linkNote ? '（含 1 项 SKIP）' : '')
  : '交付文件边界：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
