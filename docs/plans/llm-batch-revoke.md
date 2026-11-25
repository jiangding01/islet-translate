# AI 批量逐段显示：长度对照拦截与撤回重译（体验债小批 PR②）

> 状态：已实施（#待补，见文末「实施记录」）。方案第 2 稿，2026-11-25 用户批准（第 1 稿经 Opus 对抗式审查，结论「需修改后批」，1 条阻断与 6 条重要项已改，见文末「审查记录」）。依据：PR①（#83，`docs/plans/llm-batch-incremental.md`）的残余风险与 `docs/known-issues.md` 第 4 节两条已知限制；用户 2026-11-24 选方案 A：PR① 合并后紧接着做本 PR，不改提示词，须在下次发版前上线。

## 目标
PR① 之后，AI 批量翻译一段完成就先显示。模型合并或漏掉一段、但编号仍连续时，错位的译文会先显示到别的段落下面；整批校验失败（`validation/bad-response`）后也撤不回，要点「显示原文」或刷新才消失。本 PR：
1. **撤回重译**：整批校验失败时，页面自动撤下这一批提前显示过的译文，并重新翻译这些段，不需要用户操作；
2. **长度对照拦截**：在提前显示前粗查一次「译文长度与原文是否大体相当」，明显对不上就停止这一批的提前显示，减少错位出现的次数。

**成功标准**
- 一批以 `bad-response` 结束时，这批里已经显示的每一段在页面上被撤下（回到原文并显示加载点），随后显示正确的译文；页面内存里该错译的记录被清掉，同一句话在别处显示的同一份错译也一并撤下。框架重渲染导致原 unit 已被遗忘时，内存里的错译也要清掉。
- 撤回后的重译单段成批（1 段 1 批），且单段批永不撤回，所以不会无限循环。
- 划词卡片、快速翻译、Google 引擎、缓存规则（只缓存校验通过的结果）都不受影响。
- 不改提示词、`PROMPT_VERSION`、缓存键。

## 现状（调研结论）
```
后台 scheduler.execute（一次尝试）
  item 到达 → pairs.push({segment,text}) → 移出 job → resolveSegment：release 去重表 → deliver（每个订阅者拿同一个 outcome）→ 清空订阅者
  尝试结束 → result（ok / 各类错误）→ ok 才 persist → observeCooldown → handleResult（剩余段重试/二分/超时）→ 等 fetch 真正结束
         ▲ bad-response 时无从通知已分发段的请求
service.run：outcome resolve 就 emit {id, 译文}；全部 outcome 结束 → done
port：done 之后客户端删掉 pending，迟到的帧直接丢弃（port.ts:276-277）
页面 session.send 的回调：sent.delete → 失败/非 translated 分支 → translations.set(原文→译文) → queueRender（16 ms 合批）
```
- `finishBatch` 在「整批解析成功但与已提交不一致」「疑似草稿」时，现在会先补交其余段再抛 `bad-response`（PR① 审查 I3）。有了撤回，补交的段多半也要撤，补交反而多闪一次。
- 页面撤回需要的原语都已存在：`renderer.drop`（摘掉译文与加载点，并让等帧中的写入作废）、`want`、`showNow`。

## 方案

### 1. 后台：已分发段的裁决（`scheduler.ts`）
- 页面批量任务（LLM、非 stream）提前分发的每一段，outcome 上多带一个 `verdict: Promise<boolean>`：这段最终是否保留。`resolveSegment` 给每个订阅者的是同一个 outcome，所以每个请求、每个标签页都拿到同一个裁决。
- **在 `execute` 拿到 `result` 之后、`persist`/`observeCooldown`/`handleResult`/等 fetch 结束之前**，为本次尝试的全部已分发段 resolve 裁决，并用 `finally` 兜底，保证任何结束方式（成功、截断、中断、网络、限流、超时、取消、全部订阅者离开、`expire`、二分后的半份 job）都会 resolve：
  - 结果是 `validation/bad-response`，且本次尝试的成员多于 1 段 → 先把这些段的 key 写入「刚撤回」集合，再 resolve `false`（撤回）；
  - 其他情况 → `true`（保留；只是不写缓存，规则同 PR①）。
  - **单段 job 永不撤回**：只有 1 段时不可能错位，草稿或不一致最多是译文质量差，裁决恒为 `true`。这从根上消除了「撤回 → 重译 → 再撤回」的循环。
