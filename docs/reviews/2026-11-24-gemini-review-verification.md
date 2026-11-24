# Gemini 架构审查核实（2026-11-24）

来源：Gemini 生成的两份文档，2026-11-23。《译屿（Islet Translate）项目设计与实现深度审查报告》（下称「审查」，编号 1.1–1.5、2.1–2.3、3.1–3.2、二.1–二.6）；《译屿三项核心架构演进专项设计方案》（下称「专项」，方案一 LLM 整页流式逐段协议、方案二 Preact 改造、方案三 Open Shadow DOM 穿透）。原文不贴。

基线：main 的 `b648990`。

方法：三路 Opus 子代理分别在隔离副本里核实，读代码、写复现测试、实测（管线与后台；页面扫描与渲染；架构、Preact 与音标）。随后由 Fable 5.2 抽查 `codec.ts`、`openai-compat.ts`、`sse.ts`、`session.ts`、`render.ts`、`discover.ts`、`mutations.ts`、`segment.ts` 及 m1/m2/m3c/m3d 方案并裁决。三份报告与裁决冲突时以裁决为准，文中标「裁决改判」。仓库未改动；复现用例为临时文件，未入库。

结论：没有需要打断 M3c 的问题。立即修两个小 PR（batch 与 text 终稿 `<think>` 剥离；渲染三项小修），都进 v0.5.0。方案一只取「部分提交 + 增量 JSON 解析」，方案二页内不迁，方案三只做测量。最被低估的风险在方案一：部分提交会把整批校验降成逐项校验（见 4.1）。

## 1. 逐条结论

| 编号 | 结论 | 严重度 | 裁决 | 证据 |
| --- | --- | --- | --- | --- |
| 1.1 SSE 首字节无超时 | 已知取舍 | P3 | 观察 | `sse.ts:71`、`m1-translation-core.md:160`、`scheduler.test.ts:432` 锁定；Gemini 写的 25–30 s 与代码 60 s 不符；只有完全静默的连接才占满 180 s |
| 1.2 整页与划词缓存割裂、promote 失效 | 部分属实，已知取舍 | P3 | 不采纳 | 仅 LLM 成立（`service.ts:293-297`、`prompt.ts:71-74`）；Google 共用缓存；`m3a-selection.md:129,394` 已写明 |
| 1.3 双层分批、重试风暴 | 不属实 | — | 不采纳 | 前端只重试请求级错误（`session.ts:547-558`），逐段错误走 `markFailed` |
| 1.3 在途不可撤、429 前端无感知 | 属实，设计决定 | P3 | 观察 | `m2-page-translation.md` 5.4；Port 协议无冷却帧，提示需新文案，有反馈再问用户 |
| 1.4 batch 模式未剥 `<think>` | 属实，比原文严重 | P2 | **立即修** | `codec.ts:202-218`、`openai-compat.ts:88`；复现 4 红：整批 bad-response；围栏内原文被当译文缓存 7 天 |
| 1.5 过期清扫活锁 | 不属实 | — | 不采纳 | `cache.ts:256-287` 每批独立提交，过期记录单调减少 |
| 2.1 扫描阻塞首译 | 属实（万级元素页） | P2 | 路线图：边扫边注册 | 16 502 单元页 4x 降速下扫描 0.9–1.2 s；`session.ts:961-983` |
| 2.1 附带：首批多等 50 ms | 多数时序下属实 | P3 | **立即修** | `FLUSH_DEBOUNCE_MS`（`session.ts:100`）与 `m2-page-translation.md:127` 不符；复现红 |
| 2.2a 写后读 | 部分属实 | P3 | 不采纳 | `render.ts:572-574` 每批一次，实测 0.1–0.4 ms，只触发样式重算 |
| 2.2b `known()` 重分段 | 属实 | P2 | **立即修** | `session.ts:674-682`；大型动态页每次整页重扫 65–295 ms 长任务 |
| 2.2c `unitOf` O(N) | 属实，无影响 | — | 不采纳 | 只在按住手势时调用一次（`session.ts:1079`），约 1 ms |
| 2.2d 等帧空窗未查 drop | 属实，已知问题 | P2 | **立即修** | `render.ts:538-565`；复现 2 红，多出孤儿 `et-tr` |
| 2.3 Open Shadow DOM | 代码层属实，影响被夸大 | P3 | 观察：先做测量 spike | `discover.ts:88-91`；slot 投影的 light DOM 已能翻译 |
| 2.3 iframe / allFrames | 已知取舍 | — | 不采纳 | `entrypoints/content.ts:29-31`、`m3d.md:29`；常驻预算余 0.15 KB |
| 3.1 维护拐点（三孤岛） | 部分属实 | — | 路线图：协调器 + ui-kit | 重复打包实测 5–6 KB（Gemini 11–14）；无状态同步类缺陷 |
| 3.2 音标 2.2 MB 难扩展 | 体积属实，运行时开销不属实 | — | 路线图：M5 词典态重设计 | dict 占发布包 2.28/2.52 MB；`lookup.ts` 只取 1–3 个分片 |
| 二.1 全栈 Preact | 页内不成立 | — | 页内不采纳；扩展页观察 | 见 4.2 |
| 二.2 原生能力砍 80% | 不属实 | — | 不采纳 | `linear()` 无法打断续速；几何、探测、意图非 CSS 可表达 |
| 二.3 `registerContentScripts` 零注入 | 不可行 | — | 不采纳 | 需全站主机权限，`m2b-lazy-runtime-and-isle.md:313` 附录 A 已否决 |
| 二.4 XML 协议 / 页面上下文 / 单一调度 | 见方案一 | — | 不采纳；上下文并入 M4 | 换协议使全部整页缓存失效 |
| 二.5 视口优先发现 | 方向对 | P2 | 以边扫边注册实现 | 两轮扫描即 `session-watch-before-scan.md:27` 否决的方案 B |
| 二.5 镜像式仅看译文 | 不采纳 | — | 不采纳 | 破坏 `:nth-child`、锚点、IO 目标与 DOM 约定 |
| 二.6 词典紧凑化 + 内置 AI 前置 | 部分属实 | — | 维持 M3e | 编码只省 7–12%；渐进替换是新功能，须先问用户 |
| 方案一 | 部分采纳 | — | 路线图：v0.5.0 后、M3e 前 | 见 4.1 |
| 方案二 | Phase 1 实测属实 | — | 观察（条件触发） | 见 4.2 |
| 方案三 | 部分采纳 | — | 观察（先 spike） | 见 4.3 |

