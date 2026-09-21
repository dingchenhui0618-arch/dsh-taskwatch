/**
 * dsh-taskwatch —— Host 半边
 *
 * 采集 DSH 运行时状态并以两个固定路径暴露：
 *   GET /taskwatch        只读移动页（自带轮询）
 *   GET /taskwatch/data   同一份数据的 JSON
 *
 * 采集面：会话（运行/空闲、最后活动、activeJobs）、后台任务 jobs、
 * 子代理树、目标轮次与阻塞、工作流阶段、等待审批/提问。
 *
 * 只读：不提供任何写操作、不接受请求体、不代理 DSH 自身的 /api。
 *
 * 静态资源（PWA）都挂在 /taskwatch/ 之下，service worker 的作用域也限定为
 * /taskwatch —— 绝不允许它有机会拦截主 GUI 的请求。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const ICONS = new Map([
  ['/taskwatch/icon-192.png', { file: join(HERE, 'icons', 'icon-192.png'), type: 'image/png' }],
  ['/taskwatch/icon-512.png', { file: join(HERE, 'icons', 'icon-512.png'), type: 'image/png' }],
])

const MANIFEST = JSON.stringify({
  name: 'DSH 任务监控',
  short_name: '任务监控',
  description: 'DSH 运行时状态：会话、后台任务、子代理、目标轮次、工作流、待介入项',
  start_url: '/taskwatch',
  scope: '/taskwatch',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [
    { src: '/taskwatch/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/taskwatch/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/taskwatch/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
})

/** service worker 与页面外壳一样放在独立文件里，理由相同：内联副本必然漂移。
 *
 * 这里曾经内联过一份，版本停在 taskwatch-v1，而部署侧中继里那份已经升到 v3 并
 * 补上了「删除旧缓存」——同一个插件对外提供了两个行为不同的 SW，取决于请求先命中
 * 谁。所以收敛成一个来源。
 */
function readSw() {
  try {
    return readFileSync(join(HERE, 'sw.js'), 'utf8')
  } catch (e) {
    console.error('dsh-taskwatch: 读不到 lib/sw.js —— ' + String((e && e.message) || e))
    return '/* lib/sw.js 缺失，本插件不提供离线外壳 */\n'
  }
}
const SERVICE_WORKER = readSw()

/** 页面外壳放在独立的 lib/page.html。
 *
 * 为什么不内联在代码里：公开访问的页面由中继直接提供同一个文件（常驻插件挂载
 * 之前也一样可用）。两份内联副本必然漂移，所以只留一个来源，改一处两边同时生效。
 *
 * 读不到时降级成一句提示而不是抛异常：一个缺失的静态文件不该让插件加载失败，
 * 那会连带把整个 DSH 的启动拖垮。
 */
function readPage() {
  try {
    return readFileSync(join(HERE, 'page.html'), 'utf8')
  } catch (e) {
    console.error('dsh-taskwatch: 读不到 lib/page.html —— ' + String((e && e.message) || e))
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>任务监控</title></head><body style="font:15px/1.6 system-ui;padding:24px">'
      + '<h1 style="font-size:17px">页面外壳读不到</h1>'
      + '<p>lib/page.html 缺失或不可读。数据接口仍可用：<code>/taskwatch/data</code></p>'
      + '</body></html>'
  }
}
const PAGE = readPage()

/**
 * 从 ContentBlock[] 抽出可读文本。
 *
 * 只取叶子字段，绝不把消息对象或会话日志整个带走 —— 那些是活的内部对象，
 * 序列化它们既不可靠也不安全。这里产出的是新造的纯字符串。
 */
function blocksText(blocks) {
  let out = ''
  if (!Array.isArray(blocks)) return out
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && typeof b.text === 'string') out += (out ? '\n' : '') + b.text
  }
  return out
}

/** 从 ContentBlock[] 抽出工具调用名，供一行概览用。 */
function blocksTools(blocks) {
  const names = []
  if (!Array.isArray(blocks)) return names
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool-call' && typeof b.name === 'string' && names.indexOf(b.name) < 0) names.push(b.name)
  }
  return names
}