- **刚被撤回的段单独成批、优先发出**：「刚撤回」集合是一个 `Set`，满 500 条时整个清空（不做 LRU）。之后提交的段命中集合时，每段单独成一个 job，并 `enqueue(job, true)` 排到该调用方队首，避免排在已有的大批后面、加载点挂几十秒；命中后从集合删除。代价：一批 20 段被撤回时，最多变成 19 次单段请求，每次都带完整系统提示词。
- Google 引擎（`adapter.kind !== 'llm'`）与 stream（text）任务不带裁决、不进集合。disposition 不是 `translated` 的段（例如判为无需翻译）不发撤回。

### 2. 后台：收尾不再补交（`codec.ts` 的 `finishBatch`）
- 「整批解析成功但与已提交不一致」「疑似草稿（draft）」两种情况：**不再补交其余段**，直接抛 `bad-response`。其余段按现有规则二分重发（批更小，更不易错位）；已提交的段由第 1 节撤回。
- 其他分支不变。

### 3. 后台：发出撤回（`service.ts` + 协议）
- `TranslateChunk` 联合类型新增 `{ id: string; revoked: string }`，`revoked` 是被撤回的那份译文（页面用它判断内存记录是否就是这份错译）。
- service 收到带 `verdict` 的成功 outcome：照旧立即 emit 译文；随后等裁决（与请求取消信号竞争，取消或 Port 断开时立即放行），裁决为 `false` 就 emit `{ id, revoked: 译文 }`。该 item 在裁决出来后才算结束，所以 `done` 一定排在撤回帧之后。
- 只对页面整页请求发撤回帧。划词卡片与快速翻译走 stream、用文本提示词，缓存 key 不同，不会与页面请求共用 segment；`selection/request.ts` 只需在类型收窄上认出新成员（最终帧之后的 `finished` 守卫本来就挡住多余帧），不增加运行时代码。

### 4. 页面：撤回与重新排队（`session.ts`）
撤回帧在 `send()` 的回调里处理，**放在 `sent.delete(unit)` 之前**（否则会把已经重排、正在路上的同文 unit 移出 `sent`，导致重复请求）：
1. 原文从 `send()` 闭包里按 id 取（本次请求的 items），不经过 `byId`，这样 unit 已被框架重渲染遗忘时也能处理内存。
2. 帧对应的 unit 如果还在页面上、且仍显示或排队着这份译文（`renderer.has` 且不是失败，或在 `queued` 里）：**无条件撤下**（不看内存表现在是什么）。
3. 内存表 `translations` 里这段原文对应的正是 `revoked` 时：删除这条记录，并撤下同一原文中**已显示或排队**这份译文的 unit。`pending`、`sent`、`waiting`、`failed`、`settled` 里的同文 unit 一律不动（它们没有显示这份错译）。
4. 「撤下」一个 unit：从 `queued` 移除，并清掉 `toRender` 里它的旧条目（否则 16 ms 内重新入队时旧条目会先被渲染）；`renderer.drop(u)`。
5. 重新排队：被撤下的 unit 一律 `want(u, true)`（显示过译文的段不该再被单行锁定规则挡住；整页与局部会话同一写法），在视口内的立即显示加载点。被按住排除、在已排除区域内的 unit 只撤下、不重排。
6. `scheduleFlush()`、`report()`。
不需要页面侧的次数表：单段 job 永不撤回（第 1 节），重排的段一定单段成批。