## 2. 已确认的缺陷

### 2.1 管线 1.4：batch 模式未剥 `<think>`（P2，立即修）

`openai-compat.ts:88` 把累积的 content 原样交给 `decodeLlmOutput`；`extractArray`（`codec.ts:202-218`）依次尝试整体 `JSON.parse`、第一个 json 围栏、首个 `[` 到末个 `]`。`<think>` 只在 text 模式处理（`cleanTextOutput`、`createThinkFilter`）。Gemini 适配器按 `part.thought` 过滤，`reasoning_content` 型服务不受影响；受影响的是把 `<think>` 内联进 content 的 OpenAI 兼容服务。哪些具体服务会内联，未用真实服务验证。

两种失败模式：
1. 思维链含 `[`：切片错位，整批报 `validation/bad-response`。经调度器二分到单段仍全败，4 段发了 7 次请求（1+2+4），整页翻译全部失败并多付约一倍 token。
2. 思维链含 json 围栏：第一个围栏先被采用，返回原文。`classifyTranslation` 判为 `unchanged`（`service.ts:72-77`）；`isEchoedTranslation` 只拦至少 4 个拉丁词的句子，短句作为译文写进缓存 7 天。

复现：用例 6 条（4 红 2 绿，副本 `review-pipeline-repro.test.ts`），1.4 相关 3 红，另有对照 1 绿。关键断言：含 `[` 的思维链应解出译文数组；含围栏的思维链应解出译文而非原文；经调度器应 1 次请求成功而非 7 次。子代理的最小修法（`codec.ts:226` 剥开头完整 `<think>` 块）临时应用后 `src/lib/translate/` 420 个用例无回归，已还原。