// 快照的 ETag 算法单独抽成纯函数，就是为了能被直接测。
//
// 关键在于**对 generatedAt 免疫**：它是每次采集都不同的 Date.now()，直接拿整份
// JSON 做哈希的话内容哈希永远在变，304 会退化成永不命中的死代码。所以先把这个
// 字段丢掉再哈希 —— 其余字段（任务状态、标题、计数）才是「内容到底变没变」的
// 真正依据。check-bundle 里有一条单测专门钉住这条性质。
export function etagOf(payload) {
  const stable = JSON.stringify(payload, (key, value) => (key === 'generatedAt' ? undefined : value))
  return '"' + createHash('sha1').update(stable).digest('hex').slice(0, 20) + '"'
}

export const name = 'dsh-taskwatch'

// webServer 是**硬依赖**，必须写进 inject，不能只靠 ctx.get() 软读。
//
// 教训（2026-09-21，v1.0.0 的实际故障）：webserver 那一行的服务是在启动阶段
// 之后才发布的，而 apply 会在组合期就被调用。此时 ctx.get('webServer') 拿到
// undefined，于是整段路由注册被静默跳过 —— 现象是 /taskwatch 一律 404，
// 但插件「装好了、也没报错」，极难排查。声明 inject 后 Cordis 会等该服务
// 就绪再调用 apply，从根上消除这个竞态。
//
// 其余服务（jobs / agents / sessions / goals / subagents / sessionTitle）
// 刻意保持软读 ctx.get()：只读监控缺哪块就少显示哪块，不该因为某个服务没装
// 就整页不可用。
export const inject = ['webServer']

const asText = (v) => (typeof v === 'string' ? v : '')
const asNum = (v) => (typeof v === 'number' && isFinite(v) ? v : 0)
const why = (e) => (e && e.message ? String(e.message) : String(e))

const ENV_ASSIGN = /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=/i

/** 后台任务的 label 常是多行 shell 命令（含纯环境变量赋值行），折成一行可读文本。 */
function cleanLabel(raw) {
  const all = asText(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!all.length) return ''
  const kept = all.filter((line) => !ENV_ASSIGN.test(line))
  const chosen = kept.length ? kept : all
  const joined = chosen.join(' ; ').replace(/\s+/g, ' ').trim()
  return joined.length > 140 ? joined.slice(0, 137) + '\u2026' : joined
}

const isActiveJob = (status) => status === 'running' || status === 'stopping'

function safe(fn, fallback, errors, label) {
  try {
    return fn()
  } catch (e) {
    if (errors && label) errors.push(label + ': ' + why(e))
    return fallback
  }
}