### 5. 长度对照拦截（`codec.ts` 的扫描器）
在扫描器提交一段之前（回声压住之前）计算「加权长度比」，明显不对就**关闭本批的提前提交**（之后交给整批校验，与 PR① 的偏离规则一致），并把扫描器标为「可疑」：
- 加权长度：去掉行内标签 `<tN>`、零宽字符、空白后，拉丁字母与数字记 1，汉字记 3，假名记 1.5，谚文记 2，其他字符记 1。常见语言对（英↔中、英↔日、英↔韩、中↔日）的正常比值都落在 1 附近。
- 两条规则，任一成立就关闭：
  - **绝对**：`max(原文, 译文)` 加权长度 ≥ 30 时，比值 < 1/3 或 > 3。用 max 而不是两者都 ≥ 30，是为了挡住最常见的合并：短标题并进下一段。
  - **相对本批**：已提交 ≥ 3 段后，比值 < 前面各段比值中位数的 1/2，或 > 中位数的 2 倍。语言对的系统性偏差在同一批里相互抵消，这条最灵敏。两段长度相近时合并后比值约为 2，可能检不出来；但之后的错位项比值是相邻段长度之比，网页段长分散，一般 1–3 项内触发。
- **可疑之后流出错**：扫描器因长度对照关闭后，如果流随后以截断、中断、超时等错误结束，provider 像处理受污染一样改抛 `bad-response`，让已分发段走撤回。正常结束时照常整批校验。
- 误判的代价只是这一批不再提前显示，不会出错。代码、URL 两边不变，比值趋近 1；日文汉字计 3 后与英文接近 1；西里尔文、阿拉伯文计 1 也合理。

### 6. 不改的部分
提示词、`PROMPT_VERSION`、缓存键、缓存规则（只缓存校验通过的结果）、批大小与并发参数、`TranslateDone` 结构、Google 引擎、划词卡片与快速翻译的行为。

## 数据流
```
provider ──item──▶ scheduler ──outcome{ok,text,verdict}──▶ service ──{id,text}──▶ 页面渲染
                       │ 尝试结束：bad-response 且成员 > 1?        │ await verdict（与取消竞争）
                       ├─ 是 → key 入「刚撤回」集合 → verdict=false └─ false → {id,revoked:text} ──▶ 页面撤下 + 重排
                       └─ 否 → verdict=true                                       │
页面重排的段 ──新请求──▶ scheduler：key 在集合中 → 单段成批、排队首 → 单段永不撤回  ◀┘
```
没有环：重排只发新请求，且一定是永不撤回的单段批。

## 拒绝的做法
- **让 AI 每段带回原文开头几个词逐段核对**：要改提示词，全部批量缓存失效，每批多 5–10% 输出 token；用户已否决。
- **撤回后不重译、只恢复原文**：用户还得手动重试。
- **页面按次数上限兜底（第 1 稿）**：改为「单段 job 永不撤回」后循环不可能发生，次数表多余。

## 残余风险（写进已知问题）
1. **出错前缀留在页面**：模型合并错位后、整批结束前，流因截断、中断、超时、取消而结束，且长度对照没有触发，则裁决为保留，错位前缀留在页面上（不写缓存）。要点「显示原文」或刷新。
2. **后台重启丢帧**：Service Worker 在裁决出来前重启，Port 断开，撤回帧丢失，错位译文留在页面（不写缓存）。
3. **长度相近的错位**：相邻段长度相近时，长度对照检不出来，只能等整批校验后撤回；用户会看到错译闪现几秒。

## 改动清单（约 11 个文件，超过 8 个）
| 文件 | 改动 |
|---|---|
| `src/lib/translate/codec.ts` | `finishBatch` 不一致与 draft 时不补交；扫描器加长度对照与「可疑」状态；`ItemOutcome` 加可选 `verdict` |
| `src/lib/translate/providers/openai-compat.ts`、`gemini.ts` | 可疑之后流出错改抛 `bad-response`（与受污染同一处判断） |
| `src/lib/translate/scheduler.ts` | 已分发段的裁决；「刚撤回」集合、单段成批、排队首 |
| `src/lib/translate/service.ts` | 等裁决、发撤回帧 |
| `src/lib/messaging/protocol.ts` | `TranslateChunk` 新增撤回帧类型 |
| `src/content/session.ts` | 撤回、清内存、重排 |
| 对应测试：`codec`、`openai-compat`、`gemini`、`scheduler`、`service`、`session` | 见「测试」 |
| `docs/known-issues.md`、`CHANGELOG.md`、`HANDOFF.md`、本方案、PR① 方案的残余风险 | 已知限制改为已修复、记录新的残余风险 |