裁决改判：子代理的修法只覆盖有开标签的情形，不够。
- 缺开标签的思维链：把 `<think>` 放进生成提示的模板（DeepSeek-R1 新模板、QwQ 经 vLLM / llama.cpp 直出等）输出只有 `推理…</think>译文`，开头剥离修不到。这是已知变体，未用真实服务验证。
- 修法：整体 `JSON.parse` 失败后，若输出含 `</think>`，先对第一个 `</think>` 之后的尾部走一遍现有提取；拿到数组就用，拿不到再退回对原文的旧逻辑。同时覆盖两种形态，无推理块时行为不变。
- 不做全局替换，译文 JSON 里可能字面出现 `<think>`。
- text 模式同修：`cleanTextOutput` 在原文不含 `</think>` 时，取最后一个 `</think>` 之后的内容（推理文字目前会被当译文显示并缓存）。流式 `createThinkFilter` 不动，终稿会纠正，缺口记入 known-issues。
- 不处理 `<thinking>`、`<reasoning>`、harmony channel 等其他标记，没有反馈，观察。思维链未闭合维持报错；缓存键、提示词版本不变。
- 回归用例：复现文件里的 3 条 + 缺开标签 2 条。

**实际修法（#75，`fix/batch-think-strip`）**：
- batch（`extractArray`）：先整体 `JSON.parse`；失败且输出含 `</think>`（不分大小写）时，对**第一个** `</think>` 之后的尾部走原有的宽松提取（整体、围栏、首 `[` 到末 `]`）；仍拿不到再对整段输出走旧逻辑。条数、id 校验不变。
- text（`cleanTextOutput`）：原文不含 `</think>` 时，丢掉**最后一个** `</think>` 及之前的内容；原有「原文不含 `<think>` 时删 `<think>…</think>` 块」的规则保留在其后。
- 两处取法不同，是有意的：
  - batch 选第一个：解码时看不到原文，原文里若有字面 `</think>`，译文 JSON 里也会有，取最后一个会切进译文字符串，整批作废；取第一个则保留。思维链里若字面提到 `</think>`，第一个切点后残留的推理文字仍由宽松提取（围栏、切片）兜住，兜不住时退回旧逻辑，不比修复前差。batch 还有严格的结构校验（JSON、条数、id），切错多半报错而不是静默出错。
  - text 选最后一个：剥离只在原文不含 `</think>` 时进行，译文里出现字面 `</think>` 的可能已被排除；剩下的风险是思维链自己提到 `</think>`，取最后一个能把推理全部去掉。text 没有结构校验，剩下什么就显示、缓存什么，取第一个会把推理残段静默当译文写进缓存。
- 裁决改判：`TEXT_PROMPT_VERSION` 1 → 2。`prompt.ts` 约定「输出清洗（`cleanTextOutput`）变化时升版本」，且旧版在缺开标签时会把推理当译文缓存，升版本让这些划词缓存一次性失效。`PROMPT_VERSION`（整页 batch）与缓存键格式不变，整页缓存不受影响。
- 定位 `</think>` 用正则（`/<\/think>/i`）在原串上取下标，不用 `toLowerCase()` 后的下标：`İ` 小写后变成两个码元，下标会错位（审查时发现并补了用例）。
- 用例：`codec.test.ts` 新增 12 条（batch 6 条、text 6 条），`scheduler.test.ts` 新增 1 条（经调度器 4 段 1 次请求译出，修复前为 bad-response）。在 main 的 `codec.ts` 上 10 红、3 绿（对照组两条与「原文含 `</think>` 时保留」），修复后全绿。background 实测 57.78 → 57.85 KB（gzip 59 169 → 59 237 B，+68 B）。

### 2.2 渲染 2.2d：等帧空窗未检查 drop（P2，立即修，已知问题）

`insert` 的 `await frame()` 之后不查单元是否已 `drop`（`render.ts:538-565`）；`drop` 时 `rendered` 里还没有记录，写阶段照写。会话里的路径：`scheduleRender` 把单元交给 `insert` 后，等帧的 16 ms 内一次重扫让它被 `forget`，孤儿译文留下，新单元再插一份，同段两份译文。已记于 `docs/known-issues.md` 第 2 节「#57 记录」第 2 条。复现 2 红（`insert()`、`fail()` 各多出 1 个 `et-tr`）。

裁决改判：子代理建议照 `skipping` 集合（`render.ts:166-167, 465-473`）做 `writing` 集合。`skipping` 是「写时删除」，同一单元两次 `insert` 在同帧重叠时第二次会被误跳过，留下旧译文。改用 `WeakMap<Unit, number>` 记 drop 代数：读阶段取值，写阶段比对，`drop()` 自增；`note()` 的失败分支同样处理。

### 2.3 渲染 2.2b：`known()` 重分段（P2，立即修）

