# M3d PR-C：过长段落的占位与计数

> 状态：已合并（#57，2026-11-19）。方案按 Fable 5.2 的 UI 裁决重写，经两轮 Opus 对抗式审查后修订，用户批准。上一版（onLong 回调 + `longByRoot` 计数、灵岛引擎按钮说明）经 Opus 对抗式审查，其中判断顺序、`classifyText`、字母计数写法、测试写法与已知限制的结论在本版保留。总方案见 `docs/plans/m3d.md`（C 行，决定 3）；问题来源 Codex 评审第 6 条（`docs/reviews/2026-11-18-codex-review-verification.md:13,32`）。

## 问题（行号为 main `7039399`）
1. **超长段落被静默丢弃**：`src/content/text.ts:15` 定义了 `MAX_UNIT_CHARS = 5000`。`isTranslatableText`（`:23-29`）先折叠空白，`length > 5000` 时直接返回 false（`:25`），之后才判断字母数（`:26-27`）和 `NOT_PROSE` 噪声（`:28`）。唯一的调用点是 `discover.ts:53` 的 `makeUnit`，它按 `seg.plain`（纯文本、空白已折叠）判断，不通过就返回 undefined。这一段不产生单元，页面上没有任何痕迹，用户以为漏翻了。
2. **判断顺序会把噪声算成超长**：长度判断排在噪声判断之前，一个 6000 字符的长 URL 或纯数字表会被当成「超长」。要标记，必须先排除噪声。
3. **上一版用回调计数的问题**：超长段不产生 Unit，`unitsByRoot` 的去重（`session.ts:625-650`）、遗忘（`forget`，`:661-687`）和清零（`clearState`，`:721-745`）都管不到它，只能另建一套 `longByRoot` 并手工对齐：B2 暂存的变更扫完后会再重扫一次（`:843-848`）；`onDirty → void rescan` 没有串行化（`:829`、`:847`）；discover 先检查 `cancelled`（`discover.ts:67`）再 `await pace`（`:69-72`），stop 落在让出期间时旧扫描还会回调一次。本版改为把超长段登记成「不发送的 Unit」，这三处自然由现有机制处理（见方案第 9 条）。

发送侧的长度上限都不丢段落，不在本 PR 范围内：
- `session.ts:81` 的 `BATCH_CHARS`：超长单项会单独成一批；
- `protocol.ts:137` 的单次请求上限（`TRANSLATE_PAYLOAD_LIMITS`）；
- 各服务商的 `chunkByLimits`；
- 划词的 2000 上限（`selection/watch.ts:15`、`selection/request.ts:19`）。

## 方案

### 1. `text.ts`：分类
新增 `classifyText(plain, sentLength): 'ok' | 'noise' | 'long'`，签名写死为两个参数：噪声与字母数按 `plain`（`seg.plain`，纯文本），长度按 `sentLength`（`seg.text.length`，即实际发送的文本；行内 `code`、`kbd` 在其中只是 `<tN/>` 标记）。依次判断：
- `plain` 折叠并 trim 后为空、字母少于 2 个、命中 `NOT_PROSE`（`:4-13`）：返回 noise；
- `sentLength` 超过 `MAX_UNIT_CHARS`：返回 long；
- 其余：返回 ok。

理由：夹着一个超长行内 `<code>` 的短段落，发送文本很短，不该被标「过长」。`isTranslatableText` 删除：改完后只剩 `discover.test.ts:210-228` 的用例在用，这些用例迁到 `classifyText(text, text.length) === 'ok'`（见测试）。字母计数改为不分配内存的写法 `/\p{L}\P{L}*\p{L}/u.test(text)`，等价于「至少 2 个字母」；原来的 `match(LETTER)`（`:3`、`:26`）遇到 1MB 文本会分配约百万项的数组，`LETTER` 常量随之删除。上一轮审查用 node 实测，`NOT_PROSE` 各正则在 1MB 输入上是线性耗时（合计 2 至 8ms），所以不按长度短路。长度按发送文本后，同一段的 `plain` 与 `seg.text` 可能一个短一个长，但噪声只看 `plain`，长度只看 `sentLength`，两个判断互不依赖，顺序仍是先噪声后长度。

### 2. `discover.ts`：产出 skipped Unit
- `Unit`（`:9-16`）加可选字段 `skipped?: 'long'`。取值写原因而不是布尔，以后别的跳过原因可以复用；没有这个字段的 Unit 行为与现在完全一致。
- `makeUnit`（`:50-55`）改用 `classifyText(seg.plain, seg.text.length)`：noise 返回 undefined；long 返回带 `skipped: 'long'` 的 Unit；ok 照旧。`DiscoverOptions` 不加回调，返回值类型不变。
- 超长只会出现在叶子块（`:106-107`）或行内 run（`:112-116`）上，同一个 root 下可以有多个超长 run，各自是一个 Unit。
- 占位 `et-tr` 不会被扫进来：`OWN_TAG` 在 `dom-rules.ts:192` 属于受保护元素，`isSkipped`（`:208-212`）整棵跳过；`stillSame` 计算摘要时也滤掉了 `OWN_TAG`（`render.ts:382`）。