## 测试
- **codec**：
  - 加权长度的表驱动用例（英、中、日、韩、混排、行内标签、零宽字符、西里尔文）；
  - 绝对规则：比值 < 1/3、> 3 时关闭；短标题（原文 < 30、译文 ≥ 30）并进下一段时关闭；两边都短时不判；
  - 相对规则：前 3 段正常、第 4 段偏离中位数 2 倍以上时关闭；
  - 长度对照关闭后状态为「可疑」；
  - `finishBatch` 在不一致、draft 时不补交，直接抛 `bad-response`。
- **provider**：可疑之后流截断、中断时改抛 `bad-response`；未可疑时保持原错误。
- **scheduler**：
  - 多段 job 以 `bad-response` 结束时，已分发段的裁决为 false，且 key 在 resolve 前已进集合；
  - 其他每一种结束方式（成功、截断、中断、网络、限流、`expire`、全部订阅者离开、取消、二分后半份 job）裁决都为 true，且一定 resolve；
  - 单段 job 以 `bad-response` 结束时裁决为 true；
  - 命中集合的段单段成批、排队首，并从集合删除；集合满 500 条时清空；
  - Google 与 stream 任务不带裁决；disposition 不是 translated 时不撤回。
- **service**：裁决为 false 时依次 emit 译文、撤回帧、done；裁决为 true 时不发撤回帧；请求取消或 Port 断开时不挂起。
- **session**：
  - 撤回帧：撤下对应 unit、清内存、同文已显示或排队的 unit 一并撤下；
  - 内存已是正确译文时，帧对应的 unit 仍被撤下，内存不删；
  - 帧对应的 unit 已被遗忘（重渲染）时，内存里的错译被删，新 unit 不会从内存读出错译；
  - 同文 unit 在 pending、sent、waiting、failed、settled 时不动；撤回分支在 `sent.delete` 之前；
  - 等帧写入中的译文被作废，`toRender` 旧条目不再渲染；
  - 重排：整页在视口内（立即显示加载点）、视口外、局部会话、单行锁定的段、按住排除与排除区域内（不重排）。
- **集成（替代 e2e）**：service 层用真实调度器加分块 SSE：错位的一批先显示，随后收到撤回帧，重发的段单段成批并得到正确结果，最后 done。
- 全部跑 `npm run check` 与 `npm run test:e2e`。

## 真机验收（需要已配置密钥的 AI 服务）
- 正常长文章：逐段出现，与 PR① 相同，不出现无故撤回或闪烁。
- 错位较难人为触发，以单测与集成测试为准。若真机遇到错位，应看到错误译文被撤下、几秒内换成正确译文。

## 体积
- background 现在 58.92 / 60 KB，审查估计 +0.6–0.7 KB，大概率仍在 60 KB 以内。超出时先瘦身；瘦身后仍超出，再向你申请把 background 预算提到 62 KB（M3e 新增本地引擎时本来也可能要调）。
- page-runtime 26.97 / 28 KB，预计 +0.3–0.5 KB，在预算内。selection-runtime、palette-runtime 不变。

## 回滚
revert 本 PR 即可。不改缓存键与存储结构；同一扩展版本内后台与页面一起更新（扩展更新后旧页面失联并停止，不会出现新旧版本混用）。