`known()` 对同根同文旧单元调用 `isCurrent`，即 `stillSame` 重新 `segment()`（`render.ts:389-398`），`settle` 同步执行（`session.ts:691-709`）。脏元素超过 32 个时 `mutations.ts:51-69` 合并为整页重扫，无限滚动、SPA 换页、时间戳刷新都常见。实测把全部单元重分段一遍：issue-400（4 402 单元）17 ms（1x）/ 67–71 ms（4x）；16k 单元页 65–75 ms / 243–295 ms，违反「单任务 ≤ 8 ms」。

修法：`known()` 改比 `seg.digest`，run 再比节点同一性（`other.nodes` 与 `unit.nodes` 逐个相同）；`mayBeHidden` 分支保留 `isCurrent`。等价前提已核实：`segment` 经 `isSkipped` 忽略 `et-tr`，`discover.ts:111` 与 `stillSame` 的节点集一致。补一条用例：已译块重扫后单元被保留（`et-tr` 在场时 digest 相等）。预计体积约 0 或略减。

### 2.4 渲染 2.1：首批多等 50 ms（P3，立即修）

`scan()` 末尾 `scheduleFlush(true)` 执行时 IO 还没回调，`pending` 为空；真正的 IO 回调走 `onViewport`（`session.ts:429-445`）再 `scheduleFlush()`，吃 50 ms 防抖。复现：IO 报告后 10 ms 请求数 0，60 ms 才 1（红）。

裁决改判为「基本成立，但不是每次」：若 `scheduleFlush(true)` 在首帧渲染之后才触发，IO 回调先到并复用这个 0 ms 定时器，没有延迟；定时器先触发（常见）才多等。复现用例固定了后一种时序。修它是恢复 `m2-page-translation.md:127` 的原意，不是新功能。修法：会话内尚未发过请求时，首次 IO 走 `scheduleFlush(true)`，约几十字节。

三项渲染小修合成一个 PR、三个提交，各带用例；等 PR6 合并后再从 main 拉分支，体积在 PR6 之上实测。

**实际修法（`fix/render-frame-gap-and-rescan`）**：
- 2.2 等帧空窗（`render.ts`）：`drops = new WeakMap<Unit, number>()`，`drop()` 在提前返回之前自增；`insert` 读阶段把代数记进每个计划，写阶段代数变了就跳过该单元（不算 stale，会话已遗忘它）；`note()`（`fail` 与 `skip` 共用）等帧前记、等帧后比对。原 `skipping` 集合由同一机制取代并删除，`skip` 的「块根离开页面 / run 末节点离开父元素」两道检查保留。
- 2.3 `known()`（`session.ts`）：不再调用 `isCurrent`。新单元刚从当前 DOM 分段出来，判断改为「同类型、同文本，run 再要求节点逐个相同」；块不比节点（与 `stillSame` 一致：块的子节点被换成同样内容的克隆时仍保留）。`mayBeHidden` 分支照旧用 `isCurrent`。
  - 与裁决的差异：没有另比 `seg.digest`。`digest` 就是 `text` 的哈希（`segment.ts`），原条件已比 `text`，再比摘要是冗余；只比摘要反而会在哈希碰撞时误认。
  - 补充：run 比节点前先滤掉 `et-tr`。行内译文与失败提示是 `display:inline`，加载点是 `inline-block`，但 `isInlineElement` 把 `inline-*` 一律视作行内，结论不变：它们重扫时会被并进 run 的 `nodes`（`segment` 忽略它们，文本不变），不滤会让每个已译 run 在重扫时都被当成新单元、删掉重插。
  - 补充：另加 `unit.root.isConnected` 前置判断，对应 `stillSame` 的第一道检查。
