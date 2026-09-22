# dsh-taskwatch

Read-only task monitor for DeepSeek Harness. A phone-friendly status page plus a GUI
sidebar panel, covering sessions, background jobs, subagents, goal rounds, workflows
and pending approvals.

DeepSeek Harness 的只读任务监控：一个适配手机的只读状态页，加一个 GUI 侧边栏面板，
覆盖会话、后台任务、子代理、目标轮次、工作流与待审批事项。

![移动端只读页面](docs/screenshot-1.png)

展开一个会话后，它的目标、待介入事项、后台任务、子代理与最近对话都在原地：

![会话详情与最近对话](docs/screenshot-2.png)

> 两张图里的会话、任务、对话**全是演示用的假数据**，不是任何真实会话。它们由
> `docs/demo.html` 渲染——那个文件是 `scripts/make-demo.mjs` 从 `lib/page.html`
> 生成的，你可以直接用浏览器打开它，点着看，不需要装任何东西，也不会发出网络请求。

## 为什么需要它

DSH 的 Web GUI 没有内置鉴权，而默认 preset 往往是 `danger-full-access`。把整个 GUI
暴露到公网，等于把一台能执行任意命令的机器的入口挂出去。

这个插件的做法是**不暴露 GUI，另开一组窄接口**：

- **读**：把状态渲染成一份手机看得懂的页面，只放行这一条路径就够。
- **写**：`/taskwatch/chat/*` 把 DSH **自己的**会话运行时接到手机上 —— 直接对话、
  逐字收回复、随时停止、切换会话与模型。写入口**只有 4 条**，全部列在下面。

采集面完全通过 `ctx.get(...)` 软读取服务，任何一个服务不存在都只会让对应的那一块
留空，不会让插件挂载失败。对话那一组同理：拿不到 `sessionController` 时只让这一个
功能返回明确错误，不影响只读页面。

## 采集面

| 区块 | 内容 |
|---|---|
| 需要你介入 | 等待中的 `approval/request` 与 `user-questions/request` |
| 会话 | 运行/空闲、最后活动时间、该会话在跑的后台任务数、preset、是否仅日志 |
| 会话详情 | 点开后：目标、待介入事项、属于它的后台任务与子代理、最近对话 |
| 目标 | phase、轮次 `started/max`、activation、阻塞原因 |
| 后台任务 | id、label（多行命令已折成单行）、kind、status、生命周期时长、属主会话 |
| 子代理树 | 层级、深度、父会话、activity、mode |
| 工作流 | 当前 phase、日志条数、已运行时长 |
| 采集诊断 | 采集过程中单项失败的原因（不静默吞掉） |

## HTTP 路由

读（`GET`）：

| 路径 | 类型 | 说明 |
|---|---|---|
| `/taskwatch` | HTML | 手机页：以对话为主，顶部状态条点开是任务详情 |
| `/taskwatch/data` | JSON | 全部状态的快照，带 `ETag`，未变化回 `304` |
| `/taskwatch/session?id=&limit=` | JSON | 单个会话的最近对话（`limit` 上限 60，默认 20） |
| `/taskwatch/chat/sessions` | JSON | 可对话的会话列表（**不含子代理会话**） |
| `/taskwatch/chat/models` | JSON | 可选模型目录 |
| `/taskwatch/chat/titles?ids=` | JSON | 批量补会话标题（最多 20 个，宿主缓存 10 分钟） |
| `/taskwatch/chat/page?...` | JSON | 往更早翻会话历史 |
| `/taskwatch/chat/stream?sessionId=` | SSE | 跟随一个会话：开场快照 + 增量事件 + 逐字输出 |
| `/taskwatch/manifest.webmanifest` | JSON | PWA manifest |
| `/taskwatch/sw.js` | JS | service worker |
| `/taskwatch/icon-192.png` · `/taskwatch/icon-512.png` | PNG | 图标 |

写（`POST`）—— **只有这 4 条**：