## 审查记录（第 1 稿，Opus 对抗式审查，2026-11-25）
| # | 发现 | 处理 |
|---|---|---|
| B1 | 按「内存译文」决定撤不撤会漏撤；按 `byId` 找 unit 在重渲染后丢帧，内存里的错译还会被新 unit 读出 | 采纳：原文从 `send()` 闭包取；帧对应 unit 无条件撤；内存正是错译时删除并撤同文已显示或排队的 unit |
| I1 | 裁决 resolve 位置与顺序 | 采纳：拿到 result 后、persist 之前，finally 兜底；先入集合再 resolve(false) |
| I2 | 单段批再遇 bad-response 会先撤回再失败 | 采纳：单段 job 永不撤回，去掉页面次数表 |
| I3 | 重排的单段 job 排在队尾，加载点挂很久 | 采纳：`enqueue(job, true)`，并写明最多 19 次单段请求的代价 |
| I4 | 撤回分支须在 `sent.delete` 前；`toRender` 旧条目；重排用 `want(u, true)` | 采纳 |
| I5 | 缺「残余风险」；长度对照触发后流出错仍保留错位前缀 | 采纳：长度对照关闭后标为可疑，之后流出错改抛 bad-response；补残余风险一节 |
| I6 | 「两者都 ≥30」漏掉短标题并进下一段 | 采纳：绝对规则改为 `max(原文, 译文) ≥ 30` |
| S | 500 条 LRU 改满了清空；非 translated 不发撤回；selection 不需运行时改动；同文 settled、failed 不动 | 采纳 |

## 实施记录（2026-11-25，#待补）

### 范围
按第 2 稿第 1–5 节实现，「审查记录」B1、I1–I6、S 的处理全部落地。改动 `codec.ts`、`providers/openai-compat.ts`、`providers/gemini.ts`、`scheduler.ts`、`service.ts`、`messaging/protocol.ts`、`content/session.ts`；`content/selection/request.ts` 只加了一处类型断言（没有运行时分支）；`echo.ts` 只把行内标签正则改为导出，供加权长度复用。测试改 `codec.test.ts`、`openai-compat.test.ts`、`gemini.test.ts`、`scheduler.test.ts`、`service.test.ts`、`content/session.test.ts`。提示词、`PROMPT_VERSION`、缓存键、缓存规则、批大小与并发参数、`TranslateDone` 都没有改。

### 代码要点
- **长度对照**（`codec.ts`）：新增 `weightedLength`（去掉行内标签后，用一次 `replace` 按书写系统计数：汉字 3、假名 1.5、谚文 2，空白与零宽字符不计，其他 1）。扫描器在 `take` 里、回声压住之前算「译文 / 原文」加权长度比：`max(两边) ≥ 30` 且比值 < 1/3 或 > 3；或者这一项是「长项」（`max(两边) ≥ 15`），且前面已接受的长项 ≥ 3 个，比值 < 它们上中位数的 1/2 或 > 2 倍（check 第 1 轮加了长项门槛，短项不计入中位数、也不参与判定），就不提交这一项并把状态置为新增的 `suspect`（之后不再提交；`</think>` 等仍可把它升为 `tainted`）。
- **`finishBatch`**：先做一致性与 `draft` 检查，不一致或 `draft` 时直接抛 `bad-response`，不再补交其余段；通过后才补交未提交的段。整批解码失败时，扫描器为 `tainted` 或 `suspect`（共享判断 `doubtful`）改抛 `bad-response`，其次才是数组未闭合的 `output-truncated`（check 第 1 轮）。
- **provider**：读流期间出错时，扫描器为 `tainted` 或 `suspect`（`doubtful`）都改抛 `bad-response`（同一处判断）。
- **调度器**：LLM 页面任务在 `execute` 里为本次尝试建一个裁决 Promise，提前分发的成功 outcome 带上 `verdict`。在 `try/catch` 的 `finally` 里（拿到 result 之后、`persist`/`observeCooldown`/`handleResult`/等 fetch 结束之前）决定：结果为 `validation/bad-response` 且尝试开始时成员 > 1 段，先把已分发段的 key 写入「刚撤回」集合（满 `REVOKED_LIMIT` = 500 条时整个清空再加），再 resolve `false`；其余一律 `true`。`submit` 时，非交互任务里命中集合的新段从集合删除，每段单独成 job 并 `enqueue(job, true)`；交互任务沿用同一条「单独成批、排队首」路径。Google（`kind !== 'llm'`）与 stream 任务不带裁决，也从不进集合；`submit` 对非交互的任何 adapter（包括 Google）都会执行 `revoked.delete`，Google 的 key 不会在集合里，查了也无害。
- **service**：成功 outcome 照旧立即 emit；带 `verdict` 且 disposition 为 `translated` 时，等 `Promise.race([verdict, 取消])`，结果为 `false` 就 emit `{ id, revoked: 译文 }`。取消信号（含 Port 断开）在提交前挂一个监听，立即放行。item 在裁决之后才结束，`done` 一定排在撤回帧之后。
- **协议**：`TranslateChunk` 新增 `{ id: string; revoked: string }`。
- **页面**（`session.ts`）：撤回帧在 `send()` 回调里、`sent.delete` 之前处理；原文从本次请求的 `items` 按 id 取。`shows(u)` = `renderer.has(u)`（不含失败、过长提示）或在 `queued`，或在新增的 `writing`（已交给 `renderer.insert`、等帧写入的 unit；`insert` 结束时用 `.finally` 清掉，写入失败也清，`forget` 里同样清）。帧对应的 unit 满足 `shows` 就撤；内存正是 `revoked` 时删除记录，并撤同文中满足 `shows` 的 unit。撤下：移出 `queued`，删掉 `toRender` 里它的旧条目，`renderer.drop`（让等帧写入作废）；然后 `want(u, true)`，返回 true 且在视口内就 `showNow`；按住排除、排除区域内的由 `want` 挡住，只撤不排。最后 `scheduleFlush()`、`report()`。每个请求另维护局部集合 `open`（还欠最终帧的 unit），处理译文、非 translated、错误这三种最终帧时移出，撤回帧不动它；请求结束时只把 `open` 里且仍在 `sent` 的 unit 当作「没回答」（check 第 1 轮，见下表 I1）。