### 3. `render.ts`：占位
- `Rendered`（`:24-33`）加独立标记 `skipped?: boolean`，**不复用 `failed`**（`:28`）。以后「分句翻译」的点击处理挂在这个标记上，和失败重试的语义分开。
- 新增 `skip(unit): Promise<void>`，读写骨架照搬 `fail`（`:516-556`）：读阶段算 `isDark`、`isFlexOrGrid`；等一帧；`disposed` 前后各查一次；先 `detach` 旧记录并 `clearLoading`；`inline = unit.kind === 'run' || flexRoot`；`makeElement(dark, inline)`（`:176-185`，带 `data-et-s`、`translate="no"`、`dir="auto"`，深色宿主带 `data-et-host="dark"`，行内与 flex/grid 单元带 `data-et-inline`）；`setAttribute('data-et-state', 'skipped')`；`lang` 改为 `uiLocale()`（同 `:542`）；内容只有一个文本节点 `message('render.skipped')`；`place(record, flexRoot)`（`:221-234`）；`rendered.set`。**不做入场动画**：不调用 `appear(record, 0)`。
  - 与 `fail` 的区别：没有按钮，没有 `title`（不写阈值数字，也不写说明），不加 `tabindex`，`record.failed = false`、`record.skipped = true`。
  - 实现时可以把 `fail` 与 `skip` 的公共骨架抽成一个内部函数（只差 state、文字、按钮和下面的守卫），省体积；`appear` 作为参数传入，只有 `fail` 调用；`fail` 的现有测试作为回归保护。
- **登记守卫**：`skip` 等帧期间，这个 Unit 可能已经被 `forget`（重扫发现文字变了），`drop` 此时找不到记录，帧后再写就会留下一个孤儿占位，新 Unit 再写一个就成了两个。做法：渲染器内部 `const skipping = new Set<Unit>()`，`skip` 开始时加入，`drop`（`:609-615`）时删除，帧后 `if (!skipping.delete(unit) || !unit.root.isConnected) return`。`restoreAll` 置 `disposed`（`:635`）已经拦住停止后的写入。
  - 注记：2026-11-24 起由渲染器的 drop 代数（`WeakMap<Unit, number>`）取代，见 `docs/known-issues.md` #57-2 与 `fix/render-frame-gap-and-rescan`。
  - **`skipping.delete(unit)` 必须放在 `drop` 里 `if (!record) return`（`render.ts:612` 附近）之前**：帧窗口内 Unit 还没有记录，`drop` 会在这一行提前返回，删除放在它后面守卫就失效。
  - **写阶段的便宜检查**：帧后对行内 run 再做一道与 `stillSame` 同类的检查（`render.ts:378` 附近那一行 `unit.nodes.some((node) => node.parentNode !== unit.root)` 的写法），只看最后一个节点：`unit.kind === 'run' && unit.nodes[unit.nodes.length - 1].parentNode !== unit.root` 时不写记录、不插占位（run 的最后一个节点已脱离文档，占位没有可挂的位置）。块单元不需要，`root.isConnected` 已覆盖。
- **必须排除的两处**：
  - `canBeOnly`（`:238-240`）加 `&& !record.skipped`。否则切到「只看译文」时会给原文加 `data-et-only`，原文被隐藏，只剩一行「此段过长，未翻译」。`swapMode` 的 `switchable`（`:390-391`）和 `insert` 末尾（`:509-512`）都经过它，改这一处即可。占位所在段落保持双语。
  - `has`（`:387`）改为「有记录且既不是 failed 也不是 skipped」。否则 `state().translated`（`session.ts:211-213`）会把占位算成已译，`want` 的 `renderer?.has(unit)`（`:320`）不受影响（守卫在它之前，见第 4 条），`showLoading` 的 `has(unit)`（`:575`）不会遇到 skipped（从不对它请求加载点）。
- 其余路径无需改动：`isFailed`（`:442`）对占位返回 false；`detached`（`:445-446`）会把被框架删掉的占位当作「需要恢复」，这正是想要的（见第 4 条「框架恢复」）；`setStyle`（`:558-561`）会同步 `data-et-s`，选择器依赖它；`restoreAll`（`:634-678`）遍历全部记录，占位随译文一起淡出、移除。

### 4. `session.ts`：登记为不发送的 Unit
计数与生命周期全部复用 `unitsByRoot`，不建第二套状态。逐条核实的路径：