| 路径 | 请求体 | 说明 |
|---|---|---|
| `/taskwatch/chat/send` | `{sessionId,text,mode?,timeZone?}` | 给会话发一条消息 |
| `/taskwatch/chat/cancel` | `{sessionId}` | 停止当前这一轮 |
| `/taskwatch/chat/create` | `{}` | 新建会话（**不接受客户端指定工作目录**） |
| `/taskwatch/chat/model` | `{sessionId,provider,model}` | 切换该会话使用的模型 |

全部注册在 `ctx.webServer` 上，不代理 DSH 自身的 `/api`，也不转发任意路径。
写入口就只有上面 4 条 —— 契约测试会**正面清点**路由表，增删都会让构建失败
（早先那条断言写的是"源码里不出现 `method === 'POST'`"。加了 4 个写路由之后它
照样通过，是条假绿灯：它证明的是"没这么写"，不是"没有这个能力"）。

### 对话路由为什么这么薄

手机端要的「像 ChatGPT 一样对话」，DSH 内部**本来就有** —— `sessionController`
提供 `prompt` / `follow` / `cancel` / `list` / `create` / `page` / `modelCatalog` /
`selectModel`。所以这个插件一行 LLM 调用、一行流式解析都没写，只是把这几个方法
转成 HTTP。三个实测出来的坑记在这里：

- `follow()` 返回的本来就是**为传输设计的 wire 帧**（`SessionWireEvent.data` 是
  `JsonValue`），可以安全地逐帧 `JSON.stringify`；不要去碰会话活对象。
- SSE 响应必须显式带 `x-accel-buffering: no`，否则 nginx 会把流式缓冲成一次性吐出。
- `tool/result` 帧的 `callId` **不在顶层**，在 `data.message.source.callId`。
  按顶层读会一直拿到 `undefined`，表现是每来一个工具结果就多插一张错卡。
- 会话标题只能从事件日志的 `session/title` 帧里取 —— `SessionSummary` 里**没有**
  title 字段。分页语义也是实测的：`throughSeq` 超过会话 cursor 会报
  `past cursor N`，而 N 正是需要的值，于是用错误信息一步重试。

### 手机页为什么这样排

要解决的是「小白点进来也看得懂」。所以页面**不做仪表盘**：顶部一行说人话的状态
（点开才是原来那张数据表），中间是对话，底部是输入框，数据表格收进抽屉。

两个具体决定：

- **工具调用翻译成人话**。`pwsh` → 「运行命令」、`grep` → 「搜索内容」、`subagent` →
  「派发子任务」。用户不需要知道 `pwsh` 是什么；卡片上还给一行命令/路径摘要，状态用
  进行中 / 完成 / 失败三态。这是"看得懂进度"最关键的一处。
- **逐字输出只改一个节点**。整页重建会让长会话每来一个字都重排一次。

### 页面为什么不做整页重建

页面每 3 秒轮询一次，但**数据没变就完全不碰 DOM**，只刷新右上角时间戳。首版是
`root.innerHTML = h` 全量重建，结果是每 3 秒把页面拆一次：展开的东西 3 秒后被抹掉，
滚动位置被打断，看起来像「不刷新」和「点不动」——那是同一个原因。

这里有个容易漏掉的坑：**比较序列化结果时不能把 `generatedAt` 算进去。** 它是每次采集
都不同的 `Date.now()`，带着它比较，签名就永远在变，「数据没变就不碰 DOM」实际上是
一句空话，页面照样每 3 秒整页重建。所以客户端算签名、服务端算 `ETag` 时都先把这个
字段归一化，两边保持同一套判据。

而「有东西在跑的时候」仍然要重画：画面上的时长要一直往上走。所以静止时就真的不碰
DOM，有运行中的会话、后台任务、子代理或工作流时才重画。

展开状态与对话缓存存在 JS 对象里，跨轮询保留；点击用事件委托挂在常驻容器上，
所以内层 DOM 重建也不会丢监听。对话按需懒加载，点开一次即缓存。

### 轮询在服务端和手机上各收一次口

页面每 3 秒轮询，而这个页面的主要用途是**手机**——最常见的状态是「揣在兜里、屏幕已熄」。
不处理的话，一个常驻后台的标签页会永远每 3 秒发一次请求。所以两头都做了收敛：