### 测试
- 实现前跑 `src/lib/translate/` 与 `src/content/session.test.ts`：**71 failed / 737 passed（808）**（基线 731 条全部通过）；新增 77 条，改了预期的既有用例 6 条（见下）。之后补了 1 条调度器用例「裁决先于其余处理」（为变异检查补，实现前同样会失败），第一次实现后完整 `npm run check` 的单元测试为 89 个文件、2325 条全部通过；check 第 1 轮修复后为 2343 条（见下表）。
- 新增：codec 加权长度表（含行内标签、零宽字符、西里尔文）与常见语言对比值、绝对规则（< 1/3、> 3、短标题并进下一段、两边都短不判、恰好 3 与 1/3 不判）、相对规则（2 倍上下、中位数而非均值或上一项、第 4 项起才生效、回声计入）、`suspect` 状态、`suspect` 正常结束仍整批校验；provider 两家各 3–4 种流出错在 `suspect` 后改抛 `bad-response`；调度器撤回、先入集合再 resolve、单段成批排队首且只生效一次、单段永不撤回（含重试剩 1 段）、7 种结束方式与全部订阅者离开都保留、二分半份各自裁决、500 条清空、Google 与 stream 无裁决；service 撤回帧顺序、保留不发、非 translated 不发、取消与 Port 断开不挂起，以及**集成用例**（真实调度器 + 分块 SSE：错位一批先显示 → 撤回帧 → `done`；再请求时两段各自单段成批、得到正确译文）；页面 14 条（见方案「测试」一节逐条对应，另加「等帧写入作废」「迟到的撤回帧不把在途 unit 移出 `sent`」）。
- 改了预期的既有用例：`finishBatch` 不一致与三种 `draft` 情形改为不补交（codec 2 条、两家 provider 各 1 条）；`service.test.ts`「splits an LLM batch whose item count does not match」现在第一段先显示、随后收到撤回帧；调度器测试的 `ok()` 改为 `objectContaining`（LLM 结果多了 `verdict`）。扫描器「每个切分点」用例的第 4 段原文曾改为 `Dee` 以绕开相对规则，check 第 1 轮加了长项门槛后改回 `d`。
- **变异检查**（逐项改坏、跑对应测试、还原并核对源码与改前快照一致）：去掉单段永不撤回 2 条失败；去掉 `finally` 里的裁决 22 条；裁决挪到等 fetch 结束之后 1 条（补用例前 0 条）；集合写入推迟到 resolve 之后的微任务 2 条；`submit` 不查集合 4 条；撤回段不排队首 4 条；集合满了不清空 1 条；Google 也带裁决 1 条；绝对规则去掉 max（只看原文 ≥ 30）9 条；去掉绝对规则 11 条；去掉相对规则 5 条；长度对照只关闭不标 `suspect` 16 条；汉字记 1 13 条；行内标签计入长度 2 条；`finishBatch` 改回先补交 7 条；OpenAI / Gemini 不把 `suspect` 改抛 4 / 3 条；service 不与取消竞争 2 条；非 translated 也发撤回 1 条；不等裁决（放到后台发帧）3 条；页面撤回分支放到 `sent.delete` 之后 1 条；帧对应 unit 只在内存相同时才撤 2 条；不扫同文 unit 2 条；原文改从 `byId` 取 1 条；不清 `toRender` 1 条；不跟踪 `writing` 1 条；`want(u)` 不带 `chosen` 1 条；不立即显示加载点 2 条；内存不删 11 条；同文扫描不看 `shows`、撤所有同文 unit 1 条。
- **检不出的两项**：把 resolve 放到 `persist`/`handleResult` 之后、但仍在同一个同步块里，以及同一同步块内「先 resolve 再写集合」，都没有用例能区分——Promise 回调总是异步执行，同步块内的先后对订阅者不可见。用例锁住的是「resolve 之前不能有 `await`」。