- 2.4 首批防抖（`session.ts`）：`eager` 标记在 `scan()` 建好视口观察器时置位，到第一次 `send()` 才清除；视口报告有新进入范围的段落时用 `scheduleFlush(eager)`。因此首屏没有要发的内容时，之后第一次进入范围的报告仍会立即发出；按住段落的局部会话升级为整页时同样经过 `scan()`，但若升级后先有别的 `send()`，就退回 50 ms 防抖。两种情况都不比改动前差。超过 500 条的回调分块处理（`onViewportChunked`），只在最后一块处理完后才按 `eager` 立即 flush，首屏跨块时仍合并成一次 flush、整体排序；中间块在非 `eager` 时照旧走防抖，不分块的路径不变。
- 用例：`render.test.ts` 4 条（等帧期间 drop 的 insert 与 fail、遗忘后继任单元同帧写入只留一份、同一单元两次 insert 同帧重叠、drop 后再 insert），`session.test.ts` 6 条（重扫未变单元不再分段且 `et-tr` 节点不变、块内元素换成相同克隆仍保留、run 节点换成相同文本节点视为新单元并从内存补回、块改文字与 run 增节点重新发送、首屏 0 ms 发出而后续仍防抖、首屏跨分块时在最后一块后合并为一次发送）。先红后绿（逐项换回 main 的实现）：4 红（等帧 2 条、分段次数 9≠5、首屏 0 条），等价性 3 条在 main 的 `known()` 上即绿（判断等价）；「照搬集合」替身让重叠两条变红；去掉 `et-tr` 过滤的替身让分段次数用例变红（8≠5）；跨分块用例在「每块都按 `eager` flush」的上一版上变红（只发出第一块的段落）。
- 体积：page-runtime 26.33 → 26.45 KB（gzip 26 958 → 27 086 B，+128 B），content 不变（7.60 KB）。

## 3. 其余核实要点

- 2.1 扫描阻塞（主体）：`discover.ts:62-138` 后序遍历整棵 body，`session.ts:961-983` 扫完才 `register`。实测首译额外延迟约为扫描 + IO 首次回调 + 50 ms：几千元素的页面不到 0.1 s；60 004 元素的 issue-1500 页 4x 降速下 0.9–1.2 s，接近或超过 m2 目标「Google 首批 ≤ 800 ms」。合成页样式极简，数值只能作下限。
- 1.1 的实际范围：`sse.ts:76` 收到任何字节（含 keep-alive 注释、role 块）就开始 60 s 空闲计时，只有完全静默的连接才占满 180 s。25–30 s 首包超时会误杀推理模型与开缓冲的反向代理，且误杀后会重发（`providers/errors.ts:16`），BYOK 用户为同一批付两次费。
- 2.3 Shadow DOM：Reddit 的帖子与评论正文通常在 slot 的 light DOM 里，YouTube 的 Polymer 内容可直接查询，「大片漏翻」夸大。子代理 `curl` 拉 Reddit 被拦截，未能真机核实。

## 4. 方案评估

### 4.1 方案一：LLM 整页流式逐段协议（部分采纳）

采纳：部分提交（逐段 settle，只对剩余段重试或二分）+ 约 40 行增量 JSON 扫描器（跟踪字符串、转义、花括号深度，每闭合一个顶层对象就 `JSON.parse` 并产出）。提示词、`PROMPT_VERSION` 与缓存键不变，已有整页缓存不失效。与 `final-plan.md:20,40`「整页不做流式」不冲突：那条指逐 token 写 DOM，之后用户已同意「整页逐段出现」（`known-issues.md:59`），这是在落实该待办，已逾期。

不采纳：
- XML nonce 协议：换协议使全部 batch 缓存失效，Gemini 未提及；其 4 位 hex nonce（65 536）弱于现有 `createNonce()` 的 16 位，「同级防伪」不成立。
- 首包超时：见第 3 节。
- 0 产出连续 2 次降级回 JSON：两套协议长期并存，测试面翻倍。
- 每 4 条或 100 ms 微批写缓存：渲染即时性来自 `deliver`，每次尝试结束统一写一次即可。
- 页面上下文（title / host）：并入 M4 `TranslateOptions`。与术语库同题；写进 system prompt 会让每页成为独立缓存命名空间，排除出 digest 又出现「上下文不同、缓存相同」；现有 system prompt 约 200 token，达不到前缀缓存的 1024 token；还会多向第三方发送页面标题。
- 单一调度中枢：涉及 Port 协议、session、调度器三层，收益未经测量。
- 首屏自适应小批（5 段 / 1200 字）：裁决改判为观察。子代理原判「采纳，放后台调度器」；裁决认为有了逐段产出，首段时间由首 token 决定，50 段请求在后台本就拆成 20/20/10 并行。方案一 PR① 真机测完首段时间再议。

**裁决写明的两条硬约束**（最被低估的风险）：现在 `decodeLlmOutput` 收齐整批后才校验条数、id 范围、重复，任何一项不对整批作废，错位译文不会落屏。逐段提交后，模型若把 id 整体偏移一位或调换顺序，前面的段已渲染到别的段落下面并写进缓存 7 天，到最后一项越界才发现，无法撤回。外部方案与子代理都只讨论了截断，没讨论 id 错位。
1. **顺序前缀规则**：只有 `i` 恰好等于下一个期望序号时才增量提交；第一次偏离后停止增量提交，剩余部分回到整批校验。
2. **缓存延后写**：只在本次尝试结束后写；正常结束或截断 / 中断时写入已提交的前缀；出现 id 异常时本批一条都不写缓存。