| 路径 | 位置 | 处理 |
|---|---|---|
| 登记 | `register`（`:336-350`） | skipped Unit 照常放进 `unitsByRoot`，照常 `viewport.observe(root)`（`:344`）：同一个 root 以后可能再登记普通 run，只在新建列表时才 observe，跳过会让那个 run 收不到视口回调。登记后 `void renderer?.skip(unit)`，不看视口，立即写占位（没有网络成本，过长段很少） |
| 入批、进度、加载点、缓存 | `want`（`:313-334`） | **函数第一行** `if (unit.skipped) return false`，必须在 `translations.get`（`:324`）之前。这一处同时挡住：`register` 的 `want`（`:347`）、视口回调（`onViewport`，`:386-392`）、`pending`（于是 `flush` 的排序与分批 `:418-452`、`send` 都碰不到它）、`wantedAt`（加载点扫描 `:290-304` 只看它）、缓存回填 `queueRender` |
| 进度分母与 done | `status`/`report`（`:195-207`） | 只看 `pending`、`inFlight`、`waiting`、`failed`，skipped 一个都不进，整页只有超长段时也能立刻到 done |
| 失败与重试 | `failed`（`:146`）、`markFailed`（`:558-563`）、`retry`（`:586-600`）、`retryFailed`（`:902-910`）、「这次先用」（`:753-766`，`:762`） | skipped 从不发送，不会进 `failed`；`retry([...failed])` 碰不到它；`status()` 不会因它变成 error，面板和灵岛不出现重试按钮，灵岛重试数字（`isle.ts:126-128`、`renderState` 的 `last.failed`）不含它 |
| 重扫去重 | `rescan` 匹配（`:625-635`） | 同 root、同 kind、同 `seg.text` 且 `isCurrent` 的已有 skipped Unit 被保留，新发现的不重复登记。匹配条件不必加 `skipped`。匹配与 digest 都只看 `seg.text`（`segment.ts:84`），行内 `code` 里的文字变化不改变 `seg.text`，这是既有盲区：`plain` 变了而 `seg.text` 没变时，分类（只有噪声一项依赖 `plain`）不会随之刷新。长度已按 `seg.text`，不受此影响；噪声翻转的情形极少，影响很小，不处理 |
| 重扫遗忘 | `:640-649`、`forget`（`:661-687`） | 没再被发现的 skipped Unit 走 `forget`：移出 `unitsByRoot`、`renderer.drop` 删占位（`:675`）、计数随之减少 |
| 隐藏保留 | `mayBeHidden`（`:643-646`） | root 仍在文档里但这次没被发现（对话框把页面设成 `aria-hidden`/`inert`）时，内容未变的 Unit 保留。skipped 同样适用：占位留着，计数不减，与已译段落一致 |
| 框架恢复 | `:652-657` | 框架删掉占位后，`detached()` 返回它，走 `forget` + `allowReinsert` + `rescan(root)`，重新登记、重新写占位；10 秒内允许重插 3 次，第 4 次删除时放弃（`allowReinsert` 在 `recent.length >= LOOP_LIMIT` 才进 `abandoned`，`:236-247`，`LOOP_LIMIT = 3`），之后 `register` 跳过同文本（`:339`），这段不再有占位，也不再计数 |
| 渲染回填 | `scheduleRender`（`:352-370`） | skipped 不进 `toRender`，`insert` 的 stale 路径碰不到它 |
| 模式切换 | `setMode`（`:896-901`） | 只调 `renderer.setMode`，靠 render 的 `canBeOnly` 排除（第 3 条），占位原样保留 |
| 停止与清零 | `stop`（`:857-890`）、`clearState`（`:721-745`） | `clearState` 清空 `unitsByRoot`，计数归零；`restoreAll` 移除占位。`halt`（`:706-719`）与译文一样保留在页面上 |

**转换（本 PR 实现，以后按句切分直接复用）**：
- **skipped → 正常**：超长段被改短到 5000 以内，变更触发 `rescan(root)`；新文本与旧 skipped Unit 的 `seg.text` 不同，旧 Unit 被遗忘（占位立即删除），新 Unit 是普通 Unit，经 `want` 入批，译文由同一个 `place` 写在原来的位置。占位与译文之间有一段网络等待（在视口里 600ms 后出现加载点），这与现在「已译段落文字变了」的行为一致；不保留旧占位等译文，因为段落已经不再过长，留着就是错的。
- **正常 → skipped**：段落变长超过 5000，旧 Unit（无论已译、在途还是失败）被遗忘，译文或失败占位删除；新 skipped Unit 登记后在下一帧写占位，位置相同；`translated` 减 1、`skipped` 加 1，长文本不会发出。
- 两个方向都只依赖「文字变了 → 旧 Unit 遗忘、新 Unit 登记」这条现有路径，不加专门的转换代码。

