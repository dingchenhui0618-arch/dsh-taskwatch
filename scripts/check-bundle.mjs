#!/usr/bin/env node
/**
 * 客户端 bundle 的契约测试。
 *
 * 浏览器加载这个文件的方式是：当作普通脚本执行 → 它调用
 * window.__ModuleLoader__.load({id, factory}) → 浏览器按 id 索引 factory，
 * 在需要时调用 factory(require) 拿到插件导出。
 *
 * 所以这里就照那条路径真的跑一遍，而不是只做语法检查：
 *   1. 作为**脚本**（非模块）能否解析
 *   2. 是否恰好注册一次，且 id 与 package.json 的 name 完全一致
 *   3. factory(require) 返回的对象是否含 name / inject / apply
 *   4. apply(fakeCtx) 是否真的往两个插槽各注册了一次
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')

let failures = 0
function check(label, condition, detail) {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`  ${mark}  ${label}${detail && !condition ? ' -> ' + detail : ''}`)
}

// --- 1. 必须是合法脚本，且不能含模块语法 ---
let run
try {
  run = new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', source)
  check('作为普通脚本可解析', true)
} catch (e) {
  check('作为普通脚本可解析', false, e.message)
  process.exit(1)
}
check('不含 import/export 语句',
  !/^\s*(import|export)\s/m.test(source))

// --- 2. 捕获注册 ---
const captured = []
const styleNodes = []
const fakeDocument = {
  createElement() {
    const node = { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v }, remove() {} }
    styleNodes.push(node)
    return node
  },
  head: { appendChild() {} },
}

run(
  { __ModuleLoader__: { load(registration) { captured.push(registration) } } },
  fakeDocument,
  async () => ({ json: async () => ({}) }),
  () => 0,
  () => {},
)

check('恰好注册一次', captured.length === 1, `实际 ${captured.length} 次`)
check("注册 id 与 package.json 的 name 一致", captured[0] && captured[0].id === pkg.name,
  `注册 id=${captured[0] && captured[0].id}，包名=${pkg.name}`)
check('提供了 factory 函数', captured[0] && typeof captured[0].factory === 'function')

// --- 3. factory 的产物 ---
const required = []
const fakeReact = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
}
const fakeRequire = (spec) => {
  required.push(spec)
  if (spec === 'react') return fakeReact
  throw new Error('未在种子表内: ' + spec)
}

let plugin
try {
  plugin = captured[0].factory(fakeRequire)
} catch (e) {
  check('factory(require) 可执行', false, e.message)
  process.exit(1)
}
check('factory(require) 可执行', true)
check('只向 require 索取种子表内的模块',
  required.every((s) => s === 'react'), required.join(', '))
check('导出 name', plugin && plugin.name === pkg.name, String(plugin && plugin.name))
check('导出 apply 函数', plugin && typeof plugin.apply === 'function')
check('导出 inject 数组且含 slots',
  plugin && Array.isArray(plugin.inject) && plugin.inject.includes('slots'),
  JSON.stringify(plugin && plugin.inject))

// --- 4. apply 真的注册到插槽 ---
const injected = []
const registrations = []
const fakeCtx = {
  effect(fn) { return fn() },
  slots: {
    inject(name, factory) { injected.push(name); registrations.push(factory()) },
    register(spec) { return spec },
  },
}
let applyError = null
try {
  plugin.apply(fakeCtx)
} catch (e) {
  applyError = e
}
check('apply(ctx) 不抛异常', applyError === null, applyError && applyError.message)
check('注入 sidebar.panellist', injected.includes('sidebar.panellist'), injected.join(', '))
check('注入 main', injected.includes('main'), injected.join(', '))
check('插入了一个 <style> 节点', styleNodes.length === 1, `实际 ${styleNodes.length} 个`)
check('style 节点带 data-dsh-taskwatch 标记',
  styleNodes[0] && styleNodes[0].attrs['data-dsh-taskwatch'] !== undefined)

// --- 5. Host 半边的契约 ---
//
// 这一节是 2026-09-21 那次真实故障的回归防护。v1.0.0 漏了 inject，导致
// ctx.get('webServer') 在组合期拿到 undefined，全部路由被静默跳过
// （/taskwatch 一律 404）。客户端那半边当时检查得很细，宿主这半边却没人管，
// 所以补上：宿主插件缺 name / inject / apply 中任何一个都必须构建失败。
// Windows 上动态 import 绝对路径必须走 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const host = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)

check('宿主导出 name 且与包名一致', host.name === pkg.name, String(host.name))
check('宿主导出 apply 函数', typeof host.apply === 'function')
check("宿主 inject 是数组且含 'webServer'",
  Array.isArray(host.inject) && host.inject.includes('webServer'),
  JSON.stringify(host.inject))

// 路由注册全靠 webServer；少了它整页 404 而不报错，正是最难查的失败姿态。
check('宿主 apply 声明了 1 个形参（ctx）', host.apply.length === 1, String(host.apply.length))

const hostSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
check("宿主注册了 '/taskwatch' 路由", hostSrc.includes("'/taskwatch'"))
check('宿主不提供任何写操作（只读承诺）',
  !/req\.method\s*===\s*'POST'/.test(hostSrc) && !/method\s*===\s*'POST'/.test(hostSrc))

// 轮询路径的开销与缓存协商。snapshot() 一次要问一圈服务（每个 agent 的 jobs、
// 每个会话的 eventAt/title/goal、每个 agent 的 listDescendants），而手机页面
// 每 3 秒轮询一次，桌面面板和多个标签页还会各来一份。这两条断言把「不能退化成
// 每请求全量采集」和「不能退化成每次都重传整份 JSON」钉住。
check('宿主对快照做 TTL 缓存并合并并发请求',
  /SNAPSHOT_TTL_MS/.test(hostSrc) && /inflight/.test(hostSrc))
check('宿主用 If-None-Match 协商 304',
  hostSrc.includes('if-none-match') && /send\(res,\s*304/.test(hostSrc))

// --- 6. 打包元数据 ---
const patch = readFileSync(join(ROOT, pkg.dsh.bundle.patch), 'utf8')
check('cordis.patch.yml 用包名引用插件', patch.includes(pkg.name), patch.trim())
check('exports["./client"] 指向构建产物',
  pkg.exports && pkg.exports['./client'] === './lib/client.js',
  JSON.stringify(pkg.exports && pkg.exports['./client']))
check("dsh.client.platform 为 web",
  pkg.dsh.client && pkg.dsh.client.platform === 'web')
check('files 含 lib 与 cordis.patch.yml',
  pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'))

// --- 7. 手机页面（lib/page.html）---
//
// 这一节盯两件在真实使用里会出事、但肉眼看不出来的事：
//   1) XSS —— 页面把会话标题、任务 label 等用户可控文本拼进 innerHTML。
//      它是 npm 上公开的插件，别人的标题里出现 <img onerror> 就会执行。
//   2) 手机上的耗电 —— 页面常驻后台标签页时不该继续每 3 秒发请求。
const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')

const escMap = /ES=\{([^}]*)\}/.exec(page)
const escaped = escMap ? escMap[1] : ''
check("page.html 的转义表覆盖 & < > \" '",
  escaped.includes("'&'") && escaped.includes("'<'") && escaped.includes("'>'")
    && escaped.includes('&quot;') && escaped.includes('&#39;'),
  escMap ? escMap[1] : '(找不到 ES 表)')

// 页面里的内联脚本必须能编译。
//
// 它既不是模块、也没有任何构建步骤会碰它，所以一个手误（比如编辑时把某个函数的
// 声明行连同别的改动一起替换掉）不会让 CI 变红，只会在浏览器里变成一片空白。
// 这条断言就是为那种时刻准备的 —— 写它之前刚发生过一次。
const pageScript = /<script>([\s\S]*?)<\/script>/.exec(page)
let pageSyntaxError = null
if (!pageScript) pageSyntaxError = '找不到内联 <script> 块'
else { try { new Function(pageScript[1]) } catch (e) { pageSyntaxError = e.message } }
check('page.html 的内联脚本可编译', pageSyntaxError === null, pageSyntaxError || '')

const innerHtmlWrites = (page.match(/innerHTML\s*=/g) || []).length
check('page.html 只在渲染入口写一次 innerHTML',
  innerHtmlWrites === 1, `实际 ${innerHtmlWrites} 处`)

check('page.html 在页面隐藏时停止轮询',
  page.includes('visibilitychange') && page.includes('document.hidden'))

// 与宿主的 304 是配套的：用 no-store 的话浏览器根本不保存响应，
// 也就永远不会带 If-None-Match 回来，宿主那边的 304 就成了死代码。
check("page.html 用 cache:'no-cache' 取数（304 才可能生效）",
  page.includes("{cache:'no-cache'}"))

// 签名必须对 generatedAt 免疫，否则「数据没变就不碰 DOM」是空话。
// 宿主算 ETag 时做了同一件事，两处必须一致。
check('page.html 的签名排除 generatedAt',
  /k==='generatedAt'\?0/.test(page))
// 真测行为，而不是查字符串在不在。
//
// 之前这条是 `hostSrc.includes('"generatedAt":0')` 之类 —— 那种断言在 ETag 明明
// 永不命中（因为 generatedAt 每次都变）时依然显示「通过」，等于给自己发绿灯。
const etagBase = { generatedAt: 1, totals: { sessions: 2 }, sessions: [{ id: 'a' }] }
const etagOther = { generatedAt: 1, totals: { sessions: 3 }, sessions: [{ id: 'a' }] }
const etagNewer = { generatedAt: 999999, totals: { sessions: 2 }, sessions: [{ id: 'a' }] }

check('ETag 对内容敏感',
  host.etagOf(etagBase) !== host.etagOf(etagOther))
check('ETag 对 generatedAt 免疫（否则 304 永不命中）',
  host.etagOf(etagBase) === host.etagOf(etagNewer))
check('ETag 是带引号的合法值',
  /^"[0-9a-f]{20}"$/.test(host.etagOf(etagBase)), host.etagOf(etagBase))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