另：增量解析复用 `createThinkFilter`；补「部分完成后截止 / 取消 / 二分」的调度器用例（`expire`、`abandonIfOrphaned`、`split` 仍遍历 `job.segments`，需显式维护已结算集合或收缩 job 成员）。体积：background 57.78 / 60 KB，约 +0.6–1.0 KB。它是 M3e 的硬前置：M3e 要新增 provider，先定形再加。

### 4.2 方案二：Preact（页内不迁；Phase 1 暂不做）

实测（Vite alias 把 `react*` 指到 `preact/compat`，源码零改动，真实构建）：popup 83.28 → 25.53 KB，options 89.67 → 31.83 KB，各 −57.8 KB；alias 后 e2e `ui`、`session`、`page` 三个文件 19/19 通过。单测 131 个中仅 `hold-key.test.ts` 3 个失败（`act` 要改从 `preact/test-utils` 引入）。

页内不迁（裁决成立）：
- 框架固定成本 5.3 KB，命令式等价小组件 0.75 KB；page-runtime、selection-runtime 余量 1.8 / 0.8 KB，路线 A（三包各带一份）每包约 +3.5～+5 KB，立即超预算。
- 路线 B（合包）合计约 46–48 KB，只比现在省 5–7 KB（Gemini 写 −17 KB），且推翻 m2b 决策 1「按触发时机分包」，划词加载量从 18.2 KB 涨到约 31–33 KB。
- 弹簧每帧写 `clip-path`，在 Preact 里也只能用 ref 命令式写；「4388 行压到 1400–1800 行」不可信，估计减 20–35%。
- Phase 3 的 CSS `linear()` 替换弹簧违反「可打断、保留速度」的动效规范（`ui-isle-direction.md:64`）。

Phase 1 裁决改判：子代理结论是「做」；裁决为「暂不做，条件触发」。理由：弹窗从本地磁盘加载，打开耗时主要在窗口创建，省下的 58 KB 只占发布包 2.3%（包体 90% 是音标），收益只是预算余量。popup 自身业务 4.71 KB，预算余 6.72 KB，options 余 60 KB，M4 之前没有预算压力。代价：`onChange` 实际 25 处（子代理报告写 19），受控输入 10 处，含密钥输入框，依赖 compat 语义；`wxt dev` 热更新与 `typecheck` 未验证；偏离用户的 React 技术栈。
- 触发条件：popup 余量 < 3 KB，或 M4 设置页设计时预算告急（`check-size.mjs` 注释已写「超过 90 KB 先评估更轻的运行时」）。
- 届时以 spike PR 验收：完整 `npm run check` 与全量 e2e 通过、`typecheck` 不靠类型兜底、`wxt dev` 热更新可用、Select 与受控输入手测。
- 若用户想现在就拿预算：位置在 v0.5.0 之后、M4 设置页开工前，需批准新依赖 `preact`、`preact-render-to-string`。

### 4.3 方案三：Open Shadow DOM 穿透（只做测量 spike）

耦合点基本准确：`protectedAncestor`（`dom-rules.ts:227-234`）、`readHostDark`（`render.ts:86-106`）、`settle` 的 `root.contains`（`session.ts:700`，跨 shadow 恒为 false）、`toggleAt`（`:1045-1060`）、`sampleText`（`page-language.ts:17-33`）。遗漏与问题：
- 「宿主一律视为块边界」会打碎句子；行内宿主（如 GitHub `<relative-time>`，每分钟自更新）应保持现状，只穿透块级宿主。
- 漏了 `segment.ts`：shadow 内段落夹着 `<slot>` 时读到后备内容而非投影节点，送翻文本缺词，`restoreTranslation` 还会把 `<slot>` 克隆进 `et-tr`。
- 后挂载的 shadow root 发现不了；可靠做法（MAIN world 包装 `attachShadow`）已被 `m3d.md:28` 否决。
- 重扫频率上升，叠加 2.2b 的长任务更明显，须先修 2.2b。
- 体积估 +0.9–1.2 KB（Gemini 写 +0.7–1.0），M3c 期间 page-runtime 放不下。

