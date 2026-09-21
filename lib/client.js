/* dsh-taskwatch client bundle —— 手写，无打包器
 *
 * 加载协议：执行时调用 window.__ModuleLoader__.load({ id, factory })，
 * id 必须精确等于 package.json 的 name。factory 是懒 CJS 形态：
 * 只能用 module.exports，React 必须 React.createElement。
 *
 * 数据来自同源的 GET /taskwatch/data —— 不需要任何 host RPC。
 */
window.__ModuleLoader__.load({
  id: 'dsh-taskwatch',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var CSS = [
      '.tw-wrap{display:flex;flex-direction:column;gap:12px;padding:16px 16px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.tw-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.tw-h{font-size:15px;font-weight:600;margin:0}',
      '.tw-meta{color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums}',
      '.tw-chips{display:flex;gap:7px;flex-wrap:wrap}',
      '.tw-chip{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.tw-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:11px;padding:11px 13px}',
      '.tw-card.warn{border-color:var(--dsw-alias-state-warn-primary)}',
      '.tw-card.err{border-color:var(--dsw-alias-state-error-primary)}',
      '.tw-card>h4{margin:0 0 7px;font-size:12.5px;font-weight:600;display:flex;justify-content:space-between;align-items:center;gap:8px}',
      '.tw-n{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}',
      '.tw-row{display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.tw-row:first-of-type{border-top:0}',
      '.tw-grow{flex:1;min-width:0}',
      '.tw-name{font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-dim{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-block{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:2px}',
      '.tw-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tw-right{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;text-align:right}',
      '.tw-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-top:5px;background:var(--dsw-alias-label-secondary)}',
      '.tw-dot.run{background:var(--dsw-alias-state-success-primary)}',
      '.tw-dot.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.tw-dot.err{background:var(--dsw-alias-state-error-primary)}',
      '.tw-empty{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.tw-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l1);overflow:hidden;margin-top:5px}',
      '.tw-bar>i{display:block;height:100%;background:var(--dsw-alias-state-success-primary)}',
      '.tw-bar>i.warn{background:var(--dsw-alias-state-warn-primary)}',
      '.tw-bar>i.err{background:var(--dsw-alias-state-error-primary)}',
    ].join('\n')

    var POLL_MS = 3000

    function ago(t, now) {
      if (!t) return '\u2014'
      var s = Math.max(0, Math.round((now - t) / 1000))
      if (s < 60) return s + 's \u524d'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm \u524d'
      var h = Math.floor(m / 60)
      if (h < 24) return h + 'h \u524d'
      return Math.floor(h / 24) + 'd \u524d'
    }

    function dur(a, b, now) {
      if (!a) return '\u2014'
      var s = Math.max(0, Math.round(((b || now) - a) / 1000))
      if (s < 60) return s + 's'
      var m = Math.floor(s / 60)
      if (m < 60) return m + 'm' + (s % 60) + 's'
      var h = Math.floor(m / 60)
      return h + 'h' + (m % 60) + 'm'
    }

    function dotClass(status) {
      if (status === 'running') return 'tw-dot run'
      if (status === 'stopping') return 'tw-dot warn'
      if (status === 'failed' || status === 'killed') return 'tw-dot err'
      return 'tw-dot'
    }

    function useSnapshot() {
      var pair = React.useState(null)
      var snap = pair[0]
      var setSnap = pair[1]
      var epair = React.useState(null)
      var err = epair[0]
      var setErr = epair[1]
      React.useEffect(function () {
        var alive = true
        var timer = null
        // 响应序号：只接受最新一次请求的结果。并发轮询加上宿主 2 秒 TTL，
        // 较早发出的请求完全可能晚回来，不能让它把新快照覆盖成旧的。
        var seq = 0
        function tick() {
          // 面板挂在后台窗口时不必再打服务器。这个面板的典型用法就是
          // 「GUI 最小化、拿手机看」，此时继续每 3 秒请求纯属白耗。
          if (document.hidden) return
          var mine = ++seq
          // no-cache（不是 no-store）：让浏览器带上 If-None-Match，
          // 内容没变时宿主回 304，桌面这一半也省下整份 JSON。
          fetch('/taskwatch/data', { cache: 'no-cache' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          }).then(function (value) {
            if (!alive || mine !== seq) return
            setSnap(value)
            setErr(null)
          }, function (e) {
            if (!alive || mine !== seq) return
            setErr(e && e.message ? e.message : String(e))
          })
        }
        function start() { if (timer === null) timer = setInterval(tick, POLL_MS) }
        function stop() { if (timer !== null) { clearInterval(timer); timer = null } }
        function onVisibility() {
          if (document.hidden) stop()
          else { tick(); start() }
        }
        tick()
        if (!document.hidden) start()
        document.addEventListener('visibilitychange', onVisibility)
        return function () {
          alive = false
          stop()
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])
      return [snap, err]
    }

    function row(key, dot, body, right) {
      return React.createElement('div', { className: 'tw-row', key: key },
        React.createElement('span', { className: dot }),
        React.createElement('div', { className: 'tw-grow' }, body),
        right ? React.createElement('div', { className: 'tw-right' }, right) : null)
    }

    function lines(list) {
      return list.filter(Boolean).map(function (text, index) {
        return React.createElement('div', { className: index === 0 ? 'tw-name' : 'tw-dim', key: index }, text)
      })
    }

    function Panel() {
      var state = useSnapshot()
      var snap = state[0]
      var err = state[1]

      // 保留上一份可用快照：一次网络抖动不该把整块面板清成空白 ——
      // 监控面板的价值恰恰在于「断开时还能看到最后一帧」。
      var lastGood = React.useRef(null)
      // 宿主采集异常时回的是 200 + {error}。它是错误，不是数据：
      // 当成数据用会渲染出一块「全部为 0」的假绿板，比直接报错更危险。
      var hostError = snap && snap.error ? String(snap.error) : null
      if (snap && !hostError) lastGood.current = snap
      var shown = hostError ? lastGood.current : snap
      var stale = hostError || err

      if (!shown) {
        if (stale) {
          return React.createElement('div', { className: 'tw-wrap' },
            React.createElement('div', { className: 'tw-card err' },
              React.createElement('h4', null, '任务监控'),
              React.createElement('div', { className: 'tw-dim' }, '读取失败：' + stale)))
        }
        return React.createElement('div', { className: 'tw-wrap' },
          React.createElement('div', { className: 'tw-card' },
            React.createElement('div', { className: 'tw-empty' }, '正在读取运行时状态…')))
      }

      snap = shown
      var now = snap.generatedAt || Date.now()
      var totals = snap.totals || {}
      var sections = []

      if (stale) {
        sections.push(React.createElement('div', { className: 'tw-card warn', key: 'stale' },
          React.createElement('div', { className: 'tw-empty' },
            '数据可能已陈旧（快照时间 ' + new Date(now).toLocaleTimeString() + '）：' + stale)))
      }

      if (snap.offline) {
        sections.push(React.createElement('div', { className: 'tw-card err', key: 'offline' },
          React.createElement('div', { className: 'tw-empty' }, '\u79bb\u7ebf\uff1a\u8bfb\u4e0d\u5230 DSH\uff0c\u4e0b\u65b9\u4e3a\u7a7a\u5217\u8868\u800c\u975e\u8fc7\u671f\u6570\u636e\u3002')))
      }

      sections.push(React.createElement('div', { className: 'tw-chips', key: 'chips' },
        ['\u4f1a\u8bdd ' + (totals.sessions || 0),
         '\u8fd0\u884c\u4e2d ' + (totals.running || 0),
         '\u540e\u53f0\u4efb\u52a1 ' + (totals.jobs || 0),
         '\u4efb\u52a1\u8fd0\u884c ' + (totals.jobsRunning || 0),
         '\u5b50\u4ee3\u7406 ' + (totals.subagents || 0),
         '\u5de5\u4f5c\u6d41 ' + (totals.workflows || 0)].map(function (label, index) {
          return React.createElement('span', { className: 'tw-chip', key: index }, label)
        })))

      var pending = snap.pending || []
      sections.push(React.createElement('div', {
        className: 'tw-card' + (pending.length ? ' err' : ''),
        key: 'pending',
      },
        React.createElement('h4', null, '\u9700\u8981\u4f60\u4ecb\u5165', React.createElement('span', { className: 'tw-n' }, String(pending.length))),
        pending.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u5f53\u524d\u6ca1\u6709\u7b49\u5f85\u4e2d\u7684\u5ba1\u6279\u6216\u63d0\u95ee\u3002')
          : pending.map(function (item, index) {
            return row('p' + index, 'tw-dot warn',
              lines([item.title, item.detail, item.kind + ' \u00b7 ' + (item.session || '\u2014')]),
              ago(item.at, now))
          })))

      var sessions = snap.sessions || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'sessions' },
        React.createElement('h4', null, '\u4f1a\u8bdd', React.createElement('span', { className: 'tw-n' }, String(sessions.length))),
        sessions.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u6d3b\u7740\u7684\u4f1a\u8bdd\u3002')
          : sessions.slice(0, 30).map(function (session) {
            var info = (session.running ? '\u8fd0\u884c\u4e2d' : '\u7a7a\u95f2')
              + (session.activeJobs ? ' \u00b7 ' + session.activeJobs + ' \u4e2a\u4efb\u52a1\u5728\u8dd1' : '')
              + (session.live ? '' : ' \u00b7 \u4ec5\u65e5\u5fd7')
              + (session.origin === 'subagent' ? ' \u00b7 \u5b50\u4ee3\u7406' : '')
              + (session.depth ? ' \u00b7 \u6df1\u5ea6' + session.depth : '')
              + (session.preset ? ' \u00b7 ' + session.preset : '')
            var body = lines([session.title || session.id, session.id, info])
            if (session.goal) {
              var goal = session.goal
              body.push(React.createElement('div', { className: 'tw-dim', key: 'goal' },
                '\u76ee\u6807 ' + goal.phase + ' \u00b7 \u8f6e\u6b21 ' + goal.roundsStarted + '/' + goal.maxGoalRounds
                + (goal.activation === 'disarmed' ? ' \u00b7 \u672a\u7eed\u8dd1' : '')))
              if (goal.objective) {
                body.push(React.createElement('div', { className: 'tw-block', key: 'objective' }, goal.objective))
              }
              if (goal.blockedMessage) {
                body.push(React.createElement('div', { className: 'tw-block', key: 'blocked' }, '\u963b\u585e\uff1a' + goal.blockedMessage))
              }
              if (goal.maxGoalRounds > 0) {
                var pct = Math.min(100, Math.round((100 * goal.roundsStarted) / goal.maxGoalRounds))
                var tone = goal.phase === 'blocked' ? 'err' : (goal.phase === 'paused' ? 'warn' : '')
                body.push(React.createElement('div', { className: 'tw-bar', key: 'bar' },
                  React.createElement('i', { className: tone, style: { width: pct + '%' } })))
              }
            }
            return row('s' + session.id,
              session.running ? 'tw-dot run' : (session.activeJobs ? 'tw-dot warn' : 'tw-dot'),
              body, ago(session.lastActivity, now))
          })))

      var jobs = snap.jobs || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'jobs' },
        React.createElement('h4', null, '\u540e\u53f0\u4efb\u52a1', React.createElement('span', { className: 'tw-n' }, String(jobs.length))),
        jobs.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u540e\u53f0\u4efb\u52a1\u3002')
          : jobs.slice(0, 30).map(function (job) {
            return row('j' + job.id, dotClass(job.status),
              lines([job.label || job.id,
                     job.id + ' \u00b7 ' + job.kind + ' \u00b7 ' + job.status,
                     job.detail || (job.owner ? '\u5c5e\u4e3b ' + job.owner : '')]),
              dur(job.startedAt, job.finishedAt, now))
          })))

      var subs = snap.subagents || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'subagents' },
        React.createElement('h4', null, '\u5b50\u4ee3\u7406\u6811', React.createElement('span', { className: 'tw-n' }, String(subs.length))),
        subs.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u5b50\u4ee3\u7406\u3002')
          : subs.slice(0, 30).map(function (sub) {
            return row('b' + sub.id, sub.activity === 'running' ? 'tw-dot run' : 'tw-dot',
              lines([sub.label || sub.id, sub.id,
                     sub.mode + ' \u00b7 ' + sub.activity + ' \u00b7 \u6df1\u5ea6' + sub.depth + ' \u00b7 \u7236 ' + (sub.parent || '\u2014')]),
              null)
          })))

      var flows = snap.workflows || []
      sections.push(React.createElement('div', { className: 'tw-card', key: 'workflows' },
        React.createElement('h4', null, '\u5de5\u4f5c\u6d41', React.createElement('span', { className: 'tw-n' }, String(flows.length))),
        flows.length === 0
          ? React.createElement('div', { className: 'tw-empty' }, '\u6ca1\u6709\u8fd0\u884c\u4e2d\u7684\u5de5\u4f5c\u6d41\u3002')
          : flows.map(function (flow) {
            return row('w' + flow.id, 'tw-dot run',
              lines([flow.name || flow.id,
                     '\u9636\u6bb5\uff1a' + (flow.phase || '\u2014'),
                     flow.id + ' \u00b7 ' + flow.logs + ' \u6761\u65e5\u5fd7']),
              dur(flow.startedAt, 0, now))
          })))

      var problems = snap.errors || []
      if (problems.length) {
        sections.push(React.createElement('div', { className: 'tw-card warn', key: 'errors' },
          React.createElement('h4', null, '\u91c7\u96c6\u8bca\u65ad'),
          problems.map(function (text, index) {
            return React.createElement('div', { className: 'tw-mono', key: index }, text)
          })))
      }

      return React.createElement('div', { className: 'tw-wrap' },
        React.createElement('div', { className: 'tw-top' },
          React.createElement('h3', { className: 'tw-h' }, '任务监控'),
          // 用本地时钟，不用 snap.generatedAt：命中 304 时浏览器交回的是
          // 缓存里的旧响应体，那个时间戳会冻结，「刚刚检查过」就成了假话。
          React.createElement('span', { className: 'tw-meta' },
            new Date().toLocaleTimeString() + ' · 每 3 秒刷新'),
          React.createElement('a', { className: 'tw-meta', href: '/taskwatch', target: '_blank', rel: 'noopener' },
            '手机页 ↗')),
        sections)
    }

    function Icon(props) {
      var size = props && typeof props.size === 'number' ? props.size : 18
      var color = props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: color, strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
      }, React.createElement('path', { d: 'M2 12h4l2.5-6.5 3.5 13L15 12h7' }))
    }

    // 面板外链到独立移动页，方便复制到手机。
    function apply(ctx) {
      ctx.effect(function () {
        var el = document.createElement('style')
        el.setAttribute('data-dsh-taskwatch', '')
        el.textContent = CSS
        document.head.appendChild(el)
        return function () { el.remove() }
      })

      var slots = ctx.slots
      slots.inject('sidebar.panellist', function () {
        return slots.register(
          { name: 'sidebar.panellist', id: 'taskwatch', order: 60, label: '\u4efb\u52a1\u76d1\u63a7' },
          Icon)
      })
      slots.inject('main', function () {
        return slots.register({ name: 'main', key: 'taskwatch' }, Panel)
      })
    }

    module.exports = { name: 'dsh-taskwatch', inject: ['slots'], apply: apply }
    return module.exports
  },
})
