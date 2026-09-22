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

// 写入口的范围。原来是 `!/method === 'POST'/` 这种"检查写法"的断言 ——
// 2026-09-22 加了 8 条对话路由（其中 4 条是写）之后它**照样通过**，
// 是一条假绿灯：它证明的是"没这么写"，不是"没有这个能力"。
// 改成正面清点：所有路由里，不属于只读白名单的必须全部落在 /taskwatch/chat/ 之下。
const READONLY_ROUTES = new Set([
  '/taskwatch',
  '/taskwatch/data',
  '/taskwatch/session',
  '/taskwatch/manifest.webmanifest',
  '/taskwatch/sw.js',
])
const declaredPaths = [...hostSrc.matchAll(/path:\s*'(\/taskwatch[^']*)'/g)].map((m) => m[1])
const chatPaths = declaredPaths.filter((p) => !READONLY_ROUTES.has(p))
check('新增路由全部落在 /taskwatch/chat/ 之下（写能力只从这一组来）',
  chatPaths.length > 0 && chatPaths.every((p) => p.startsWith('/taskwatch/chat/')),
  chatPaths.join(' ') || '(没有)')
check('对话路由共 9 条（5 读 + 4 写，增删都要是有意识的）',
  chatPaths.length === 9, `实际 ${chatPaths.length}：${chatPaths.join(' ')}`)
check('对话路由把 sessionController 当软依赖、并逐请求获取',
  /ctx\.get\('sessionController'\)/.test(hostSrc) && /chatOf\(\)/.test(hostSrc))
check('prompt 的 requestId 由宿主生成（客户端不能决定请求身份）',
  /requestId:\s*randomUUID\(\)/.test(hostSrc))
check('新建会话不接受客户端指定 cwd',
  !/request\.cwd\s*=/.test(hostSrc))
check("SSE 关掉了 nginx 缓冲（否则流式会退化成一次性）",
  hostSrc.includes("'x-accel-buffering': 'no'"))

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

const escMap = /ESC\s*=\s*\{([^}]*)\}/.exec(page)
const escaped = escMap ? escMap[1] : ''
check("page.html 的转义表覆盖 & < > \" '",
  escaped.includes("'&'") && escaped.includes("'<'") && escaped.includes("'>'")
    && escaped.includes('&quot;') && escaped.includes('&#39;'),
  escMap ? escMap[1] : '(找不到 ESC 表)')

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

// XSS 的四条主路径必须走 textContent 或 esc()。
//
// 说明白这条断言的能力边界：它是**代理**，不是证明 —— 它盯住的是已知的四个
// 入口（模型正文、工具提示、工具名、会话标题），不是"全页面无 XSS"。
// 之所以仍然值得写：这四处正是唯一会渲染外部文本的地方，改动时踩中的概率最高。
check('page.html 的气泡用 textContent 写入（模型正文不进 innerHTML）',
  /\.textContent\s*=\s*text/.test(page))
check('page.html 的工具提示用 textContent 写入',
  /a\.textContent\s*=\s*it\.hint/.test(page))
check('page.html 的工具名经 toolLabel 后用 textContent 写入',
  /nm\.textContent\s*=\s*toolLabel\(/.test(page))

// 2026-09-22 实测踩到的坑：tool/result 的顶层**没有** callId，
// 真正的 id 在 data.message.source.callId。按顶层读会一直拿到 undefined，
// 表现是每来一个工具结果就新插一张错卡。这条断言把它钉住。
check('page.html 从 data.message.source.callId 取工具结果 id',
  /message\.source\.callId/.test(page) && /resultCallId\(d\)/.test(page))

// 会话标题靠 session/title 帧补全（冷会话也有），否则顶部只会显示目录名。
check('page.html 处理 session/title 帧',
  /'session\/title'/.test(page) && /setTitle\(/.test(page))

// 就地更新要按序号定位，别靠"最后一张卡"猜。
check('page.html 按 data-i 序号就地替换节点',
  /data-i/.test(page) && /querySelector\('\[data-i="/.test(page))

// service worker 的离线兜底用的是 offline:true + errors[]（形状在 lib/sw.js 里）。
// 不认它，断网时会显示成"一切正常，没有任务在跑" —— 对监控来说，
// 把"读不到"说成"没事"是最坏的一种错。
check('page.html 认 service worker 的离线快照形状',
  /d\.offline/.test(page) && /d\.errors/.test(page))

// 对话接口绝不能被 service worker 经手：/taskwatch/chat/stream 是长连接 SSE，
// 一旦被包一层就退化成"等整段读完再给"，流式全丢。
const sw = readFileSync(join(ROOT, 'lib', 'sw.js'), 'utf8')
check('sw.js 显式放过对话接口',
  /indexOf\('\/taskwatch\/chat\/'\)/.test(sw))

// 外壳必须网络优先。cache-first + 手工升 CACHE 版本号已经害过两次：
// 改了 page.html 忘了升号，已安装的手机一直吃旧页面，而服务端看不出任何异常。
check('sw.js 的外壳走网络优先（改了页面手机才会更新）',
  /fetch\(e\.request\)/.test(sw) && /\.catch\(\(\)\s*=>\s*caches\.match\(e\.request\)/.test(sw))
check('page.html 把会话标题经 esc() 再拼进 HTML',
  /esc\(title\)/.test(page))
const escUses = (page.match(/esc\(/g) || []).length
check('page.html 的 esc() 用在足够多的入口上（≥ 12 处）',
  escUses >= 12, `实际 ${escUses} 处`)

check('page.html 在页面隐藏时停止轮询',
  page.includes('visibilitychange') && page.includes('document.hidden'))

// 与宿主的 304 是配套的：用 no-store 的话浏览器根本不保存响应，
// 也就永远不会带 If-None-Match 回来，宿主那边的 304 就成了死代码。
check("page.html 用 cache:'no-cache' 取状态（304 才可能生效）",
  /cache:\s*'no-cache'/.test(page))

// 对话页与宿主路由必须对齐：页面调的每个接口都要真的注册过。
// 这条能抓住"改了路由名忘了改页面"这种单侧改动 —— 它在浏览器里只会表现为
// 一个静默失败的按钮，很难查。
const pageChatPaths = [...new Set([...page.matchAll(/\/taskwatch\/chat\/([a-z]+)/g)]
  .map((m) => '/taskwatch/chat/' + m[1]))]
const hostChatPathSet = new Set(chatPaths)
const missingChat = pageChatPaths.filter((p) => !hostChatPathSet.has(p))
check('页面调用的每个对话接口都在宿主注册过',
  pageChatPaths.length >= 6 && missingChat.length === 0,
  missingChat.length ? '缺: ' + missingChat.join(' ') : pageChatPaths.join(' '))

// 流式靠 SSE；切会话后旧连接必须被丢弃，否则两条流会把内容串在一起。
check('page.html 用 EventSource 跟随会话',
  /new EventSource\(/.test(page))
check('page.html 用序号丢弃切会话后的旧流',
  /mine\s*!==\s*SEQ/.test(page))

// 逐字输出只改一个节点：整页重建会让长会话每来一个字都重排。
check('page.html 的逐字输出只改单个节点',
  /streaming\.bub\.textContent\s*=/.test(page))
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