测量 spike（约半天，CDP 脚本，结果写进 `docs/reviews/`，不进产物）：对 8 个站点（新版 Reddit、YouTube、GitHub、msn.com、lit.dev、一个 Salesforce / Shoelace 文档站、两个用户常用站）统计「只存在于 open shadow 内、且不经 slot 投影的可见正文字符占比」，区分块级宿主与行内宿主。
- 立项：≥ 2 个站点占比 ≥ 20%，或 Reddit / YouTube 任一 ≥ 30%，或收到用户反馈。否则关闭，记入 known-issues。
- 立项前置：2.2b 已修；page-runtime 有 ≥ 1.2 KB 余量。
- 立项后拆 3 个 PR：原语与 composed 回溯；扫描与渲染；交互。

## 5. 外部数字核对

| 项 | 实测 | Gemini | 判定 |
| --- | ---: | ---: | --- |
| content / page / selection / palette（gzip） | 7.55 / 26.03 / 18.19 / 9.12 KB | 同 | 准确 |
| popup / options | 83.28 / 89.67 KB（共享 chunk 78.57） | 同 | 准确 |
| 共享 chunk 里 React 全家 | 约 64–66 KB（单独打包 66.3） | 约 60–62 KB | 略低估 |
| Preact 固定成本 | core+hooks+jsx 5.34–5.68 KB；`preact/compat` 7.85 KB | 5.2 KB | 基本准确，未计 compat |
| 三个按需包重复打包 | 5–6 KB（brotli 大窗口上限 7.8 KB） | 11–14 KB | 高估约 2 倍 |
| `port.ts` 重复份数 | 2 份（palette 走 `deps.send`） | 三份 | 不准；`provider-icons.ts` 不在任何按需包里 |
| 页内路线 A 增量 | 每包约 +3.5～+5 KB | +1.2～+3.2 KB | 偏乐观 |
| 页内路线 B 合计 | 约 46–48 KB（省 5–7 KB） | −17 KB（−32%） | 偏乐观 |
| 音标 dict | 英 1407.9 / 美 796.5 KB；原始 7.18 MB；zip 2.52 MB 中 dict 2.28 MB（约 90%） | 2.2 MB+ | 准确 |
| 音标紧凑化 | 合并英美表 −7%，加键前缀压缩 −12%（单片最大 50 KB，超 40 KB 单片预算） | 约 400 KB | 只能靠砍词表（3 万词英音约 194 KB），等于退回 v4 决策 |
| 「SW 每次重启重新 fetch 解析 TSV」 | 不成立：每次取 1–3 个分片，LRU 每口音 128 片 | — | 不属实 |
| 源文件行数 | `card.ts` 2008、`isle.ts` 1425、`session.ts` 1157、`palette.ts` 955、`render.ts` 722 | 同 | 准确 |
| 逐段、批大小、重试数值 | `session.ts:97-103`（50 段 / 8000 字 / 6 在途）；调度器 LLM 20/3000、Google 50/5000 | 同 | 准确 |
| SSE LLM 空闲超时 | 60 s | 25–30 s | 不符 |
| 闭包内重复实现 | `node()` 三份、`adoptStyles()` 三份逐字相同、`readViewport()` 三份近似、`tipIn/tipOut` 两份 | 同 | 属实 |

## 6. 执行清单