**对外**：`state()`（`:209-223`）在现有遍历里顺带数 `unit.skipped`，只在大于 0 时写入 `skipped`（同 `halted` 的写法）。计数 = 当前登记在 `unitsByRoot` 里的 skipped Unit 数，含被 `mayBeHidden` 保留的；不含已放弃（`abandoned`）的。重扫末尾无条件 `report()` → `notify()`（`:658`），初扫有 `:841`，不用额外通知。

### 5. 并发与取消（上一轮审查的问题）
- **stop 期间旧扫描写入**：消失。skipped Unit 与普通 Unit 一样，在 epoch 检查（初扫 `:837`、重扫每个区域 `:622`）之后同步 `register`；被取消的扫描返回后直接 `return`，什么都不登记。`skip` 写占位前查 `disposed`，旧渲染器在 stop 时已 `restoreAll`。
- **并发重扫叠加**：消失。两次重扫各自发现同一个 skipped Unit，后提交的一方按第 4 条的匹配找到已登记的那个并保留，不再登记第二个，与普通 Unit 去重是同一段代码。
- **B2 暂存重扫**：同上，重扫时匹配保留。
- **残留风险 1，帧窗口**：`register` 与占位写入之间隔一帧，期间 Unit 可能被遗忘，由第 3 条的 `skipping` 守卫处理，有专门用例。
- **残留风险 2，自身删除触发重扫**：`mutations.ts:66-70` 把任何 `et-tr` 的移除（包括我们自己 `drop` 占位）都算作变更，会多一次覆盖该 root 的重扫。重扫会匹配保留现有 Unit，不产生重复，与删除译文时的现状相同，不额外处理。

### 6. 样式（`src/content/styles.ts`）
- 把 `:20` 的 error 重置规则改为两个选择器共用，颜色拆出去单写：
  - `et-tr[data-et-s][data-et-state="error"],et-tr[data-et-s][data-et-state="skipped"]{opacity:1;background:none;text-decoration:none;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12px;line-height:18px}`
  - `et-tr[data-et-s][data-et-state="error"]{color:oklch(0.55 0.17 30)}`，`:21` 的深色规则不变；
  - `et-tr[data-et-s][data-et-state="skipped"]{color:oklch(0.5 0.012 70)}`；
  - `et-tr[data-et-state="skipped"][data-et-host="dark"]{color:oklch(0.7 0.012 75)}`，放在上一条之后（特异性同为 0,2,1，靠先后取胜，与 `:21` 相同的做法）。
- 重置规则与 `:14-19` 的译文样式特异性相同，排在它们之后，所以 faded 的透明度、underline 的下划线、highlight 的底色与内边距都会被覆盖。highlight 剩下的 `width:fit-content`、`border-radius` 在无底色时没有视觉效果。
- **不做任何可点暗示**：`:22-23` 的按钮规则不扩到 skipped；不加 `cursor`、`:hover`、下划线、`tabindex`。占位放在宿主链接内部时会继承链接的指针和点击，这与译文相同，不处理。
- 对比度（本地按 OKLCH → sRGB 计算，WCAG 2）：浅色 `oklch(0.5 0.012 70)` 对白底 6.01:1，对 `#f5f5f5` 5.51:1；深色 `oklch(0.7 0.012 75)` 对 `#1e1e1e` 6.23:1，对 `#333` 4.72:1。`check-contrast.mjs` 只检查 `tokens.css`，不覆盖注入样式，数字记在本文。

### 7. 文案（三语 yml）
- `render.skipped`（段落占位，不带数字）：zh_CN `此段过长，未翻译`；zh_TW `此段過長，未翻譯`；en `Too long to translate`。
- `common.skippedCount`（复数，面板与灵岛读屏共用；`$1` 为段数）：
  - zh_CN `1/n: $1 段过长，未翻译`；
  - zh_TW `1/n: $1 段過長，未翻譯`；
  - en `1: $1 paragraph too long to translate`，`n: $1 paragraphs too long to translate`。
- `isle.withNote`（`$1` 主句，`$2` 补充；`check-i18n` 禁止在源码里写全角标点，所以拼接符号放进文案）：zh_CN、zh_TW `$1；$2`，en `$1. $2`。
- 文案和属性里都不出现阈值数字。**不预留**「分句翻译」相关键。

### 8. 灵岛（`src/content/isle/isle.ts`）
- 无任何可见变化：`renderState`（`:936-975`）、几何、引擎按钮的 `aria-label`（`:958-961`）、悬停提示与侧边 `title`（`:964-968`）都不改。
- 只改「翻译完成」读屏播报（`apply` 的 `:909-912`）：`state.skipped` 大于 0 时，`live.textContent = message('isle.withNote', message('isle.finished'), pluralMessage('common.skippedCount', state.skipped))`，否则照旧。计数在初扫 `register` 时就进了 `unitsByRoot`，早于 done，播报时已经就绪。
- 完成后才出现的过长段不补播（`announcedDone` 只在 `announceStart` 里重置，`:871-872`）。

