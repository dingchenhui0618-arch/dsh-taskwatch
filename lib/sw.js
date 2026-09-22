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
// v7：外壳从 cache-first 改成**网络优先**（见下面 fetch 里的说明）。
//
// 保留版本号是为了让老客户端在切换时丢掉旧缓存；但从这一版起，页面更新不再
// 依赖它 —— v5 到 v6 之间已经因为忘了升号踩过一次，代价是"新功能在手机上
// 怎么都不出现，而且服务端看起来一切正常"。图标仍然 cache-first。
const CACHE = 'taskwatch-v7'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // 只清自己前缀的缓存。CacheStorage 是**按源共享**的，缓存名全局唯一，
      // 无条件删除会把同源下任何其它应用的缓存一起干掉 —— 现在 DSH GUI 自己
      // 不用 service worker 所以看不出后果，但中继源或以后同端口挂别的应用时
      // 这就是真实的跨作用域误伤。
      .then((keys) => Promise.all(keys
        .filter((k) => k.indexOf('taskwatch-') === 0 && k !== CACHE)
        .map((k) => caches.delete(k))))
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

  // 对话接口一律**不碰**：只走网络，绝不缓存、绝不包一层。
  // 尤其是 /taskwatch/chat/stream —— 它是一条长连接的 SSE，被 service worker
  // 经手就会退化成"等整段读完再给"，流式效果全丢。POST 在函数开头已经被方法
  // 判断放行了，这里再显式拦一次，防的是以后有人加一条 /taskwatch 下的通配规则。
  if (u.pathname.indexOf('/taskwatch/chat/') === 0) return

  if (SHELL.indexOf(u.pathname) >= 0) {
    // 页面本身走**网络优先**：先取新的，失败（离线）才回缓存。
    //
    // 原先是 cache-first + 手工升 CACHE 版本号。那个开关很难不出错 ——
    // 2026-09-22 这一轮就踩了两次：改了 page.html 忘了升号，已安装的手机一直
    // 吃旧页面，而服务端一切正常，从外面完全查不出来。页面只是几十 KB 的本地
    // 文件，多一次往返可以忽略，换来的是"改了就生效"。
    if (u.pathname === '/taskwatch') {
      e.respondWith(
        fetch(e.request)
          .then((res) => {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {})
            return res
          })
          .catch(() => caches.match(e.request).then((hit) => hit || Response.error()))
      )
      return
    }
    // 图标很少变，仍然 cache-first，省一次往返。
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
  }
})