### 验证
`npm run check` 全部通过（lint 只有 `options.module.css` 一条既有的 specificity 警告；单元测试 89 个文件、2343 条通过，check 第 1 轮修复后；第一次实现时为 2325 条）；`npm run test:e2e` 通过（14 个文件，81 passed、2 skipped，两次相同）。没有新增 e2e（e2e 的网络 mock 一次性返回整个响应，无法模拟分块到达），撤回链路由 service 层集成用例覆盖。

### 体积
gzip，`npm run check:size`：background 59.40 / 60 KB（比 main 的 58.92 KB 多 0.48 KB），page-runtime 27.14 / 28 KB（多 0.17 KB），其余不变。预算未改。第一次实现时为 59.42 / 27.12 KB；check 第 1 轮修复（未做体积微调时）为 59.43 / 27.14 KB，两处体积微调后 background 回到 59.40 KB。

### 与方案的偏差与取舍
- **「排队」包括等帧写入**：方案的判定写的是「`renderer.has` 且不是失败，或在 `queued` 里」，但 16 ms 合批计时器触发后、渲染器等帧写入前，unit 两者都不满足，「等帧写入中的译文被作废」这条测试会失败。新增 `writing` 集合跟踪这段时间，`shows` 把它算作「排队着这份译文」。
- **相对规则的「已提交 ≥ 3 段」按已接受的长项计**：回声先压住的长项（比值恒为 1）也计入「前面各段」与段数；短项一律不计（check 第 1 轮）。中位数取上中位数（偶数个时取较大的一个，为省字节）。
- **`suspect` 之后流正常结束、数组没写完**：第一次实现按「正常结束时照常整批校验」处理，仍报 `output-truncated`、裁决为保留。check 第 1 轮由协调者决定，已按此处理：`finishBatch` 解码失败时把 `suspect` 与 `tainted` 同等对待，改抛 `bad-response`，已提前显示的段撤回（Gemini 没有终止符、OpenAI 收到 `[DONE]` 两种情形都有用例）。
- **disposition 判断放在 service**：调度器不知道 disposition，「非 translated 不发撤回」在 service 里判断；这类段的 key 仍会进「刚撤回」集合，下次同文请求单段成批，无害。
- **同文扫描不比对显示的文本**：渲染器不暴露已显示的译文，内存正是错译时，同文中已显示或排队的 unit 一律撤下重排。极少数同文 unit 显示的是更早另一份译文时会多重译一次。
- **报错文案**：provider 读流出错与 `finishBatch` 解码失败时，`tainted` 与 `suspect` 共用 `Doubtful output`（原为 `Draft output`）；只用于日志，错误码不变。`finishBatch` 一致性与 `draft` 两条文案不变。
- **写入失败的处理**：`renderer.insert` 失败（reject）时，现在除了清掉 `writing`，还把这次失败吞掉（不再成为未处理的 rejection），之后不做别的事；写入失败本来就什么都没显示。
- `CHANGELOG.md` 未发布段落里 PR① 条目原写「已提前显示的段落撤不回……将由后续版本修复」，同批发布，改为指向本条修复。