### 9. 面板（`src/entrypoints/popup/`）
- `page-session.ts` 仿照 `failedText`（`:32-35`），新增 `skippedText(count)`：`i18n.t('common.skippedCount', count, [count.toLocaleString(uiLocale())])`。
- `App.tsx` 在 failRow（`:447-455`）之后加一行：`(state.skipped ?? 0) > 0` 时显示，复用 `.failRow` 布局（`popup.module.css:148-154`），行首放中性色 `.dot`（`:336-342`，默认 `--et-color-border-strong`），只有文字，没有按钮。
- 引擎出错的分支提前返回（`:402-434`），这时不显示这一行，暂停状态下最重要的是引擎错误。

### 10. 类型与契约
- `PageState`（`src/lib/messaging/protocol.ts:47-60`）加 `skipped?: number`，注释写明「仅在大于 0 时出现」；同步 e2e 镜像类型 `tests/e2e/support.ts:16-23`。
- `IDLE_PAGE_STATE`（`runtime-contract.ts:24-29`）不改：全新会话的 `state()` 没有 `skipped` 键，`bootstrap.test.ts` 的 `toEqual` 保持成立。bootstrap 原样透传 `session.state()`（`bootstrap.ts:136`），不用动。
- 常驻 content 不包含 `text.ts`、`segment.ts`、render 和 session（`text.ts` 只被 `segment.ts` 与 `discover.ts` 引用，二者只在 page-runtime 里），也不引入新文案。

### 11. DOM 约定（`docs/dom-contract.md`）
- `et-tr[data-et-state]` 那一行（`:15`）补上 `data-et-state="skipped"`：过长未翻译的提示，文字随界面语言变化（如「此段过长，未翻译」），导出时整个删除。
- 补充说明第 1 条（`:21`）的「仍是双语」列举补「过长未翻译的段落」；第 3 条（`:23`）把「失败占位的文字」改为「失败与过长占位的文字」。
- 状态名用 `skipped` 而不是 `long`，以后别的跳过原因可以复用同一个状态。`render.ts` 注释（`:13-15`、`:537-538`）已经要求新增的非译文内容带状态，不用改。
- 这是新增状态值，只增不改，属于兼容补充：CHANGELOG 标「DOM 约定补充（兼容）」，不标「DOM 约定变更」（`docs/dom-contract.md:5` 把「变更」定义为不兼容）。先例是 `CHANGELOG.md:32` 新增 `loading` 时的写法。按 `data-et-state` 整个删除的工具不受影响。

### 12. 与 m3d 决定 3 的偏差（Fable 5.2 已裁决）
决定 3 写的是「灵岛与面板仅在大于 0 时显示」。本方案：面板在大于 0 时显示一行；段落自身显示占位；灵岛不做可见显示，只在「翻译完成」读屏播报里带上。理由：灵岛本来就不显示「已翻译 N 段」，失败数也只体现在重试按钮的数字上；跳过的段落没有可执行的操作，提示放在段落本身最直接。用户已委托 Fable 裁决，`m3d.md` 的 C 行按此更新。

## 不做
- **按句切分超长段落**：可参考 FluentRead `localInference.ts:10-27` 的做法（`Intl.Segmenter` 加 480 字符回退），记为后续项。落地后多数过长段会被正常翻译，占位按「skipped → 正常」路径自然消失；无法安全切分的（行内标记跨句）保留占位，届时占位可能变成可点的「分句翻译」，点击处理挂在 `Rendered.skipped` 上。本 PR 只做不可点的提示，不预留文案键。
- 噪声段计数：URL、数字、文件名本来就不该翻译，计入会误导。
- 「点击查看是哪几段」的定位功能。
- 灵岛的可见标记、引擎按钮说明：上一版的引擎按钮 aria-label 方案已撤销；仿 `.eg[data-err]::after` 的中性小点也不做，挂在引擎按钮上会被读成「引擎有问题」。
- 给原文加背景、边框、首尾标记，或改动原文元素。
- 划词的 2000 字符上限。
- 面板组件测试：仓库里没有 `*.test.tsx`，也没有 `@testing-library/react`，本 PR 不引入。面板改为人工验证，加 e2e 断言 `page.getState`。

