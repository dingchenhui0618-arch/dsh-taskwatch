/**
 * 从 lib/page.html 生成 docs/demo.html —— 用于截图的假数据演示页。
 *
 * 为什么不直接截真实页面：真实页面里有会话标题、cwd、后台任务的命令行和对话正文，
 * 那些是使用者的私有数据，不能进公开仓库。
 *
 * 为什么用生成而不是手写：手写一份 demo 就意味着 CSS 与结构有两份副本，一定会漂移，
 * 截图会慢慢变成"一张不像现在 UI 的图"。这里直接复用真实的 lib/page.html，只把
 * 取数逻辑换掉，所以只要 page.html 变了，重新跑本脚本截图就与实现一致。
 *
 * 用法：node scripts/make-demo.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const page = readFileSync(join(ROOT, 'lib', 'page.html'), 'utf8')

const now = Date.now()
const S = (sec) => now - sec * 1000

// 全部为虚构内容：没有真实仓库、没有真实路径、没有真实会话。
const DEMO = {
  generatedAt: now,
  offline: false,
  errors: [],
  totals: { sessions: 4, running: 2, jobs: 5, jobsRunning: 3, subagents: 2, workflows: 1, pending: 1 },
  pending: [
    {
      title: '等待确认：删除 3 个过期缓存目录',
      detail: '即将对 build/cache 下的过期产物执行清理，需要你先确认。',
      kind: 'approval/request',
      session: 'session-demo-a',
      at: S(45),
    },
  ],
  sessions: [
    {
      id: 'session-demo-a',
      title: '重构支付模块的重试逻辑',
      running: true,
      activeJobs: 2,
      live: true,
      origin: 'root',
      depth: 0,
      preset: 'cordis',
      lastActivity: S(3),
      goal: {
        phase: 'active',
        roundsStarted: 7,
        maxGoalRounds: 50,
        activation: 'armed',
        objective: '把支付回调的重试从固定间隔改成指数退避，并补齐幂等键的边界用例。',
      },
    },
    {
      id: 'session-demo-b',
      title: '整理季度报表导出',
      running: true,
      activeJobs: 1,
      live: true,
      origin: 'root',
      depth: 0,
      preset: 'cordis',
      lastActivity: S(18),
      goal: { phase: 'active', roundsStarted: 3, maxGoalRounds: 20, activation: 'armed', objective: '导出去年四个季度的报表并核对口径。' },
    },
    {
      id: 'session-demo-c',
      title: '排查登录态失效问题',
      running: false,
      activeJobs: 0,
      live: true,
      origin: 'root',
      depth: 0,
      preset: 'cordis',
      lastActivity: S(2400),
      goal: null,
    },
    {
      id: 'session-demo-d',
      title: '更新部署文档',
      running: false,
      activeJobs: 0,
      live: false,
      origin: 'subagent',
      depth: 1,
      preset: 'cordis',
      lastActivity: S(8600),
      goal: null,
    },
  ],
  jobs: [
    { id: 'job-1', label: 'pnpm test --filter payments', kind: 'pwsh', status: 'running', owner: 'session-demo-a', startedAt: S(310), finishedAt: 0 },
    { id: 'job-2', label: 'node scripts/build.mjs', kind: 'pwsh', status: 'running', owner: 'session-demo-a', startedAt: S(95), finishedAt: 0 },
    { id: 'job-3', label: 'node scripts/export-report.mjs --quarter Q3', kind: 'pwsh', status: 'running', owner: 'session-demo-b', startedAt: S(720), finishedAt: 0 },
    { id: 'job-4', label: 'git log --oneline -50', kind: 'pwsh', status: 'done', owner: 'session-demo-c', startedAt: S(3000), finishedAt: S(2998) },
    { id: 'job-5', label: 'node scripts/make-icons.mjs', kind: 'pwsh', status: 'failed', owner: 'session-demo-b', startedAt: S(5200), finishedAt: S(5195) },
  ],
  subagents: [
    { id: 'agent-demo-1', label: '核对接口字段', mode: 'subagent', activity: 'running', depth: 1, parent: 'session-demo-a' },
    { id: 'agent-demo-2', label: '翻译发布说明', mode: 'subagent', activity: 'idle', depth: 1, parent: 'session-demo-b' },
  ],
  workflows: [
    { id: 'wf-demo-1', name: '回归测试与发布检查', phase: 'verify', logs: 42, startedAt: S(1800) },
  ],
}

const CONVO = {
  loading: false,
  error: null,
  total: 6,
  messages: [
    { role: 'user', text: '把重试改成指数退避，先只动回调那一处。', tools: [], at: S(900) },
    { role: 'assistant', text: '已定位到回调入口。当前是固定 5 秒重试、最多 3 次。', tools: ['grep', 'read'], at: S(870) },
    { role: 'assistant', text: '改成基础 2 秒、上限 60 秒的退避，并保留最后一次失败的原始异常。', tools: ['edit'], at: S(600) },
    { role: 'assistant', text: '', tools: ['pwsh'], at: S(320) },
    { role: 'assistant', text: '单测通过（12/12）。幂等键的重复投递用例也补上了。', tools: [], at: S(180) },
    { role: 'assistant', text: '还差一件事：缓存目录的清理要你确认后才执行。', tools: ['ask_user_question'], at: S(45) },
  ],
}

const boot = [
  `var DEMO=${JSON.stringify(DEMO)};`,
  `var DEMO_CONVO=${JSON.stringify(CONVO)};`,
  '// 演示页：不轮询、不联网、任何会话都能点开看同一份示例对话。',
  '// tick / loadConvo 都是函数声明（会提升），所以在这里覆盖是安全的。',
  'tick=function(){};',
  'loadConvo=function(sid){CONVO[sid]={loading:false,error:null,total:DEMO_CONVO.messages.length,'
    + 'messages:DEMO_CONVO.messages};render(DEMO,true)};',
  'render(DEMO);',
  "OPEN['session-demo-a']=true;",
  "CONVO['session-demo-a']=DEMO_CONVO;",
  'render(DEMO,true);',
].join('\n')

let out = page

const tickLine = 'tick();setInterval(tick,3000);'
if (!out.includes(tickLine)) {
  console.error('找不到取数启动行，page.html 结构变了，请同步更新本脚本')
  process.exit(1)
}
out = out.replace(tickLine, boot)

// 演示页不做轮询、不注册 service worker（file:// 下也没意义）。
out = out.replace(
  /if\('serviceWorker' in navigator\)\{[\s\S]*?\}\n/,
  '/* demo: 不注册 service worker */\n'
)
out = out.replace(/<title>[^<]*<\/title>/, '<title>任务监控 · 演示数据</title>')
out = out.replace(
  /<footer id="foot">[^<]*<\/footer>/,
  '<footer id="foot">演示数据 · 非真实状态</footer>'
)
out = out.replace(/<div id="meta">[^<]*<\/div>/, '<div id="meta">演示数据</div>')

mkdirSync(join(ROOT, 'docs'), { recursive: true })
writeFileSync(join(ROOT, 'docs', 'demo.html'), out)

console.log('已生成 docs/demo.html')
console.log('  取自 lib/page.html（' + page.length + ' 字符）')
console.log('  演示会话数 ' + DEMO.sessions.length + '，后台任务 ' + DEMO.jobs.length + '，对话 ' + CONVO.messages.length + ' 条')
console.log('  已展开 session-demo-a 以展示详情与对话区')