## 审查修复（check 第 1 轮，2026-11-25）
结论：无阻断，2 条重要、2 条低，外加体积与文档。先写用例再改：改前跑 `src/lib/translate/` 与 `src/content/session.test.ts` 为 **21 failed / 806 passed（827）**，另有 1 个未处理错误（L2 用例里写入失败的 rejection 没人接）；改后全部通过，完整单元测试 2343 条。新增 18 条用例。

| # | 发现 | 处理 |
|---|---|---|
| I1 | 撤回后重发的 unit 会被原请求的收尾路径移出 `sent`：原请求以 done 结束时撤掉加载点、之后重复请求，cancelled 时重复发送，error 时标为失败或 waiting | 每个请求维护局部集合 `open`（还欠最终帧的 unit），译文、非 translated、错误三种最终帧时移出，撤回帧不动；收尾时改为 `batch.filter((u) => open.has(u) && sent.has(u))`。done、cancelled、error 各一条回归用例（断言该段只发了两次，且第二次请求的译文能正常显示） |
| I2 | 相对规则在真实网页上频繁误判短段（审查者 8 组真实形态、译文全对的批次里 7 组判为 `suspect`，如 `FAQ→常见问题`、`OK→确定`），逐段显示大量提前关闭，之后网络抖动还会撤回正确前缀 | 只有加权 `max(原文, 译文) ≥ 15` 的长项计入中位数、也才参与判定。8 组真实批次写成正式用例，断言全部提交、状态为 `closed`；相对规则用例换成 20 加权长度的段落，另加「短项不计入」与「真实长段落里两段合并仍被拦下」两条；「每个切分点」用例夹具改回 `d` |
| L1 | 偏差 3：`suspect` 后流正常结束但数组没写完，仍报 `output-truncated`、保留错位前缀 | 协调者决定按此处理：`finishBatch` 解码失败时 `suspect` 与 `tainted` 同等对待（共享判断 `doubtful`），改抛 `bad-response`。用例：codec 一条，OpenAI 收到 `[DONE]`、Gemini 没有终止符各一条，调度器用真实 OpenAI 适配器一条（已分发段裁决为 `false`）。原「`suspect` 正常结束仍整批校验」用例换成长文本夹具 |
| L2 | `writing` 只在 `insert` 成功时清理 | 改用 `.finally` 清理，写入失败也清，并把失败吞掉；`forget` 里同样清。用例：模拟 `renderer.insert` reject，之后撤回帧不再把这个什么都没显示的段当作「排队中」去重排 |
| 体积 | background 只剩 0.58 KB | `median` 改为上中位数（省掉求平均）；`weightedLength` 改为一次 `replace` 计数（代替每个字符三次 `test`），`echo.ts` 不再导出零宽字符正则。行为与用例不变。background 59.43 → 59.40 KB，page-runtime 27.14 KB 不变 |
| 文档 | PR① 方案残余风险段同时有「将由 PR② 解决」与「已实施」；实施记录「Google 不查也不进集合」不准；已知问题残余风险第 1 条与修复后行为不符 | PR① 方案该段改为终态写法；实施记录改为「Google 从不进集合，`submit` 对任何非交互 adapter 都会 `revoked.delete`，无害」；`known-issues.md` 第 4 节残余风险第 1 条按 L1 后的行为改写（长度对照已触发时截断、中断、超时、数组没写完都撤回；未触发时保留；取消不发撤回帧）。实施记录各数字已同步 |

**变异检查**（改坏、跑对应测试、还原并核对与改前快照一致）：去掉 `open` 过滤 3 条失败；去掉长项门槛 12 条；`finishBatch` 解码失败时 `suspect` 不改抛 4 条；写入失败时不清 `writing` 1 条。

本方案正文第 87 行的残余风险第 1 条保留批准时的写法，修复后的实际行为以 `docs/known-issues.md` 为准。