export function apply(ctx) {
  const jobsSvc = ctx.get('jobs')
  const agentsSvc = ctx.get('agents')
  const sessionsSvc = ctx.get('sessions')
  const goalsSvc = ctx.get('goals')
  const subagentsSvc = ctx.get('subagents')
  const titlesSvc = ctx.get('sessionTitle')
  const webServer = ctx.get('webServer')

  // 只保留标量，绝不持有 live 的 Service / Agent / Session 对象。
  const approvals = new Map()
  const questions = new Map()
  const runningById = new Map()
  const runs = new Map()

  ctx.on('agent/status', (payload) => {
    try {
      const id = payload && payload.agent ? String(payload.agent.id) : ''
      if (id) runningById.set(id, payload.status === 'running')
    } catch { /* 观测失败不能影响主链路 */ }
  })

  ctx.on('api-session/status', (sessionId, isRunning) => {
    try {
      if (typeof sessionId === 'string') runningById.set(sessionId, isRunning === true)
    } catch { /* 同上 */ }
  })

  // approval/request 是 waterfall：必须把 next() 的结论原样返回，
  // 任何自身异常都要吞掉，否则会阻断正常审批链。
  ctx.on('approval/request', async (req, next) => {
    let key = ''
    try {
      const callId = req && req.callId ? String(req.callId) : ''
      key = 'approval:' + (callId || Math.random().toString(36).slice(2))
      approvals.set(key, {
        kind: 'approval',
        session: req && req.agent ? String(req.agent.id) : '',
        title: asText(req && req.toolName) || '(tool)',
        detail: asText(req && req.reason),
        at: Date.now(),
      })
    } catch { /* 记录失败就当作没记录 */ }
    try {
      return await next()
    } finally {
      if (key) approvals.delete(key)
    }
  })

  ctx.on('user-questions/request', async (request, next) => {
    let key = ''
    try {
      const items = request && Array.isArray(request.questions) ? request.questions : []
      const first = items[0] || {}
      key = 'question:' + (asText(first.id) || Math.random().toString(36).slice(2))
      questions.set(key, {
        kind: 'question',
        session: request && request.agent ? String(request.agent.id) : '',
        title: asText(first.header) || asText(first.question) || '(question)',
        detail: asText(first.question),
        at: Date.now(),
      })
    } catch { /* 同上 */ }
    try {
      return await next()
    } finally {
      if (key) questions.delete(key)
    }
  })

  ctx.on('workflow/start', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const meta = info.meta || {}
      runs.set(id, {
        id,
        name: asText(meta.name),
        description: asText(meta.description),
        phase: '',
        logs: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/phase', (info, title) => {
    try {
      const id = info ? String(info.id) : ''
      if (!id) return
      const known = runs.get(id)
      const meta = (info && info.meta) || {}
      runs.set(id, {
        id,
        name: known ? known.name : asText(meta.name),
        description: known ? known.description : asText(meta.description),
        phase: asText(title),
        logs: known ? known.logs : 0,
        startedAt: known ? known.startedAt : Date.now(),
        updatedAt: Date.now(),
      })
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/log', (info) => {
    try {
      const id = info ? String(info.id) : ''
      const known = id ? runs.get(id) : undefined
      if (known) {
        known.logs = asNum(known.logs) + 1
        known.updatedAt = Date.now()
      }
    } catch { /* 同上 */ }
  })

  ctx.on('workflow/end', (info) => {
    try {
      const id = info ? String(info.id) : ''
      if (id) runs.delete(id)
    } catch { /* 同上 */ }
  })

  async function snapshot() {
    const now = Date.now()
    const errors = []
    const out = {
      generatedAt: now,
      totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
      sessions: [],
      jobs: [],
      subagents: [],
      pending: [],
      workflows: [],
      errors,
    }

    let agents = []
    if (agentsSvc) {
      const listed = safe(() => agentsSvc.list(), null, errors, 'agents.list')
      if (Array.isArray(listed)) agents = listed
    }

    // jobs.list 按属主围栏：不带 caller 只返回无主任务，
    // 所以必须逐个 agent 追问，才能看到各会话自己的后台任务。
    const activeByOwner = new Map()
    if (jobsSvc) {
      const seen = new Set()
      const addJob = (s) => {
        try {
          const id = String(s.id)
          if (seen.has(id)) return
          seen.add(id)
          if (out.jobs.length >= 120) return
          const status = asText(s.status)
          const owner = s.ownerSession ? String(s.ownerSession) : ''
          if (owner && isActiveJob(status)) activeByOwner.set(owner, (activeByOwner.get(owner) || 0) + 1)
          out.jobs.push({
            id,
            kind: asText(s.kind),
            label: cleanLabel(s.label),
            status,
            owner,
            detail: asText(s.detail),
            startedAt: asNum(s.startedAt),
            finishedAt: asNum(s.finishedAt),
          })
        } catch { /* 单条坏数据不该毁掉整次采集 */ }
      }
      const unowned = safe(() => jobsSvc.list(), null, errors, 'jobs.list')
      if (Array.isArray(unowned)) unowned.forEach(addJob)
      for (const a of agents) {
        const owned = safe(() => jobsSvc.list(a), null, null, '')
        if (Array.isArray(owned)) owned.forEach(addJob)
      }
      out.jobs.sort((x, y) => {
        const rx = isActiveJob(x.status) ? 0 : 1
        const ry = isActiveJob(y.status) ? 0 : 1
        return rx - ry || y.startedAt - x.startedAt
      })
    }

    let live = []
    if (sessionsSvc) {
      const listed = safe(() => sessionsSvc.list(), null, errors, 'sessions.list')
      if (Array.isArray(listed)) live = listed
    }

    for (const session of live) {
      try {
        const id = String(session.id)
        const header = session.header || {}
        // 最后活动时间取自日志末条事件的 time；seq 是排他上界。
        let lastActivity = asNum(header.createdAt)
        const seq = asNum(session.seq)
        if (seq > 0) {
          const ev = safe(() => session.eventAt(seq - 1), null, null, '')
          if (ev && typeof ev.time === 'number') lastActivity = ev.time
        }
        let title = ''
        if (titlesSvc) {
          const t = safe(() => titlesSvc.get(session), null, null, '')
          if (t) title = asText(t.title)
        }
        const owner = agents.find((a) => String(a.id) === id)
        let goal = null
        if (goalsSvc && owner) {
          const g = safe(() => goalsSvc.get(owner), null, null, '')
          if (g) {
            goal = {
              phase: asText(g.phase),
              activation: asText(g.activation),
              roundsStarted: asNum(g.roundsStarted),
              maxGoalRounds: asNum(g.maxGoalRounds),
              objective: asText(g.objective).slice(0, 200),
              blockedCode: g.blockedReason ? asText(g.blockedReason.code) : '',
              blockedMessage: g.blockedReason ? asText(g.blockedReason.message).slice(0, 400) : '',
            }
          }
        }
        out.sessions.push({
          id,
          title,
          running: runningById.get(id) === true,
          activeJobs: activeByOwner.get(id) || 0,
          origin: asText(header.origin),
          parent: header.parentSession ? String(header.parentSession) : '',
          depth: asNum(header.delegationDepth),
          preset: asText(header.agentPreset),
          createdAt: asNum(header.createdAt),
          lastActivity,
          live: Boolean(owner),
          goal,
        })
      } catch { /* 同上 */ }
    }
    out.sessions.sort((a, b) => b.lastActivity - a.lastActivity)

    if (subagentsSvc) {
      for (const a of agents) {
        let rootId = ''
        try { rootId = String(a.id) } catch { rootId = '' }
        if (!rootId) continue
        let list = null
        try {
          list = await subagentsSvc.listDescendants(rootId)
        } catch {
          list = null // 投影未挂载时会抛；这是可接受的缺失，不算采集错误
        }
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          try {
            if (entry.kind !== 'child') continue
            out.subagents.push({
              id: String(entry.id),
              parent: entry.parentId ? String(entry.parentId) : '',
              depth: asNum(entry.depth),
              activity: asText(entry.activity),
              mode: asText(entry.mode),
              label: asText(entry.label),
            })
          } catch { /* 同上 */ }
        }
        if (out.subagents.length > 250) break
      }
      // 每个 root 的 listDescendants 已经返回整棵树，跨 root 会重复。
      const seenSub = new Set()
      out.subagents = out.subagents.filter((x) => {
        if (seenSub.has(x.id)) return false
        seenSub.add(x.id)
        return true
      })
    }

    out.pending = Array.from(approvals.values()).concat(Array.from(questions.values()))
    out.pending.sort((a, b) => a.at - b.at)
    out.workflows = Array.from(runs.values())

    out.totals.sessions = out.sessions.length
    out.totals.running = out.sessions.filter((x) => x.running).length
    out.totals.jobs = out.jobs.length
    out.totals.jobsRunning = out.jobs.filter((x) => isActiveJob(x.status)).length
    out.totals.subagents = out.subagents.length
    out.totals.workflows = out.workflows.length
    out.totals.pending = out.pending.length
    return out
  }

  // snapshot() 一次要问一圈服务：jobs.list(每个 agent 一次) + sessions.list
  // + 每个会话的 eventAt/title/goal + 每个 agent 的 listDescendants。手机页面
  // 每 3 秒轮询，桌面面板和多个标签页还会各来一份，叠加起来相当可观。
  //
  // 所以在这里收口：TTL 内共享同一份采集结果，并发请求共用同一个 Promise
  // （不是各算各的），并给出 ETag —— 内容没变就让客户端走 304 只收一个头。
  const SNAPSHOT_TTL_MS = 2000
  let cached = null
  let inflight = null

  async function snapshotCached() {
    const now = Date.now()
    if (cached !== null && now - cached.at < SNAPSHOT_TTL_MS) return cached
    if (inflight !== null) return inflight
    inflight = (async () => {
      const payload = await snapshot()
      const json = JSON.stringify(payload)
      // 回给客户端的内容仍然带 generatedAt（页面要用它算时长），
      // 但 ETag 不能受它影响 —— 见 etagOf 的注释。
      cached = { at: Date.now(), json, etag: etagOf(payload) }
      return cached
    })()
    try {
      return await inflight
    } finally {
      inflight = null
    }
  }

  function send(res, status, type, body, extra) {
    try {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
        ...(extra || {}),
      })
      res.end(body)
    } catch {
      try { res.end('') } catch { /* 响应已断开 */ }
    }
  }

  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/data',
      handler: async (req, res) => {
        let entry
        try {
          entry = await snapshotCached()
        } catch (e) {
          send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ error: why(e) }))
          return
        }
        // 内容没变就回 304：手机上省下的是整份 JSON 的流量，只交换一个头。
        // 注意这里必须用 no-cache 而不是 no-store —— no-store 会让浏览器
        // 根本不保存响应，也就永远不会带 If-None-Match 回来。
        const inm = req.headers ? req.headers['if-none-match'] : undefined
        if (typeof inm === 'string' && inm === entry.etag) {
          send(res, 304, 'application/json; charset=utf-8', '', {
            etag: entry.etag,
            'cache-control': 'no-cache',
          })
          return
        }
        send(res, 200, 'application/json; charset=utf-8', entry.json, {
          etag: entry.etag,
          'cache-control': 'no-cache',
        })
      },
    }), 'taskwatch: data route')

    // 某个会话的最近对话（只读）。
    //
    // 为什么可能读不到：ctx.sessions 是内存存储，get(id) 只对活着的会话有效。
    // 已落盘但未加载进内存的会话这里拿不到 —— 这种情况显式报错，绝不假装"没有消息"，
    // 否则会让人以为那个会话真的没说话，而它只是没被加载。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/session',
      handler: async (req, res) => {
        const out = { id: '', live: false, total: 0, messages: [], error: null }
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const id = url.searchParams.get('id') || ''
          const raw = Number(url.searchParams.get('limit'))
          const limit = Math.min(60, Math.max(1, isFinite(raw) && raw > 0 ? Math.floor(raw) : 20))
          out.id = id
          if (!id) {
            out.error = '缺少 id 参数'
          } else {
            const store = ctx.get('sessions')
            const session = store !== undefined ? store.get(id) : undefined
            if (session === undefined) {
              out.error = '这个会话不在内存里（已落盘但未加载的会话读不到）'
            } else {
              out.live = true
              // deriveMessages() 产出的 Message 不带时间，时间从原始事件按 message id 建索引。
              const at = new Map()
              for (const ev of session.snapshotEvents()) {
                const d = ev && ev.data
                if (!d) continue
                if (ev.type === 'user/message' && d.id) at.set(String(d.id), ev.time)
                else if (ev.type === 'assistant/message' && d.message && d.message.id) at.set(String(d.message.id), ev.time)
              }
              const picked = []
              for (const m of session.deriveMessages()) {
                if (!m || m.role === 'system') continue
                const text = blocksText(m.content)
                const tools = blocksTools(m.content)
                if (!text && !tools.length) continue
                picked.push({
                  role: m.role === 'user' ? 'user' : 'assistant',
                  text: text.length > 4000 ? text.slice(0, 4000) + '\n…（已截断）' : text,
                  tools,
                  at: at.get(String(m.id)) || 0,
                })
              }
              out.total = picked.length
              out.messages = picked.slice(-limit)
            }
          }
        } catch (e) {
          out.error = why(e)
        }
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify(out))
      },
    }), 'taskwatch: session route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch',
      handler: (req, res) => send(res, 200, 'text/html; charset=utf-8', PAGE),
    }), 'taskwatch: page route')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/manifest.webmanifest',
      handler: (req, res) => send(res, 200, 'application/manifest+json; charset=utf-8', MANIFEST),
    }), 'taskwatch: manifest route')

    // 脚本位于 /taskwatch/sw.js，故 scope '/taskwatch' 无需 Service-Worker-Allowed 头即可生效。
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/taskwatch/sw.js',
      handler: (req, res) => send(res, 200, 'text/javascript; charset=utf-8', SERVICE_WORKER, {
        'service-worker-allowed': '/taskwatch',
      }),
    }), 'taskwatch: service worker route')

    for (const [path, asset] of ICONS) {
      let body
      try {
        body = readFileSync(asset.file)
      } catch (e) {
        console.error('dsh-taskwatch: 读不到图标 ' + asset.file + ' —— ' + why(e))
        continue
      }
      const content = body
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path,
        handler: (req, res) => send(res, 200, asset.type, content, {
          'cache-control': 'public, max-age=86400',
        }),
      }), 'taskwatch: icon route ' + path)
    }
  } else {
    console.error('dsh-taskwatch: 没有 webServer 服务，HTTP 路由与页面均未注册')
  }
}