## 已知限制
- **计数与占位范围**：discover 能扫到的文字都会登记，包括折叠的标签页、`details`、`display:none` 和屏幕外的内容；隐藏处的占位看不见但计入。`isSkipped` 只排除 hidden、inert、aria-hidden（`dom-rules.ts:208-212`）；watcher 不监听属性变化（`mutations.ts:1-2`），切换 aria-hidden 不会触发重新计数，要等下一次覆盖该区域的重扫；期间按 `mayBeHidden` 保留。
- **噪声排除有限**：只排除 `NOT_PROSE` 命中的文本和字母少于 2 个的文本。放在文本元素里的 base64、压缩 JSON 等长串仍会得到占位并计入。
- **框架反复删除**：框架 10 秒内删掉同一占位，重插 3 次后第 4 次删除时放弃（与译文相同），这段不再有占位，也不再计数。
- **占位可能太弱**：12px 中性灰一行字，在长文里可能不显眼。真机若觉得太弱，升级路径是给占位自身左侧加 2px muted 竖条（仍不碰原文），不在本 PR 做。
- **面板刷新**：面板只在页面翻译中（running）时轮询（`page-session.ts:70-77`），翻译完成后停止。完成后才出现的过长段，要重新打开面板才能看到计数；段落占位会实时出现。灵岛读屏不补播。
- **残留与内存**：父容器被整体替换后，旧 Unit 要等下一次重扫因 `!isConnected` 被遗忘，在此之前计数可能偏大，与已译段落的现状一致（`session.ts:676` 的注释）。
- **既有问题，本 PR 不修**：现有 `fail()` 等帧后不检查 Unit 是否已被遗忘就写入 `rendered`（`render.ts:525-555`），可能留下孤儿失败占位；它的重试按钮会对已遗忘的 unit 发请求，最后在 `insert` 判为 stale。记入 HANDOFF 待处理。
- **长度按发送文本计**：长度按发送文本 `seg.text` 计，行内标签开销（每对 `<tN>…</tN>` 约 9 字符）可能把原文不足 5000 字的段落推过 5000 而标为过长，这是按发送上限定口径的取舍。
- **占位缺失的极少见情况**：skip 等帧期间段落被移走又在重扫前恢复原样，重扫匹配保留旧单元，之后不再写占位，表现为「计数了但没有占位」，直到下一次覆盖该区域的重扫或停止。
- **行数截断**：带 `-webkit-line-clamp` 的段落，占位可能被裁掉但仍计数，不为此解除截断。
- **长串常驻与重扫成本**：skipped Unit 常驻完整 `seg`（可能上 MB）；`abandoned`、`reinserts` 以长串为键；覆盖它的重扫会重新 `segment`。
- **转换时的空窗**：skipped → 正常时，占位立即删除，译文要等网络返回，期间只有加载点（在视口内）。

## 测试
所有「仍是 1」「仍在」类断言，都先等到重扫完成的信号（新段落已发出或已译出、或新占位已出现）再断言；变更落在超长段 root 的父容器里，保证重扫能覆盖它。判断字段不存在用 `'skipped' in state()`，不用 `toEqual`（它忽略值为 undefined 的属性）。

- **`src/content/text.test.ts`（新建）与 `discover.test.ts`**：
  - `text.test.ts` 放 `classifyText` 的用例：三种结果，「恰好 2 个字母」「1 个字母」，以及 `discover.test.ts:210-228` 迁来的日期用例（`classifyText(text, text.length)`，噪声为 noise、散文为 ok）；迁走后原用例从 `discover.test.ts` 删除；
  - `classifyText` 按发送长度：`plain` 很长而 `sentLength` 很短返回 ok，反之返回 long；
  - `'word '.repeat(1100)` 产出一个 `skipped: 'long'` 的块 Unit；
  - 边界：折叠并 trim 后正好 5000 字符是普通 Unit，5001 是 skipped；
  - 6000 字符的 URL、`'1 '.repeat(3000)` 不产出任何 Unit；
  - 同一块里被块级子元素隔开的两个超长 run，产出两个 skipped run Unit，root 相同；
  - 短散文夹一个 6000 字符的行内 `<code>` 的段落：正常产出普通 Unit，不标 skipped。
- **`render.test.ts`**：
  - `skip` 写出的占位：`et-tr`、`data-et-state="skipped"`、`lang` 为界面语言、`translate="no"`、文字为 `render.skipped`、没有 `button`、没有 `title`、没有 `tabindex`；
  - 行内 run 与 flex 单元带 `data-et-inline`，块单元不带；
  - 深色宿主带 `data-et-host="dark"`；
  - `has(unit)` 与 `isFailed(unit)` 都为 false；
  - 「只看译文」拆成两个顺序用例：①先 `setMode(translation)` 后出现 skipped；②先 skip 渲染完成后，再 bilingual 到 translation 切一次。两个用例都先断言前置条件：该 Unit `kind === 'block'` 且不是 flex/grid 单元（否则 `canBeOnly` 本就因别的原因返回 false，用例失去意义）；同一用例里放一个普通块作正向对照，断言普通块的原文带 `data-et-only`，skipped 段的原文元素不带；
  - `skip` 后同步 `drop`，等帧后页面上没有占位（`skipping` 守卫）；
  - 行内 run 在等帧期间最后一个节点被移出 root：不写记录、不插占位；
  - 没有入场动画：`skip` 写出的占位不触发 `appear`（无 animation）；
  - `restoreAll` 后占位被移除；`restoreAll` 开始后才到帧的 `skip` 不写入；
  - 「DOM contract」一组（`:825`）加一条锁定 `data-et-state="skipped"` 与 `lang`。