| # | 分支 | 范围 | 依赖 | 体积影响 | 需用户批准 |
| --- | --- | --- | --- | --- | --- |
| 0 | `feat/m3c-isle-entry`（#74） | M3c PR6，不改范围 | — | page 26.18、content 7.60 KB | 已有 |
| 1 | `fix/batch-think-strip`（#75） | 2.1：batch 与 text 终稿剥离前导推理 + 13 条用例 + known-issues 记流式缺口 | 无，可与 PR6 并行 | background 实测 +0.07 KB（57.85 KB） | 否 |
| 2 | `fix/render-frame-gap-and-rescan`（已完成） | 2.2–2.4：drop 代数守卫、`known()` 不再重分段、首次 IO 不防抖 + 10 条用例；划掉 known-issues #57-2 | PR6 合并后拉分支 | page-runtime 实测 +0.13 KB（26.45 KB） | 否 |
| 3 | 原计划 PR3 → PR4 → PR5 | 不变 | — | 按 m3c 方案 | 新文案照旧先问 |
| 4 | 发版 v0.5.0 | 含 #1、#2 | #1–#3 | — | 打 tag 前问 |
| 5 | `feat/llm-batch-incremental` | 方案一 PR①：provider 逐项产出、调度器部分提交、只对剩余段重试 / 二分；带 4.1 两条硬约束；不改提示词与缓存键 | 先用 think 写方案并过审 | background 约 +0.6–1.0 KB（余 2.22） | 方案确认；若超 60 KB 需批预算 |
| 6 | `chore/shadow-dom-survey` | 4.3 的测量脚本与结论文档 | 无，可并行 | 0 | 认可门槛即可 |
| 7 | `refactor/overlay-coordinator` | ui-kit 源码去重 + 内存协调器（两个提交，先去重） | #5 已合并 | 三包持平或下降，content 不得增加（余 0.15 KB） | 否（需真机回归灵岛、卡片、指令台 Esc 与避让） |
| 8 | `perf/scan-streaming-register` | `discoverUnits` 的 `onFound` + 边扫边注册 + 大页面 e2e fixture，必带「每段只发一次」断言并报告总扫描时间 | #2；可与 M3e 并行 | page-runtime 约 +0.2 KB | 否 |
| 9 | M3e | 原计划；开工前实测 Translator API | #5 | 待方案 | 待方案 |
| — | `spike/preact-compat` | 仅在触发条件满足或用户要求时 | — | popup / options 各约 −58 KB | 新依赖 2 个、预算下调 |
| — | M4 / M5 | 页面上下文并入 `TranslateOptions`；词典与音标包重设计；新面板单独评估 Preact 与 popover | — | — | 届时 |

#5 是 M3e 的硬前置；#6、#7、#8 互不依赖，可按精力取舍，任何一项拖延都不应阻塞 M3e。#7 不进 PR6：PR6 已实现并记录了「不加接口，读 `data-et-rect`」（`m3c.md` PR6 实施记录，裁决改判：子代理原建议「协调器顺带放进 PR6」），且 PR4 还会加入第四个宿主 `ET-PICK`，等 PR5 合并后参与者齐全再做。

## 7. 用户决定（2026-11-24）

1. 同意在 v0.5.0 与 M3e 之间插入小批，全部排上：必做 #5（LLM 批量逐段提交 + 增量解析，先用 think 写方案并过审）；可选三项 #6 Shadow DOM 测量 spike、#7 浮层协调器重构、#8 边扫边注册也都排上。
2. Preact Phase 1 暂不做。触发条件：popup 预算余量 < 3 KB，或 M4 设置页设计时预算告急；届时按 4.2 的 spike 验收标准执行，新依赖仍需批准。
3. 认可 Shadow DOM spike 的立项门槛（4.3）。8 个站点里的两个常用站仍待用户指定。
4. 429 冷却的前端可见提示先观察、不加，等用户反馈。

仍待定：background 预算——#5 之后余量约 1.2–1.6 KB，M3e 若在后台新增 provider 可能要调 60 KB 上限，届时单独报批。

## 8. 不采纳清单

- 1.1 首字节超时：误杀推理模型与缓冲代理，并让 BYOK 重复计费；只在有真实反馈时给整页任务加 ≥ 90 s 的宽上限。
- 1.2 统一缓存键或 promote：文本带行内标签，实际重合极少；两种提示词的输出清洗规则不同。
- 1.3 重试风暴、单一调度中枢：重试风暴不属实；中枢重构收益未测。
- 1.5 清扫断点续扫：不是活锁，收益接近零。
- 2.2a 读阶段预读、2.2c `unitOf` 索引：实测 0.1–0.4 ms；只调用一次。
- 2.3 iframe `allFrames`：常驻预算余 0.15 KB，每个广告 frame 都要注入。
- 二.2 原生能力替换弹簧与布局：`linear()` 不能打断续速；popover 仅可在 M4 / M5 新面板单点试验。
- 二.3 `registerContentScripts` 零注入：需全站主机权限。
- 二.5 镜像式仅看译文：破坏结构选择器、锚点、IO 目标与 `dom-contract.md`。
- 方案一的 XML 协议、降级阶梯、页面上下文（并入 M4）、首包超时。
- 方案二的 Phase 2–4、页内路线 A / B：收益 5–7 KB 或为负，代价是推翻按触发分包并重写 UI 与测试。
- 音标改二进制或存 IndexedDB 求「约 400 KB」：只有砍词表才达得到。