- **客户端**：监听 `visibilitychange`，页面隐藏时 `clearInterval` 停止轮询，回到前台立刻
  补一次请求。手机上省的是流量和电。
- **服务端**：`snapshot()` 一次要问一圈服务（每个 agent 的 jobs、每个会话的
  `eventAt`/`title`/`goal`、每个 agent 的 `listDescendants`）。现在同一份采集在
  **2 秒 TTL** 内被复用，并发请求共用同一个 Promise 而不是各算各的——手机、桌面面板和
  多个标签页同时开着时，这一层把开销从「每请求一次全量采集」压成「最多每 2 秒一次」。
- **带宽**：`/taskwatch/data` 返回 `ETag` 并在未变化时回 `304`，手机上只交换一个头而不是
  整份 JSON。

最后一条有个**必须成对**的地方：页面取数用的是 `cache:'no-cache'`，不能用 `no-store`。
`no-store` 会让浏览器根本不保存响应，也就永远不会带 `If-None-Match` 回来，服务端那段
`304` 会变成死代码。这两处因此都在契约测试里钉住了。

### 采集失败时不能伪装成正常

这是监控工具最危险的失败姿态，所以单独说清。

宿主采集异常时 `/taskwatch/data` 回的是 **HTTP 200 + `{ "error": ... }`**。如果客户端
把这份载荷当数据用，画出来就是一块「全部为 0」的板子：0 个会话、0 个后台任务、
「当前没有等待中的审批或提问」。**它看起来像「真的没有任务」，而不是「没读到」。**

所以两半都显式处理 `error` 字段，把它当错误而不是数据：

- **手机页**：`tick()` 先查 `d.error`，命中就只在页脚写「采集失败：…」并保留上一份
  可用快照，绝不拿它去重画。
- **GUI 面板**：把 `snap.error` 视为错误，继续渲染**上一份可用快照**，并在顶部挂一条
  「数据可能已陈旧（快照时间 HH:MM:SS）：…」的横幅。一次网络抖动同样只产生这条横幅，
  而不是把整块面板清成空白 —— 监控面板的价值恰恰在于「断开时还能看到最后一帧」。

同一类问题的另一面是轮询的**乱序**：并发请求下，较早发出的响应完全可能晚回来。两半
都用一个自增序号只接受最新一次的结果，避免旧数据覆盖新数据。

### `/taskwatch/session` 的两条限制

1. **只能读活着的会话。** `ctx.sessions` 是内存存储，`get(id)` 返回 `undefined` 时接口
   会**明确报错**「这个会话不在内存里（已落盘但未加载的会话读不到）」，而不是返回一个
   空的 `messages` —— 后者会让人误以为那个会话真的没说话。
2. **只读不写。** 没有发送消息、批准审批、打断运行的入口。要做到那些，必须把 DSH 的
   Web GUI 暴露出去，那是另一个量级的风险，本插件刻意不做。

消息只取叶子字段（role、text、工具名、时间），不把活的会话日志对象序列化出去。

## GUI 面板

`lib/client.js` 注册一个侧边栏面板（`sidebar.panellist`），数据取自同源的
`/taskwatch/data`，**不需要任何 host RPC**。样式全部挂在插件自己的 fiber 上，
卸载即还原。

面板右上角有一个指向手机页的链接，方便直接把 `/taskwatch` 复制到手机上打开。

面板和手机页在轮询上是对称的：窗口不可见时 `clearInterval` 停止轮询，回到前台立刻
补一次请求。桌面这一半容易被忽略，但它的典型用法恰恰是「GUI 最小化、拿手机看」。

## 安装

```sh
dsh plugin --profile web add dsh-taskwatch
```

装完需要**重启 `dsh web`**：插件行来自 profile 的 bundle 图，而 client 侧模块元数据
按 specifier 缓存且没有失效路径，所以增删插件一律要重启才生效。

本包**没有构建步骤**：`lib/` 是提交进仓库的、可直接运行的产物，客户端 bundle 就是
一个调用 `window.__ModuleLoader__.load({ id, factory })` 的普通脚本。从源码安装不需要
任何构建授权（`allowBuilds`）。

本地开发时也可以直接指向工作副本：