- **`session.test.ts`**：
  - 前置条件（所有「请求里没有超长文本」类用例）：必须先 `t.show()` 让 root 进入可见集合（`session.ts:347`、`:386-388`），并断言同页普通段确实发出了请求（`port.calls.length > 0`），再断言超长文本未出现在任何请求中；否则去掉 `want` 守卫也不会变红；
  - 初扫计数为 1，占位存在；mock 端口的所有请求都不含这段文本；整页只有超长段时 phase 到达 done（在 answer 前断言）、`translated` 为 0、`'failed'` 为 0；
  - `translated` 为 0 的断言：先等占位出现（渲染器 rAF 写入 rendered 之后）再断言，否则 `has` 不排除 skipped 的变异也不会变红；
  - 超长段与普通段同页：普通段译完后 phase 为 done（skipped 不卡进度）；
  - 在父容器追加普通段落，等它发出后仍是 1，占位仍只有一个；
  - 用现成的 `midScan` 工具（`:1685-1717`）在初扫期间插入内容，扫完重扫后仍是 1；
  - 不 await 连续两次 onDirty，覆盖同一区域，等两次都完成后仍是 1，占位只有一个；
  - 扫描中途 stop：`'skipped' in state()` 为 false，页面上没有占位；
  - 缩短到 5000 以内并重扫：`skipped` 消失，占位消失，新文本被发出并在原位置译出；
  - 普通段变长超过 5000 并重扫：译文消失，占位出现，`translated` 减 1，`skipped` 为 1，长文本没有发出；
  - 直接删除超长元素本身，触发父容器重扫后计数减少；
  - setMode（切到只看译文再切回）、retryFailed 之后计数保持，占位仍在；
  - 同页有失败段时：`failed` 只数失败段，retryFailed 发出的请求不含超长文本；
  - 视口回调报告超长段 root 进入范围后，不产生请求、不出现加载点（推进 loading 定时器后检查）；
  - 没有超长段时，`'skipped' in state()` 为 false。
- **`isle.test.ts`**：`emit({ skipped: 2, phase: 'done' })` 后，完成播报为「翻译完成」拼上计数文案；没有 `skipped` 时播报不变；引擎按钮的 `aria-label` 与没有 `skipped` 时相同；重试按钮仍隐藏。
- **`page-session.test.ts`**：`skippedText` 的单复数（en 与 zh_CN）。
- **e2e**（`tests/e2e/session.e2e.test.ts`，一条）：
  - 容器里放一段 6000 字符的正文和一段 6000 字符的 URL，开始翻译后：`page.getState` 的 `skipped === 1`；页面上有一个 `et-tr[data-et-state="skipped"]`（占位下一帧才写入，用 `expect.poll`）；正文带一个唯一标记词，请求不含正文改为 `!texts.some((t) => t.includes(marker))`，不比较 6000 字符全文；
  - 切到只看译文后，超长段的原文元素上没有 `data-et-only`，同容器里的一个普通块带 `data-et-only`（正向对照）；
  - 往这个容器追加一个普通段落，等它译出后仍是 1；
  - stop 后不再有 `skipped`，页面上没有 `et-tr`（占位约 140ms 淡出后才移除，用 `expect.poll`）。
- **变异验证**（每条写明必须变红的用例）：
  - 去掉 `want` 第一行的守卫：session「请求不含这段文本」「只有超长段时到达 done」「视口进入后不产生请求」变红（前提是上面写明的 `t.show()` 与 `port.calls.length > 0` 前置断言）；
  - 守卫挪到 `translations.get` 之后：本身不会变红（缓存里不会有超长文本），只作代码审查项，不列入变异清单；
  - `canBeOnly` 去掉 `!record.skipped`：只让 render「先 skip 后切模式」变红（先 setMode 后 skip 的顺序，占位写入时 `canBeOnly` 不参与，不会红），以及 e2e 的同项断言；
  - `has` 不排除 skipped：render「`has` 为 false」与 session「`translated` 为 0」（占位出现后断言）变红；
  - 用 `failed: true` 代替 `skipped` 标记：render「`isFailed` 为 false」变红；
  - 去掉 `skipping` 守卫：render「skip 后同步 drop 不留占位」变红；
  - 计数改在 `register` 里累加而不是数 `unitsByRoot`：只让「缩短后消失」「直接删除超长元素」变红；
  - 计数在 discover 回调里累加（旧方案路线）：才让「连续两次 onDirty 仍是 1」「中途 stop」变红；
  - 判断顺序改回先判长度：discover 的 URL 与数字用例变红；
  - `>` 改成 `>=`：5000 边界变红；
  - 完成播报不拼接：isle 播报用例变红。
