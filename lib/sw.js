// taskwatch 的 service worker。
//
// 与 lib/page.html 一样只留一个来源：插件从磁盘读它对外提供，部署侧的中继也读
// 同一个文件，所以不会像内联副本那样慢慢漂移。
//
// 离线策略有意做得保守：外壳可离线打开，但状态数据永远走网络。对监控而言，
// 看到过期状态比看到断连更危险，所以断网时返回一份**显式的** offline 快照，
// 让人一眼看出「这是没读到，不是真的没任务」。
//
// ⚠️ CACHE 版本号同时是页面更新的开关。SHELL 里的 /taskwatch 是 cache-first，
// 改了 lib/page.html 却不升这个号，已安装的客户端会一直吃旧页面。只升号还不够：
// activate 里必须删掉非当前版本的缓存 —— caches.match() 不指定 cache 时会搜索
// **全部**缓存，残留的旧缓存照样会被命中。
const SHELL = ['/taskwatch', '/taskwatch/icon-192.png', '/taskwatch/icon-512.png']
const CACHE = 'taskwatch-v4'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k)))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url)
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return

  // 单会话对话：只走网络，永不缓存。断网时要回**会话形状**的错，而不是 data 形状的
  // 空快照 —— 两者的字段不一样，回错了前端读不到 error，只会显示成「没有消息」。
  if (u.pathname === '/taskwatch/session') {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({
      id: '', live: false, total: 0, messages: [],
      error: '离线：读不到 DSH，无法读取会话',
    }), { headers: JSON_HEADERS })))
    return
  }

  // 状态快照：同样只走网络，断网回一份显式的离线空快照。
  if (u.pathname === '/taskwatch/data') {
    e.respondWith(fetch(e.request).catch(() => new Response(JSON.stringify({
      generatedAt: Date.now(),
      offline: true,
      errors: ['离线：读不到 DSH，数据未刷新'],
      totals: { sessions: 0, running: 0, jobs: 0, jobsRunning: 0, subagents: 0, workflows: 0, pending: 0 },
      sessions: [], jobs: [], subagents: [], pending: [], workflows: [],
    }), { headers: JSON_HEADERS })))
    return
  }

  if (SHELL.indexOf(u.pathname) >= 0) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
  }
})