```sh
dsh plugin --profile web add <你的绝对路径>/dsh-taskwatch
```

补丁里引用插件有两种写法，注意区别：bundle 自带的 `cordis.patch.yml` 用**包名**
（由 profile 的 `node_modules` 解析），而 profile 自带补丁里若写路径，必须是绝对路径
（相对路径是相对该补丁文件解析的，跨盘会失败）。

## 在外网 / 手机上访问（需要你自己叠一层）

**本插件自己不做鉴权，只监听回环。** 它提供的是「可被安全转发的只读源」，转发这一层
由你自己的隧道或反向代理负责。一个已验证可用的组合是：

```
手机 / 外网
  └─ HTTPS  <你的域名>                反向代理：TLS 终止 + basic auth
       └─ 隧道回到本机                 ssh -R，或任何等价隧道
            └─ 本机只读中继             校验应用层共享令牌
                 ├─ /taskwatch、/taskwatch/data、/taskwatch/session → DSH 的回环端口
                 └─ manifest / sw.js / 图标                          → 中继本地文件
```

配套的只读中继是刻意做成**另一件事**的，不属于本插件：它是几十行的零依赖 Node 脚本，
把白名单里的固定路径转发到 DSH 的回环端口，其余一律 404。想自己写的话，要点就四条：

1. **白名单硬编码**，不要让上游路径可配置 —— 否则它就成了一个任意代理。
2. **只允许 GET/HEAD**，不接受请求体，不转发 `/api`。
3. **自带一层共享令牌**，定长比较（`timingSafeEqual`），并且不要把令牌转发给上游。
4. **转发时要带上查询串**。这一点踩过坑：漏掉它时 `/taskwatch/session` 会返回
   HTTP 200 但内容永远是「缺少 id 参数」——状态码看着完全正常，只是数据永远为空。

PWA 外壳由中继本地提供（而不是转发上游），这样它不随上游插件的版本变化而失效；
页面文件与插件共用同一份，避免两边漂移。

## 安全边界

- **写入口等于一台终端**。一旦放行 `/taskwatch/chat/send`，能打开这个页面的人就能在
  这台机器上驱动 agent —— 而 DSH 默认 `danger-full-access`。所以中继那一层必须
  **同时**有 TLS、HTTP basic auth 和应用层令牌，三层缺一不可；`/taskwatch/chat/*`
  能不转发就不转发。手机页默认只在**已有**会话上操作，新建会话也不接受指定工作目录。
- 手机上做的每一步都会落进该会话的日志，桌面上打开同一个会话就能看到全部经过 ——
  这是"远程操作可追溯"的那一半。
- 插件的路由只在**回环**上监听，从不对外。
- 页面带 `X-Robots-Tag: noindex, nofollow`，响应带 `nosniff`。除 `/taskwatch/data`
  （见下）外一律 `no-store`。
- service worker 的作用域**限定为 `/taskwatch`**（注册时即指定，脚本也放在
  `/taskwatch/sw.js`），不允许它有机会拦截主 GUI 的请求；`/taskwatch/chat/*`
  在 `fetch` 里被显式放过，尤其不能让 SSE 被它包一层。
- 状态数据**不会被离线复用**：外壳可以离线打开，但 `/taskwatch/data` 与
  `/taskwatch/session` 每次都必须回源。断网时返回一份显式的 `offline: true` 空快照并在
  页面上明说 —— 对监控来说，看到过期状态比看到断连更危险。

  这里有一处刻意的例外值得说清：`/taskwatch/data` 用的是 `no-cache` + `ETag`，而不是
  `no-store`。区别在于 `no-cache` 允许浏览器**存**一份副本，但**每次都必须回源校验**，
  只有服务端确认「内容没变」才回 304 并复用。所以页面上永远不会出现未经校验的旧数据，
  而每次轮询省下了整份 JSON 的传输。要复用的只是这一份**刚被服务端确认过**的字节。

## 已知限制