- **人工验证**：浅色与深色宿主下占位的颜色与对齐；行内 run、flex 列表项里的占位位置；只看译文下该段保持双语；面板在超长页显示该行、普通页不显示；读屏在完成时读出拼接句。

## 体积
page-runtime 当前 23.63 / 24 KB。新增分类、`skip` 渲染（与 `fail` 共用骨架）、样式选择器和读屏拼接，预计增加 0.3 至 0.5 KB，以实测为准；超过 24 KB 时按 m3d 决定 4 把 `scripts/check-size.mjs:48` 的预算提到 25 KB，并在注释里写明原因与日期。content 必须保持 6.99 / 7 KB（`IDLE_PAGE_STATE` 不改，content 不引新文案、不引 `text.ts`）。popup 增加约 0.1 KB。

## 文档
- 本文：补实施记录。
- `docs/dom-contract.md`：按方案第 11 条更新。
- `m3d.md`：C 行改为已合并，范围改为「段落占位 + 面板计数 + 灵岛完成播报」，注明与决定 3 的偏差经 Fable 5.2 裁决。
- Codex 核实文档：第 6 条和排期第 6 条写上状态；「从零设计 4」注明跳过计数状态。
- CHANGELOG：「未发布」的「新增」加一条；另标「DOM 约定补充（兼容）：`et-tr[data-et-state]` 新增 `skipped`」，写法同 `CHANGELOG.md:32`。
- HANDOFF：更新进度，并写明发版节奏「M3d 收尾后发 v0.3.0」；待处理补两项：①既有问题「`fail()` 等帧后未检查 Unit 是否已被遗忘，可能留下孤儿失败占位」；②「按句切分」后续项（见「不做」）。
- `README.md:51` 与 `README.zh-CN.md:51` 整页翻译功能行补一句过长段提示（双语同步，例如「A paragraph that is too long to translate is marked in place.」与「过长无法翻译的段落会在原处标出。」，措辞实施时定）。
- `README.zh-CN.md:280` 的 `render.ts` 注释补「过长占位」，`README.md:280` 有对应行，同步（现为「Inserts and restores translations, retry placeholders」，补 too-long placeholders）。
- 三语 yml 新文案（`render.skipped`、`common.skippedCount`、`isle.withNote`）按惯例加 `# $1：…` 注释，如 `failedCount` 上方的 `# $1：没有译出的段数。`。

## 回滚
单个提交，`git revert` 即可。不涉及存储和数据变更；`skipped` 是可选字段，旧面板会忽略它。回滚后超长段恢复为静默丢弃，页面上不再出现 `data-et-state="skipped"`，按约定删除 `et-tr[data-et-state]` 的导出工具不受影响。

## 分支
`feat/skipped-count`

## 实施记录（2026-11-19）
**实现**：
- `text.ts`：`classifyText(plain, sentLength)` 先排除噪声再判断长度，`>` 5000 为过长。
- `discover.ts`、`session.ts`：Unit 新增 `skipped` 字段，过长段登记成不发送的 Unit，由现有的去重、遗忘、清零机制管理；`want` 首行守卫，skipped 单元不进发送队列；`canBeOnly`、`has` 排除 skipped 单元。
- `render.ts`：`note()` 合并 fail 与 skip 的写入骨架，加 `skipping` 守卫。
- 灵岛：只改完成播报，并修复既有问题「完成播报被开始播报覆盖」（done 分支 `cancelRaf`）。
- 面板：一行「N 段过长，未翻译」，仅大于 0 时显示。
- 三语文案：`render.skipped`、`common.skippedCount`、`isle.withNote`。

**测试**：`npm run check` 通过，77 个文件 1639 个用例；新增约 38 条单测加 1 条 e2e。e2e 全量 42 通过、2 跳过（跳过为既有）。

**变异验证**：10 条全部按预期变红：去掉 `want` 守卫、`canBeOnly`、`has`、用 `failed` 代替 `skipped`、`skipping` 守卫、register 累加、discover 回调累加、先长度后噪声、`>` 改 `>=`、播报不拼接、撤掉 `cancelRaf`。

**体积**：content 6.99 / 7.00 KB，page-runtime 23.89 / 24.00 KB（未提预算），popup 83.20 / 90.00 KB。

**check 结论**：第 1 轮（两位 Opus 分领域审）无阻断，修复 8 项：空转测试 4 处、完成播报覆盖、播报数字本地化、`afterEach` 不再吞异常、补 2 条测试。第 2 轮（主会话审增量）补强并发重扫用例的等待，无新问题。

## 手工验收
验收页 `tests/fixtures/too-long-paragraph.html`（PR-E #58 加入）。运行 `python3 -m http.server 8765 --directory tests/fixtures`，打开 `http://localhost:8765/too-long-paragraph.html`，翻译整页，预期总数 6。