- 界面文案目前是**中文**，还没有做多语言。
- `/taskwatch/session` 只覆盖内存中的活跃会话（见上）。
- 服务没有鉴权，**不要**把它直接暴露到公网；请自行在前面加一层。
- 会话、任务、子代理各列表最多渲染 40 条（GUI 面板是 30 条，且不像手机页那样提示
  「还有 N 条未显示」），避免长会话把页面拖慢。工作流列表目前没有上限——宿主只收
  运行中的工作流，通常很小，但契约上没有上界。
- 单条消息文本超过 4000 字符会被截断。
- **手机页只能对话，不能审批**。状态条会告诉你「有 N 件事在等你」，但批准/回答仍然
  只能在桌面上做 —— 也可以直接在对话里让 agent 继续，那才是它的等价物。
- **子代理会话不出现在手机列表里**。它们是宿主内部的干活会话（`origin: subagent`），
  没有父地址连日志都读不了（分页会报 `subagent Sessions require their durable parent
  address`），混进列表只会让"该点哪个"更难。
- 冷会话标题要现读一次事件日志（每个会话 1~2 次持久化读，实测约 0.5 秒/次）。宿主侧
  缓存 10 分钟、手机侧缓存在 `localStorage`，所以只有第一次打开会话列表会花一两秒，
  而且是每 4 个一批刷出来、不是干等到最后。
- 会话列表只补**最上面 12 条**的标题；再往下的仍显示目录名，滚动不会触发补取
  （下次打开才会）。
- 手机页把会话 id 显示成前 10 位加省略号，但那**只是排版**：完整 id 仍在 `data-sid`
  属性里，因为点击展开要用它。不要把短显示当成脱敏。
- 页面**还没有设 CSP**。它与 DSH Web GUI **同源**，而后者没有鉴权且默认
  `danger-full-access`，所以任何一次漏转义都等于一台能执行任意命令的机器的入口。
  目前模型正文、工具提示、工具名、会话标题这四处要么走 `textContent`、要么经
  `esc()`，也有契约测试钉着 —— 但要说清那条测试的能力边界：它是**代理**，
  盯的是已知的四个入口，不等于"全页面无 XSS"。加一层 `Content-Security-Policy`
  （脚本用 sha256 hash 而非 `unsafe-inline`）会是更结实的纵深防御。这是本项目
  最值得做的下一步加固。

## 开发

```sh
node scripts/check-bundle.mjs   # 客户端 bundle + 宿主契约 + 页面的测试（54 项）
node scripts/make-icons.mjs     # 重新生成图标（自实现 PNG 编码，零依赖）
node scripts/make-demo.mjs      # 生成 docs/demo.html（假数据，供截图与预览）
```

（`check` / `icons` / `demo` 也都有对应的 npm script。）

`check-bundle.mjs` 不只检查客户端：它还**真的 import 宿主半边**，断言
`name` / `apply` / `inject` 三个导出都在，并把 `cordis.patch.yml`、`exports`、
`dsh` 元数据一并核对。

为什么宿主也要钉住：Cordis 的 `inject` 决定框架等哪些服务就绪后才调用 `apply`。
`webServer` 的服务是在启动阶段之后才发布的，而 `apply` 在组合期就会被调用——
只写 `ctx.get('webServer')` 软读会在那一刻拿到 `undefined`，于是整段路由注册被
静默跳过。现象是插件"装好了、也不报错，但 `/taskwatch` 一律 404"，极难定位。
（v1.0.0 正是踩了这个坑。）同理 `kind:'prefix'` 与 `kind:'exact'` 都合法，但
重复的 `(kind, path)` 会让 `register()` 抛错——所以路由路径也纳入断言。

`scripts/make-icons.mjs` 是手写 PNG 编码（Node 内置 zlib + 自实现 CRC32），满幅不透明
方形，图形落在中心 80% 安全区内，因此同一个文件既能当普通图标也能当 maskable。

`scripts/make-demo.mjs` 从 `lib/page.html` **生成**演示页，只把取数逻辑换成一份固定
假数据。之所以是生成而不是手写：手写就意味着 CSS 与结构有两份副本，必然漂移，截图会
慢慢变成一张不像当前 UI 的图。README 里那两张图就是从生成物截的，所以只要 `page.html`
变了，重跑脚本再截一次就与实现一致。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
