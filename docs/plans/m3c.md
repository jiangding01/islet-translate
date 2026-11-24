# M3c 指令台与灵岛键盘：范围与拆分

> 状态：**第 2 稿已获用户批准**（2026-11-23，含体积预算 content 7.75 KB、page-runtime 28 KB、palette-runtime 15 KB，以及「新增文案」一节的文案方向；路线图变更同步到方向文档第 7 节与 HANDOFF）。第 1 稿经过 Opus 对抗式审查，结论是「改后可批准」：阻断 2 项、重要 9 项、建议 9 项，已逐条处理，处理记录见附录 A。本文只记范围、拆分与决定，各 PR 的实施记录在实现时补到对应小节。

## 结论
M3c 拆成 6 个可以独立合并的小 PR：
1. 指令台本体：新增按需模块 `palette-runtime.js`，新增快捷键 `⌃⇧K`（Windows/Linux 上是 `Alt+Shift+K`），建立指令注册表。
2. 设置入口与快捷键显示。
3. 快速翻译框。
4. 翻译一个区域。
5. 不翻译一个区域。
6. 从灵岛 ⌘ 打开指令台。

灵岛本身仍然只响应指针，不进入网页的 Tab 顺序。键盘用户统一从指令台进入：灵岛上的每个操作都有对应的指令，「灵岛键盘」由指令台来实现。

## 范围来源与核对
- `docs/plans/ui-isle-direction.md`：
  - 第 1 节「所有操作都是指令」。
  - 第 2 节第 2 条：指令台用 `⌃⇧K`，界面上显示实际生效的快捷键。
  - 第 2 节第 10 条：键盘与读屏。
  - 第 4 节第 3、4 条：快速翻译框、按情境排序。
  - 第 7 节「M3（交互）」一行。
- `docs/plans/m3b.md`：
  - 第 15 行：按住切换在 M3c 登记为 `paragraph.toggle`。
  - 第 28 行：区域选择器移到 M3c，不做 CSS 路径记忆。
  - 「不做」：右键菜单不加项。
  - 第 5 节：局部会话不做全量扫描，按住有 2 万字上限。
- `docs/plans/m3a-selection.md:179`：Esc 一次只关一层。
- `docs/plans/m2b-lazy-runtime-and-isle.md`：
  - 按需模块必须是单文件、零 import，不能出现扩展地址。
  - 偏差记录：「焦点进入灵岛内部留到 M3 随指令台补齐」。
- `docs/plans/m3d.md:38`：常驻层要加逻辑时，先瘦身再谈预算。
- **与既定约定的偏离**（批准时一并确认）：
  1. 方向文档第 5 节第 1 条要求「小点、灵岛、指令台是同一个 DOM 元素」，第 8 条要求「挂在同一个 Shadow 宿主下」。本方案改为：指令台单独用一个宿主 `ET-PALETTE`，只在视觉上贴着灵岛，并用同一组弹簧参数（300/30）拉出。原因：
     - page-runtime 只剩约 1 KB 余量；
     - 零层，也就是页面还没翻译时，也必须能打开指令台，而灵岛只在整页会话期间挂载（`isle.ts:121-123`）；
     - 要把灵岛改成能装下任意内容的形变容器，就得重写 `isle.ts` 的挂载状态机，风险远大于收益。
  2. 方向文档第 2 节第 10 条要求「灵岛展开后焦点进入灵岛内部」。本方案改由指令台承担键盘操作，理由见决定 4。这一条同时了结 M2b 留下的那处偏差。
  3. 方向文档第 7 节把磁吸生长、`⌥` 偷看原文、段落「原」按钮的生长动效排在 M3。本方案不在 M3c 做这三项，**另行排期**。批准后同步修改方向文档第 7 节和 HANDOFF 路线图，原因见「不做」。
  4. `m3b.md` 第 15 行写的「登记为 `paragraph.toggle`」不做：按住切换需要指针坐标，指令台里没有这个输入。批准后在 m3b.md 该处加注。
  5. `docs/dom-contract.md:19` 列出了插件自己的宿主。PR1 补上 `et-palette`，PR4 补上 `et-pick`，按约定在 CHANGELOG 标「DOM 约定变更」。
- 已核对、不冲突的：
  - HANDOFF「默认快捷键不用 Option 组合」。
  - `m3d.md` 决定 5：区域排除只在页面生命周期内有效，不持久化。
  - commands 配额：上限 4 个，现有 2 个，本批再用 1 个。

## 借鉴 FluentRead（本地 `/Users/jiangding/FluentRead`，只借思路）
| 机制 | FluentRead 做法 | 本批取舍 |
|---|---|---|
| 命令面板 | 没有。快捷键全部是页面内的 keydown，页面失焦或焦点在输入框里时都不生效 | 用 `chrome.commands`，在网页输入框里也能打开，这是差异化 |
| 区域选择 | `section-translation/content/picker.ts`：<br>• 悬停高亮块；↑ 扩大、↓ 缩回、Enter 确认、Esc 退出（`:896-917`）；正在编辑时让出按键（`:907-911`）<br>• 拦截 mousedown/mouseup/click/dblclick/auxclick 和 pointerover/mouseover，右键退出（`:73-75,890`）<br>• 只认 `isTrusted`；悬停有稳定窗，到期后复验 | 照搬键位、完整的拦截列表、右键退出、可信事件校验和到期复验<br>不做「记住此区域」 |
| 悬浮球键盘 | `FloatingBall.vue:26-100`：按钮 `tabindex=0`，focusin 时展开 | 不学，因为违背「不往网页 Tab 顺序插焦点」 |
| 输入框就地翻译 | 在可编辑区连按三次空格，原地写回 | 不在本批（见「不做」） |

## 差异化
- 针对「每页默认显示浮球、需要逐站关闭」：
  - 指令台不常驻，按 `⌃⇧K` 才出现；
  - 零层页面上不留痕迹。
- 针对竞品的快捷键在输入框里失效：
  - 走 `chrome.commands`，焦点在网页输入框里也能打开；
  - 关闭后把焦点和选区原样还给网页；
  - 指令台里打的字不会触发网页快捷键（决定 4）。
- 同一个入口既能「找功能」，也能「临时翻一句」；翻译方向会自动反转（决定 7），中文用户打中文，得到的是英文。

## 架构

```
chrome.commands "open-palette" ──► background（context-menu.ts onCommand）
                                      │ tabs.sendMessage(frameId 0) "palette.toggle"
灵岛 ⌘（PR6）──► page-runtime ──deps.openPalette()──┐
                                                   ▼
                   content bootstrap（常驻）：palette.toggle → 按需加载 palette-runtime（失联判断同划词）
                                                   │ PaletteRuntimeDeps（通用 send + 动作表）
            ┌──────────────────────────────────────┼──────────────────────┐
            ▼                                      ▼                      ▼
  动作表（bootstrap，与消息处理共用）      后台窄消息（PR2）：        region（PR4/PR5）
  start/stop/toggle/setMode/              options.open、shortcuts.get   session.region(kind, el)
  retryFailed/state；closeCard
```

依赖都是单向的：palette-runtime 只认 bootstrap 借给它的 deps，不 import 其他按需模块，也不读扩展地址。

## 关键决定

**决定 1：指令台是第三个按需模块 `palette-runtime.js`；常驻层预算申请 7.75 KB**
- 沿用 `runtime-contract.ts` 的工厂约定：
  - 注册键：`Symbol.for('islet-translate.palette-runtime')`。
  - 接口：`PaletteRuntime { toggle(args), close(), dispose() }`。
  - 依赖：`PaletteRuntimeDeps`，所有后台消息都走一个通用的 `send`。
- 常驻层增加以下几项：`palette.toggle` 消息处理、加载器（失败与失联走 `isContextLost`）、动作表、打开指令台前关闭卡片。
- 审查实测（附录 A 的 I1）：
  - 抽出通用加载器只省 −9 B（gzip 已经压掉了重复代码），瘦身走不通；
  - 最小实现会到 7.53–7.57 KB。
  - 因此**申请把 content 提到 7.75 KB**，PR1 合并时生效，并附上实测值。

**决定 2：注册表在 palette-runtime 里，内核动作在 bootstrap 里只写一份**
- bootstrap 现在逐条注册 `page.*` 消息（`bootstrap.ts:141-173`）。改为先建一张动作表，再用它注册消息，指令台通过 deps 调用同一张表。面板、快捷键、指令台从此走同一份实现。
- 灵岛按钮和按住手势仍然直接调用会话。它们调的是同一组方法，为了形式上统一去改动 page-runtime 不值得。
- 每条指令只有这些字段：
  - `id`；
  - `title`（i18n key）；
  - `keywords`（英文别名）；
  - `when(ctx)` / `rank(ctx)` / `run(ctx)`。
- `ctx` 是 `state()` 加上「最近一次快速翻译的结果」。
- `state().halted` 为真时，所有指令都不可用，列表只显示一行「扩展已更新，请刷新页面」，复用现有的 `page-unreachable` 文案。

**决定 3：后台只加两条窄消息，内容脚本不写配置**
- 删掉第 1 稿里的「停靠到…」指令：设置页已经有这一项（`GeneralPage.tsx:407`），内容脚本写配置还会多一条路径。
- 新增 `options.open`：后台调用 `runtime.openOptionsPage()`。
- 新增 `shortcuts.get`：后台调用 `commands.getAll()`，返回实际生效的键。注册失败的键是空串，空串不显示。
- 两条消息都校验 `sender.tab` 且 `frameId === 0`，做法同 `page.status`（`background.ts:115`）。它们只读或只做导航，不改任何存储。

**决定 4：键盘、焦点与按键隔离**
- **打开时**：
  - 记下 `document.activeElement`（深入 open shadow；焦点在 iframe 里时就是 iframe 元素本身）和当前选区；
  - 把焦点移进指令台的输入框。
- **关闭时**：
  - 焦点和选区还回原处；
  - 原元素已经不在文档里时，不再还焦点。
- **按键隔离（阻断项 B1）**：指令台在封闭 Shadow 里，按键冒泡到 document/window 时，事件目标被改写成宿主，网页的快捷键库会以为用户不在输入框里，于是在 GitHub 打 `s`、在 YouTube 打 `k`、在 Gmail 打 `e` 都会触发网页动作。处理办法：
  - 在 Shadow 内的输入框和根节点上，对 `keydown`、`keypress`、`keyup`、`beforeinput`、`input` 调用 `stopPropagation`，Esc 也一样。
  - 网页在 window/document **捕获阶段**注册的监听会先收到按键，这一层拦不住，作为残余风险写进「最脆弱的假设」。
- **指令台内部**：
  - 输入框是 `role=combobox`，列表是 `role=listbox`，当前项用 `aria-activedescendant` 指出。
  - ↑↓ 只移动高亮；Tab 和 Shift+Tab 留在指令台内。
  - 结果和状态通过 `aria-live="polite"` 播报。
- **输入法**：`isComposing` 或 `keyCode === 229` 时，Enter 和 ↑↓ 都交给输入法处理。
- **再按一次快捷键**会关闭指令台，即 `toggle`。
- **网页别处按下指针**时关闭指令台，与灵岛 `isle.ts:1284-1288` 的行为一致。
- **按住手势**：焦点在自己的宿主（`isOwnNode(activeElement)`）里时，`hold/watch.ts` 的 `isTypingFocus` 视为正在输入。这样在指令台里按住 Ctrl，不会切换指针下的段落。这是常驻层改动，体积已计入决定 1 的申请。
- **灵岛按钮**保持 `tabindex=-1` 和 `keepFocus`：灵岛上的每个操作都有对应的指令，所以键盘能完成全部灵岛操作。

**决定 5：Esc 只有一层：指令台、划词卡片、区域选择三者互斥**
- 打开指令台时，bootstrap 先关闭卡片和小点（`selection.close()` 加 `hideDot()`）。
- 卡片因快捷键或右键菜单打开时，bootstrap 先关闭指令台。
- 进入区域选择时，指令台已经关闭。
- 同一时刻只有一个浮层开着，所以不需要排层级，也不用改 `card.ts`。
- 灵岛展开着、同时又打开了指令台时：灵岛的 `onKeyDown`（`isle.ts:1290-1298`）在发现 `ET-PALETTE[data-open]` 时让步，规则与它现在让给 `ET-SELECTION` 一样。这是 PR1 对 page-runtime 唯一的改动。
- 宿主标签 `ET-PALETTE`、`ET-PICK` 加进 `dom-rules.ts:130-131` 和 `isOwnNode`（`selection/watch.ts:41-46`）。
- Shadow 模式沿用 `env.shadowMode ?? 'closed'`。

**决定 6：位置**
- 灵岛可见时（PR6）：从灵岛朝页面内侧拉出，顶边对齐灵岛。
- 灵岛不可见时：
  - 停靠在左侧或右侧：从该侧边缘拉出，竖直位置在视口 30% 处；
  - 停靠在底部：在右下角向上拉出。
- 宽度为 `min(420px, 100vw - 32px)`。
- 开启 `prefers-reduced-motion` 时直接到位，只保留不超过 120 ms 的透明度变化。
- 材质只引用 `tokens-isle.css`。
- PR1 开工前，先在 Design 原型里新增「指令台 M3c」画板，覆盖：亮暗两种宿主、三种停靠、零层和灵岛旁两种位置、快速翻译结果态、区域选择遮罩。由我们出终稿并自行决定，实现后附截图汇报。

**决定 7：快速翻译的方向会自动反转（重要项 I6）**
- 翻译前，先用 bootstrap 借出的 `detectLanguage`（与划词卡片同源）判断输入的语言：
  - 输入**是**目标语言时，改为译成英文；
  - 目标语言本身就是英文时，译成浏览器的界面语言；
  - 界面语言也是英文时，提示「已经是目标语言」，不发请求。
- 请求带上 `target` 和 `force`。协议已经支持这两个字段（`protocol.ts:155,164`），后台不用改。
- 不新增配置项。

## 指令表
| id | 标题（zh_CN，待确认） | 可用条件 | 情境排序 | 执行 | PR |
|---|---|---|---|---|---|
| `page.translate` | 翻译此页 | 空闲，或局部会话 | 空闲时排第一 | `start()` | 1 |
| `page.restore` | 显示原文（结束翻译） | `phase !== 'idle'`，**包括局部会话** | — | `stop()`（同时清掉局部译文） | 1 |
| `view.bilingual` / `view.translationOnly` | 双语对照 / 只看译文 | 整页进行中，且不是当前模式 | — | `setMode` | 1 |
| `retry.failed` | 重试失败的段落 | `failed > 0` 或有 `engineError`（与 `isle.ts:126-128` 的 `hasRetry` 一致） | 排第一 | `retryFailed()` | 1 |
| `engine.switch` | 整页进行中：切换翻译服务…<br>空闲时：用…翻译此页 | 总是可用 | — | 进入二级列表（`engine.options`），选中后调用 `start({engine})` | 1 |
| `options.open` | 打开设置 | 总是可用 | 排最后 | `options.open` | 2 |
| `region.translate` | 选择要翻译的区域 | 空闲，或局部会话 | — | 进入区域选择 | 4 |
| `region.exclude` | 选择不翻译的区域 | 整页进行中 | — | 进入区域选择 | 5 |

- 匹配规则：
  - 去掉首尾空白，不区分大小写；
  - 对标题和 `keywords` 做子串匹配；
  - 标题前缀命中排在子串命中之前，再按情境分和表中顺序排。
- PR2 起，列表每行右侧显示该操作的实际快捷键，例如「翻译此页 ⌃⇧A」。

## 输入语义（重要项 I5）
- **输入为空**：按情境排序列出全部可用指令。Enter 执行高亮项，默认高亮第一项。
- **以 `/` 开头**：只做指令过滤。Enter 执行高亮项。
- **其他输入**（PR3 起）：
  - 列表第一行固定是「翻译“…”」，下面是匹配到的指令。
  - **Enter 永远执行翻译**；要执行指令，必须先用 ↓ 选中它。
  - 这样无论是打「翻译」两个字，还是英文界面里打 `Show`、`Retry`，都不会误触整页翻译或结束翻译。
  - PR3 合并之前，没有翻译行，Enter 执行高亮的第一条匹配指令。PR1 到 PR3 都会在 v0.5.0 之前合并，用户不会经历这次行为变化。
- **翻译结果**：
  - 流式显示在列表上方（方向文档第 4 节第 3 条），可以选中文字。
  - 出结果后，「复制译文」排在第一位，焦点仍在输入框里，按 ↓ 再按 Enter 即可复制。
- **请求层**：
  - 复用 `src/content/selection/request.ts` 的 `createCardRequests`：2000 字上限、SW 重启后重试一次、丢弃迟到帧。
  - palette-runtime 自己建 Port，做法同 `selection-runtime.ts:19-21`。
- 不做朗读、音标、固定。

## 区域选择器（PR4 翻译区域；PR5 不翻译区域）
- **进入**：
  - 执行区域指令后关闭指令台，但**不把焦点还给网页**：焦点留在 `ET-PICK` 宿主里一个隐藏元素上，选择结束后才还。
  - 遮罩本身 `pointer-events:none`，只画高亮框和一行提示「↑ 扩大 · ↓ 缩小 · Enter 确认 · Esc 取消」。
- **拦截（重要项 I4）**：选择期间，在 window 捕获阶段做以下处理，都只对可信事件生效：
  - 键盘：对 `keydown` 和 `keyup` 调用 `preventDefault` 加 `stopImmediatePropagation`，防止网页滚动或提交表单。
  - 鼠标：对 `mousedown`、`mouseup`、`click`、`dblclick`、`auxclick`、`pointerover`、`mouseover`、`contextmenu` 做同样处理；右键等于退出。
  - 按住监听和划词监听都挂在 document 捕获阶段（`hold/watch.ts:154-172`、`selection/watch.ts:288-298`），会排在 window 之后，所以自然收不到事件。**常驻层不用改。**
  - 残余风险：网页如果比我们更早在 window 捕获阶段注册了监听，仍会先收到事件，记为已知限制。
- **候选块**：
  - 取指针下文本节点所在的最近块级祖先，块级判断用 `isInlineElement` 取反；
  - 纯键盘操作时，从视口中心那一点开始取；
  - 跳过自己的宿主、`body`/`html` 和受保护区域。
- **扩缩**：
  - ↑ 换成父级块，并把当前块压栈，最多到 `body` 的子级；↓ 出栈。
  - 指针移到别处时清空栈。
  - 悬停有 80 ms 稳定窗，到期后用 `elementsFromPoint` 复验。
- **高亮框位置**：滚动或缩放时，在 rAF 里重算。
- **体量上限（阻断项 B2）**：
  - `region('translate')` 沿用按住的 2 万字上限（`session.ts:1033-1041` 的 `holdBlock` 同一计数口径）。
  - 超过上限时，高亮框变成珊瑚色，提示「区域太大，可直接翻译此页」，Enter 不生效。
  - 局部会话可以用 `page.restore`（PR1）一次撤销。
- **会话接口**：page-runtime 新增一个方法 `region(kind, root): Promise<PageState>`。
  - **`translate`（PR4）**：
    - 没有会话时，建立局部会话（`scope:'units'`），把 `root` 内的单元全部加入；
    - 已有局部会话时，追加到其中；
    - 单元发现和渲染走 `toggleAt` 的同一路径，只是起点从一个坐标换成一个根元素。
  - **`exclude`（PR5，重要项 I3）**：
    - 只在整页会话里可用。
    - 把 `root` 记入 `excludedRoots: WeakSet<Element>`。判断与 `isExcluded` 并列，放在 `want`、`register` 和渲染批次过滤（`session.ts:406-408,430-436`）三处。
    - 排除时，像 `toggleAt` 那样取消该区域内 pending、sent、queued 的段（`session.ts:1101-1107`），并移除已经插入的译文和加载点。
    - **SPA 路由变化或 `stop()` 时清空**，避免换页后复用同一个容器时，留下无痕迹的「漏译」。
    - 在已排除的区域内按住某段：**解除整个区域的排除**，这块区域恢复翻译。这样就不需要第二套反向集合。
  - bootstrap 动作表新增 `region`。

## 拆分（按顺序；PR2–PR6 都只依赖 PR1，彼此独立）
| 顺序 | 分支 | 范围 | 新文案 | 合并后能用的功能 |
|---|---|---|---|---|
| 1 | `feat/m3c-palette` | 见下方 | 快捷键描述 1 条、指令标题约 6 条、占位与空结果 3 条 | `⌃⇧K` 打开指令台；键盘能完成灵岛上的全部操作 |
| 2 | `feat/m3c-palette-extras` | `options.open`、`shortcuts.get` 及其 sender 校验；`options.open` 指令；列表显示实际快捷键 | 1 条 | 从指令台打开设置，并能看到各项快捷键 |
| 3 | `feat/m3c-quick-translate` | 输入语义、方向反转、流式结果区、复制、过长与错误提示 | 约 4 条 | 临时翻译一句 |
| 4 | `feat/m3c-region-translate` | 区域选择器、拦截、2 万字上限、`region('translate')`、`ET-PICK` 及其 DOM 约定 | 约 4 条 | 只翻译选中的区域 |
| 5 | `feat/m3c-region-exclude` | `region('exclude')`、`excludedRoots` 的三处判断、取消在途请求、路由和 `stop` 时清空、按住时解除 | 约 2 条 | 整页翻译时排除一个区域 |
| 6 | `feat/m3c-isle-entry` | 灵岛 ⌘ 按钮（悬停提示显示实际快捷键）；`PageRuntimeDeps.openPalette` 与 `isleRect`；指令台打开期间灵岛保持展开，并且不把指令台内的点击当作外部点击；失联后 ⌘ 隐藏 | 1 条 | 用指针从灵岛进入指令台 |

> 2026-11-23：用户同意把顺序调整为 PR1 → PR2 → PR6 → PR3 → PR4 → PR5（先做灵岛 ⌘ 入口与铰链位置，再做快速翻译框）。表中序号保持原样，只是实施顺序变了。

PR1 的范围：
- 原型画板。
- `palette-runtime` 模块和 WAR，同步修改：
  - `wxt.config.ts` 的 WAR；
  - `check-size.mjs` 的条目；
  - `check-build.mjs:98-99` 的断言和 `RUNTIME_KEYS`。
- `open-palette` 快捷键：
  - 改 `wxt.config.ts`、`context-menu.ts` 的 `onCommand` 和 `MenuDeps.send` 联合类型；
  - 在 `check-build.mjs:81-90` 补上默认键断言。
- bootstrap：动作表、加载器与失联处理、和卡片互斥。
- 注册表，包括表中标为 PR1 的 5 条指令。
- 焦点与按键隔离。
- `isle.ts` 的 Esc 让步；`hold/watch.ts` 把自己的宿主当作正在输入。
- `ET-PALETTE` 加入 `isOwnNode` 和 DOM 约定。

### 测试
**单测**
- 注册表的 `when`、`rank` 与匹配排序：表驱动，覆盖空闲、整页、有失败、`engineError`、局部会话、`halted`、快速翻译之后七种情境。
- 输入语义：
  - `/` 前缀；
  - 非 `/` 输入时 Enter 永远执行翻译；
  - ↓ 选中指令后再按 Enter；
  - 输入法组合期间按 Enter。
- 方向反转的四个分支。
- 焦点恢复：原元素已被移除；原来有选区；原焦点在 iframe 里。
- 按键隔离：Shadow 内的按键不会到达 document 的冒泡阶段监听。
- 互斥：
  - 打开指令台时关闭卡片和小点；
  - 卡片打开时关闭指令台；
  - 灵岛的 Esc 让步给指令台。
- bootstrap：
  - 消息路径和 deps 路径得到相同结果；
  - 失联后不再加载，只给出刷新提示。
- 后台：两条窄消息校验 sender，空快捷键不显示。
- PR4：
  - 候选块的选取；
  - ↑↓ 栈；
  - 到期复验；
  - 2 万字上限；
  - 已有局部会话时追加单元。
- PR5：
  - 已登记的单元滚入视口后不会翻译；
  - 在途段被取消；
  - 路由变化和 `stop` 时清空；
  - 按住时解除排除。

**e2e**
- 真实的 `chrome.commands` 按键在 CDP 里触发不了，所以用 `h.tell('palette.toggle')` 代替。
- PR1：
  - 打开后焦点在输入框；
  - 在输入框里打 `s`，页面在冒泡阶段收不到；
  - 打「只看」后按 Enter，切换到只看译文；
  - Esc 关闭后，焦点回到原来的页面输入框；
  - 划词卡片开着时打开指令台，卡片会被关闭。
- PR3：
  - 在 mock 引擎下打英文句子，按 Enter 后译文流式出现；
  - 打中文时，请求的 `target` 是 `en`；
  - `/` 前缀不发请求。
- PR4：
  - 用键盘进入区域选择，↑ 扩大，Enter 后只有该区域被翻译；
  - 选择期间点击链接不会跳转，焦点在页面输入框里时 ↑ 不会移动光标；
  - 选中超出上限的区域时，按 Enter 无效。
- PR5：排除一个区域后滚动，区域内已登记的段不出现译文。
- PR6：点 ⌘ 后指令台贴着灵岛，在指令台里点击时灵岛不会收起。

**手测**（每个 PR 都要真机验收）
- 快捷键：
  - 三个平台都能注册；
  - 0.4.0 升级上来的用户能否拿到默认键。
- 网站：
  - Gmail（开启快捷键）、GitHub、YouTube 上打字不会触发网页快捷键；
  - 维基百科上 `Alt+Shift+K` 不和 accesskey 冲突。
- 带焦点陷阱的对话框、`showModal` 对话框、全屏页面（见下节）。
- 亮暗两种宿主、三种停靠位置。
- 4 倍 CPU 降速下，拉出动画的帧率。

## 新增文案（需用户确认，PR1–PR6 合计约 20 条，三种语言同步）
- 快捷键描述：「打开指令台」（manifest，在 `chrome://extensions/shortcuts` 里显示）。
- 输入框占位：「输入指令，或输入要翻译的文字」。
- 列表提示：
  - 空结果：「没有匹配的指令」；
  - `/` 提示：「以 / 开头只搜索指令」。
- 指令标题：见指令表。
- PR3：
  - 「翻译“{text}”」「复制译文」「已复制」「已经是目标语言」；
  - 过长和错误提示复用现有文案。
- PR4：
  - 遮罩提示「↑ 扩大 · ↓ 缩小 · Enter 确认 · Esc 取消」；
  - 「区域太大，可直接翻译此页」；
  - 读屏播报「已翻译该区域」。
- PR5：读屏播报「该区域不再翻译」。
- PR6：⌘ 按钮的 `aria-label`「指令台（{shortcut}）」。

## 快捷键
- macOS：`MacCtrl+Shift+K`（方向文档定稿）。
- Windows / Linux：`Alt+Shift+K`。
  - 不用 `Alt+K`：Chrome 在这两个平台上用 Alt 触发 accesskey，MediaWiki 的 `k` 是「相关更改」。当初 `Alt+S` 就是因为同类冲突放弃的（`wxt.config.ts:52-53`）。
  - `Alt+Shift+K` 与现有的 `Alt+Shift+S` 写法一致。
- 注册失败时（被其他扩展或系统占用），`shortcuts.get` 读到空串，界面上不显示这个键。用户可以在 `chrome://extensions/shortcuts` 里自己绑定，也能从灵岛 ⌘（PR6）进入。

## 体积（需用户批准）
- **content**：7.5 → **7.75 KB**（PR1 合并时生效）。依据是审查实测：瘦身只省 9 B，最小实现在 7.53–7.57 KB，再加上互斥、失联处理和按住判断。
- **page-runtime**：27 → **28 KB**（PR1 起生效）。PR1、PR4、PR5、PR6 都会改动它：Esc 让步、`region` 的两种用法、⌘ 与铰链联动，合计估算约 1.3–1.8 KB。
- **palette-runtime**：新增预算 **15 KB**。估算 PR1 约 8 KB，PR3 约 +2.5 KB，PR4 约 +3.5 KB（引入 `dom-rules`、完整拦截列表、栈与稳定窗）。按实测落地，超出就再申请。
  - 2026-11-24 用户批准：PR3 实测 14.26 KB，超出估算；palette-runtime 预算提到 **18 KB，已批准，PR4 合并时生效**（随 PR4 修改 `check-size.mjs`，PR3 不改）。
- **background**：两条窄消息约 +0.3 KB，在 60 KB 预算内。

## 最脆弱的假设
1. **指令台的输入框拿到焦点后，网页不会把焦点抢回去，也不会在捕获阶段截走按键。**
   - 会出问题的情形：
     - 带焦点陷阱的网页对话框（例如 focus-trap 库）发现焦点落到容器外，会把它拉回去；
     - 网页在 window/document 捕获阶段监听按键，会先于我们的 `stopPropagation` 收到按键。
   - 应对：
     - 指令台打开期间，在 window 捕获阶段监听 `focusin`，焦点被移出时收回一次；
     - 100 ms 内被连续抢走两次，就放弃并关闭指令台；
     - 捕获阶段截键的情况无法根治，手测时在 Gmail、GitHub、YouTube 上确认没有误触，有问题就作为已知限制写进 known-issues。
2. **`showModal` 对话框与全屏。**
   - 指令台宿主在 top layer 之下，会被遮住并变成 inert；同一层里的任何提示条也一样会被遮住。
   - 处理：
     - 检测到 `dialog:modal` 时，把宿主临时挂进该对话框的子树；手测验证焦点和点击是否正常，未实测，PR1 验证；
     - 不可行时，模态对话框打开期间不打开指令台，写进已知限制；
     - 全屏时与灵岛一致，不显示指令台。
3. **新的默认快捷键能在三个平台上注册成功，升级用户也能拿到。** 不成立时按「快捷键」一节的兜底处理。

## 不做
- **指令台与灵岛合成同一个 DOM 元素或同一个宿主**：见偏离第 1 条。
- **灵岛按钮进入 Tab 顺序或 focusin 展开**：违背「不往网页 Tab 顺序插焦点」。
- **「停靠到…」指令**：设置页已有，少一条内容脚本写配置的路径。
- **「收入生词本」等情境指令**：生词本在 M5，届时登记 `vocab.add`。
- **磁吸生长、`⌥` 偷看原文、段落「原」按钮的生长动效**：
  - `⌥` 偷看原文与 `page.holdKey = 'alt'` 冲突，需要另行设计；
  - 另外两项是动效打磨，与键盘无关。
  - 三项都另行排期，批准后同步修改方向文档第 7 节和 HANDOFF 路线图。
- **区域记忆（CSS 路径）**：与 `m3d.md` 决定 5 一致。
- **输入框就地翻译**（FluentRead 的连按三次空格）：不在 M3c，需要时另开一批，并兼容富文本编辑器。
- **右键菜单加「打开指令台」**：理由同 m3b。
- **在子 frame 里打开指令台**：快捷键消息只发给顶层 frame；焦点在子 frame 时，指令台在顶层打开，关闭后对 iframe 元素调用 `focus()` 交还焦点。

## 回滚
6 个 PR 只改代码，外加一个快捷键声明和两条只读或导航用的后台消息：
- 不新增配置字段；
- 不写存储；
- 没有数据迁移。

回滚任何一个 PR 都不会留下不兼容的状态。

## 验证
- 每个 PR 合并前：
  - `npm run check`（含体积与 i18n）全绿；
  - `npm run test:e2e` 全绿；
  - check skill 审查到没有阻断问题；
  - 用户真机验收。
- 6 个 PR 全部合并后，评估发 v0.5.0。

## PR1 实施记录（#70，分支 `feat/m3c-palette`）
- **范围**：按「PR1 的范围」实现，视觉按 Design 原型 PaletteM3c 画板定稿（输入行、列表、二级列表、halted、位置、动画；结果区、区域选择、列表脚注「以 / 开头只搜索指令」留给 PR3/PR4）。
- **代码**：
  - 新按需模块 `src/entrypoints/palette-runtime.ts`（WAR、`check-build` 的 WAR / `RUNTIME_KEYS` 断言、`check-size` 条目同步）。
  - `src/content/palette/`：`registry.ts`（指令表与匹配排序，纯函数）、`keys.ts`（按键语义与输入法让步）、`focus.ts`（焦点与选区的保存、交还）、`place.ts`（停靠位置）、`styles.ts`（全部样式）、`palette.ts`（DOM、动画、事件）。
  - `src/content/page-state.ts`：`isActive` / `hasRetry` 从 `isle.ts` 抽出，灵岛与指令台共用，保证「重试」条件一致。
  - bootstrap：动作表 `PageActions`（getState/start/stop/toggle/setMode/retryFailed）同时注册 `page.*` 消息并借给指令台；三个按需模块共用一个懒加载器（失败与失联走 `isContextLost`）；`palette.toggle` 失联时回 `page-unreachable` 且不加载，打开前关卡片与小点；`selection.open` 打开卡片前关指令台。
  - 内容脚本 deps 改为通用 `send`（`listEngines` 也走它），三处 `loadRuntime` 合成一个 `loader`。
  - 快捷键 `open-palette`（`Alt+Shift+K` / `MacCtrl+Shift+K`），后台 `onCommand` 发 `palette.toggle` 到 frameId 0。
  - `isle.ts` 的 Esc 让步给 `ET-PALETTE[data-open]`；`hold/watch.ts` 焦点在自家宿主时视为正在输入；`ET-PALETTE` 加入 `dom-rules.ts` 与 `isOwnNode`。
- **体积**（gzip，含两轮审查修复）：content 7.36 → 7.55 KB（预算 7.75；第 2 轮把 `SKIP_TAGS` 里的 `...HOST_TAGS` 展开改成字面值，content.js 7733 → 7728 B）；page-runtime 26.00 → 26.03 KB（预算 28）；selection-runtime 18.17 → 18.19 KB；palette-runtime 8.89 KB（预算 15）；background 57.52 → 57.59 KB。
- **测试**：单测 +88（1788 → 1876，文件 80 → 85；其中审查第 1 轮 +13、第 2 轮 +5）：注册表表驱动 6 种情境 + 匹配排序、按键与输入法、焦点恢复（元素被移除、选区、iframe、文本框不覆盖选区）、位置、DOM（打开聚焦、按键隔离、Enter / ↓ / Tab / 过滤 / 空结果、Esc 交还焦点与选区、二级列表、halted、点别处、抢焦点 100 ms 规则、全屏、模态对话框、动画与减弱动效）、bootstrap（消息路径与 deps 路径一致、互斥、失联、加载失败重试）、灵岛 Esc 让步、按住手势、`isOwnNode`、快捷键分发。e2e 新增 `tests/e2e/palette.e2e.test.ts` 5 条（62 → 67 通过，2 跳过不变）。
- **与方案的偏差**：
  - 「七种情境」中的「快速翻译之后」属于 PR3（`ctx` 在 PR1 只有 `state`），单测覆盖其余 6 种。
  - `PaletteRuntime.toggle()` 不带参数，PR6 需要灵岛位置时再加。
  - 「显示原文（结束翻译）」复用灵岛现有文案 `isle.modeOriginal`（「显示原文（结束本次翻译）」），「翻译此页」复用 `popup.translatePage`，双语 / 只看译文复用灵岛的模式文案；新增文案 7 条（快捷键描述、`palette.label/placeholder/empty/retryFailed/switchEngine/translateWith`），三语同步；`switchEngine` 三语都以「…」结尾（面包屑去掉它显示，yml 注释已写明）。
  - 二级列表的返回箭头只给指针用（`tabindex=-1`、`aria-hidden`），键盘用 Esc、←、空输入 Backspace 返回；这样不必为它新增无障碍文案。
  - 原型里的尺寸、字号、圆角 token（`--et-h-strip`、`--et-space-*`、`--et-fs-inject-*` 等）在 `tokens.css`，Shadow 里只有 `tokens-isle.css`：按约定写成字面值并在 `styles.ts` 注释里注明对应 token，颜色与阴影仍全部引用 `tokens-isle.css`。
  - 二级列表面包屑：整页进行中用「切换翻译服务…」去掉末尾「…」，空闲时用 `popup.translatePage`。
  - 视图指令的字形方框只在中文界面显示「原 / 双 / 译」，其他语言与灵岛一致画线条图标。
- **审查第 1 轮修复**（check skill，无阻断，重要 4 项与建议 10 项）：
  - 由 Enter / Esc 关闭时，在 window 捕获阶段拦掉同一个键的 keyup（一次，最多 1 s），焦点已还给网页，它不经过 Shadow。
  - 先挂监听再聚焦，聚焦后核对 `shadowRoot.activeElement`：网页的同步焦点陷阱也按「被抢焦点」处理。焦点进入 iframe / frame 时直接关闭。
  - 挂进模态对话框后监听它的 `close`；宿主被移除或因对话框关闭而不可见时，快捷键当作已关闭并重新打开；打开期间进入全屏就关闭。
  - `ET-PALETTE` 进入 `SKIP_TAGS` 与会话的 `isOwn`（与 `isOwnNode` 共用 `dom-rules.ts` 的 `HOST_TAGS`），宿主内联 `display:block !important`；灵岛 Esc 让步改为在整个文档里找 `et-palette[data-open]`；灵岛探测也跳过它。
  - 按住手势只在焦点位于 `ET-PALETTE` 宿主时视为正在输入，灵岛与卡片保持原行为。
  - 隔离的事件补上 paste、copy、cut 与 composition 三件；`Send` 收窄为显式白名单（PR1 只有 `engine.options`）；`palette.translateWith` 去掉占位，直接写「用…翻译此页」。
- **审查第 2 轮修复**：聚焦后（含收回一次之后）`shadowRoot.activeElement` 仍不是输入框就关闭（宿主 inert、网页拦焦点）；keyup 守卫期间同一个键的自动重复 keydown 也在 window 捕获阶段拦下，随守卫移除；`SKIP_TAGS` 写字面值，单测核对 `HOST_TAGS` 每项都在其中；补上「首次聚焦失败、收回后成功」与「`checkVisibility()` 为 false 时快捷键重开」两条分支测试。
- **审查记录的偏差与限制**（不改代码）：
  - 折叠途中再次打开时直接重建，不保留弹簧速度（有意为之，新的一次按当前页面重新定位）。
  - 打开期间页面状态不刷新：列表按打开时的 `state()` 计算。
  - 先关卡片再开指令台：若指令台因全屏或加载失败没有打开，卡片也已经被关掉。
  - 二级列表的占位复用灵岛的「这次用哪个引擎翻译」，与指令标题「切换翻译服务…」两种叫法并存。
  - 占位文案在 PR1 用「输入指令」：已在 PR3 更新为方案定稿的「输入指令，或输入要翻译的文字」。
  - 焦点交还到 iframe 内的元素时，keyup 落在 frame 里，顶层的 keyup 守卫会悬挂 1 s，这期间顶层同一个键的 keyup 可能被误吞。
  - halted 横条先打开、灵岛后展开时，一次 Esc 可能同时关掉两层（横条不持有焦点，Esc 由 window 监听；推测，未实测）。
- **已知限制**（未实测，留给手测）：
  - `showModal` 对话框：实现了「宿主挂进最上层模态对话框」，单测用替身验证挂载位置；无头 e2e 未验证真实焦点与点击，按方案手测，不可行时改为模态期间不打开。
  - 真实快捷键无法在 CDP 里按，e2e 用 `palette.toggle` 消息代替；三平台注册、升级用户能否拿到默认键、Gmail / GitHub / YouTube 捕获阶段截键，均待真机验收。
  - 网页在 window/document 捕获阶段注册的按键监听仍会先收到按键（方案「最脆弱的假设」第 1 条）。

## PR2 实施记录（#71，分支 `feat/m3c-palette-extras`）
- **范围**：决定 3 的两条后台窄消息、指令表的 `options.open`、列表行尾的实际快捷键。
- **代码**：
  - 新增 `src/lib/messaging/palette-handlers.ts`（`createPaletteHandlers`，依赖注入 `openOptionsPage` / `getAllCommands`，便于单测）；`background.ts` 只负责注册。`options.open` 调 `runtime.openOptionsPage()` 回 `null`；`shortcuts.get` 调 `commands.getAll()`，只取 `translate-page`、`translate-selection`、`open-palette`，缺失或未分配补空串。两条都要求 `sender.tab?.id` 存在且 `frameId === 0`，否则 `validation/invalid-payload`（同 `page.status`）；不读写存储。
  - `protocol.ts` 新增 `PaletteShortcuts` 与两条消息；`PaletteMessage` 白名单加入 `'options.open' | 'shortcuts.get'`。常驻层 `content.ts` 没有改动：通用 `send` 已能转发，只是类型变化。
  - 注册表新增 `options.open`（`when` 恒真、`rank` -1 排最后、英文别名 settings / options / preferences）；`CommandApi` 新增 `openSettings()`。
  - `palette.ts`：打开时在 `loadEngines()` 旁并行 `send('shortcuts.get')`，用 `epoch` 丢弃迟到结果，失败当作全空；`page.translate` 与 `page.restore` 两行的 `.kb` 显示 `translate-page` 的值，其余行与二级列表不显示；`openSettings()` 先 `close()`（照常把焦点和选区还给网页），再发 `options.open`，失败静默。
- **文案**：新增 1 条 `palette.openSettings`（zh_CN「打开设置」、en「Open Settings」、zh_TW「開啟設定」）。已有的 `popup.settings`「设置」、`popup.goSettings`「去设置」语义不同，没有复用。
- **体积**（gzip）：content 7.55 KB 不变；page-runtime 26.03 KB 不变；selection-runtime 18.19 KB 不变；palette-runtime 8.89 → 9.06 KB（预算 15）；background 57.59 → 57.78 KB（预算 60）。
- **测试**：单测 +17（1876 → 1893，文件 85 → 86）：后台处理函数 9（sender 校验 5 种、`options.open`、`shortcuts.get` 只回三个 name 与补空串）、注册表 1、指令台 7（快捷键填入两行、空串隐藏、请求失败仍打开、迟到结果被丢弃、「打开设置」关闭并发送、发送失败静默、halted 无指令）；已有的两处列表断言补上「打开设置」。e2e +2（67 → 69 通过，2 跳过不变）：「翻译此页」行的快捷键等于同一浏览器 `chrome.commands.getAll()` 里 `translate-page` 的值（为空串时断言不显示，不写死按键字符）；执行「打开设置」后出现 `options.html` 页面。先红后绿：去掉 sender 校验时后台测试 5 条失败，去掉 `shortcuts.get` 请求时指令台 2 条失败，e2e 在旧构建上两条失败。
- **实测**（e2e 观察）：macOS 上 `commands.getAll()` 返回 `⌃⇧A` 这样的符号写法，指令台原样显示。
- **与方案的偏差**：无。

## PR1/PR2 真机验收与补丁（#72，分支 `fix/palette-polish`）
- **验收结果**（用户真机，2026-11-23）：Gmail、Wikipedia、GitHub 页面的输入框里，Esc 关闭、焦点归还、打字不触发网页快捷键均正常；Mac 上 `⌃⇧K` 默认键绑定正常；PR2 的快捷键显示与「打开设置」正常。
- **发现的问题与修复**：
  - 「原 / 译 / 双」字形方框文字不居中：`.pf` 改为 flex 居中、`box-sizing:border-box`，字重 600。
  - 视觉检查补出 5 处：halted 横条文字折行溢出（`.hs` 单行省略）、长服务名挤没标题（`.tr`、`.nt` 限宽 45% 加省略号）、无图标服务的文字标签溢出（`.pi.pf` 宽度自适应、不换行）、行尾服务名与箭头、数字、快捷键的字号与间距（统一 12px，箭头贴近行尾，快捷键等宽数字）。
  - halted 横条改用已有文案 `popup.reloadTitle`（「需要刷新这个网页」），不再复用 `errors.network.pageUnreachable` 的长句，不新增 key；短文案不会被截断，悬停 `title` 一并删除。
  - 焦点在 Chrome 地址栏时按 `⌃⇧K`，指令台在页面上弹出，但键盘焦点留在地址栏，打字与 Esc 都进地址栏，指令台关不掉。现在 `toggle()` 打开前检查 `document.hasFocus()`，为假不打开（已打开时照常可关）。判断放在 `palette.ts` 的打开路径，没有动常驻层 bootstrap，content 体积不变；与划词卡片快捷键的 `hasFocus` 判断一致。
- **测试**：单测 +8（1893 → 1901，文件 86 → 87）：指令台 3（无焦点不打开、焦点回到页面后可打开、已打开时无焦点仍可关闭），新增 `styles.test.ts` 5（字形方框居中与字重、文字标签自适应不换行、行尾文字限宽省略、halted 横条单行省略、行尾字号）；halted 文案断言改为「需要刷新这个网页」。happy-dom 不计算布局，样式只能断言规则本身，真实排版靠真机目测。e2e 在 `harness.ts` 的 `openPage` 里开启 `Emulation.setFocusEmulationEnabled`（测试窗口没有操作系统焦点，`document.hasFocus()` 为假会让指令台打不开），e2e 仍是 69 通过 2 跳过。
- **体积**（gzip）：content 7.55 KB 不变；page-runtime 26.03 KB 不变；palette-runtime 9.06 → 9.12 KB。
- **补丁验收**（用户真机，2026-11-23，#72 合并后）：焦点在地址栏时按 `⌃⇧K` 不弹出，点回页面后正常打开；「原 / 译」字形方框文字居中。
- **已知限制**：
  - 二级列表窄屏下英文 placeholder 被裁，不加省略号：Chrome 不给有焦点的 input 加省略号。
  - 未就绪服务的品牌色图标 50% 不透明度偏暗，与灵岛一致，不改。
  - Windows / Linux 上 `Alt+Shift+K` 与浏览器 accesskey 是否冲突仍未验证。

## PR6 实施记录（#74，分支 `feat/m3c-isle-entry`）
- **范围**：拆分表第 6 行。实施前另定 7 条细则（定位不加接口、⌘ 按钮、接线、文案、互不误伤、焦点、体积），按细则实现。#72 合并后的补丁验收已记在上一节。
- **代码**：
  - 灵岛（`isle/isle.ts`）：工具栏在引擎按钮之后加 `.ib[data-act="palette"]`，14 格线条 ⌘ 图标，笔画同模式图标（1.5、圆头），不加分隔线。按钮加入 `renderState` 的 title 循环、悬停提示的监听数组与 `measureSpots`。`act('palette')` 先 `publishRect()` 再调 `deps.openPalette()`。`open()` 每次展开读一次 `deps.paletteShortcut()`，把 `aria-label` 写成 `isle.palette`（「指令台（⌃⇧K）」），空串时用 `palette.label`（「指令台」）；侧边停靠的 title 与底部停靠的提示都跟着 `aria-label` 走。指令台开着时（`et-palette[data-open]`，判断方式见审查修复 S2、S3，模态对话框里的宿主也认），悬停意图的离开收起与外部按下都不收起灵岛；Esc 让步改用同一个判断。指令台关闭后，下一次指针移动照常判断离开。
  - 几何（`isle/geometry.ts`）：`ISLE_LENGTH` 148 → 186，`ISLE_LENGTH_RETRY` 186 → 224（多一个 32px 按钮和 6px 间距）。
  - 指令台（`palette/palette.ts`、`palette/place.ts`）：不加接口。打开时、每次 `resize()` 时以及打开期间 `data-et-rect` 变化时（审查修复 S6），读 `<html>` 直接子元素 `ET-ISLE` 的 `data-et-rect`，写法同 `card.ts` 的 `readIsleRect`。`placePanel` 新增可选 `anchor`（纯函数）：right 停靠时在灵岛左侧 8px、顶边对齐；left 停靠时在右侧 8px、顶边对齐；bottom 停靠时在上方 8px、右端对齐；最后夹进视口，距边至少 16px。拉出起点：侧边停靠 W=0、H=灵岛高；底部停靠 W=灵岛宽、H=0，锚在右下角。收起时折回同一个起点。底部贴灵岛时，内容淡入按高度的生长比例计算。没有 `ET-ISLE` 或它没有面积时，保持原来的零层逻辑。`onPointerDownOutside` 把 `composedPath` 里的灵岛宿主（同样只认 `<html>` 的直接子元素）当作内部，不关闭。
  - 接线：`PageRuntimeDeps` 新增 `openPalette(): void` 与 `paletteShortcut(): Promise<string>`，`IsleOptions.deps` 的 Pick 同步更新。bootstrap 把 `palette.toggle` 的处理主体抽成 `togglePalette()`，依次做失联判断、关卡片与小点、加载 palette、toggle；消息处理和借给 page runtime 的 `openPalette` 共用这个函数（page 的 lazy 用闭包延迟引用后声明的 palette，`openPalette` 吞掉拒绝）。`BootstrapDeps.runtime` 改为 `Omit<PageRuntimeDeps, 'openPalette'>`。`content.ts` 的 `paletteShortcut` 用现成 `send('shortcuts.get')` 取 `open-palette`，失败返回 `''`。`PaletteMessage` 白名单没有改动。
- **文案**：新增 1 条 `isle.palette`（带 `$1`）：zh_CN「指令台（$1）」、en「Command palette ($1)」、zh_TW「指令台（$1）」。
- **再点 ⌘**：走同一个 `toggle()` 关闭，和再按一次快捷键一样把焦点与选区还给打开前的位置。按 ⌘ 打开时焦点本来就没离开网页（灵岛按钮 `keepFocus`），所以还焦点不会跳到别处。
- **焦点（细则 6）**：`toggle()` 里的 `doc.hasFocus()` 检查保留，⌘ 路径没有跳过它。依据有两条。一是原理：在网页内容区按下鼠标时，浏览器先把焦点交给页面，再派发 mousedown；⌘ 在 click 之后才经 bootstrap 异步调到 `toggle()`。二是 e2e 实测（临时脚本，未入库）：关掉焦点模拟后，新页面的 `document.hasFocus()` 为 false，CDP 发出一次真实输入后变为 true，⌘ 能正常打开指令台。无头窗口没有操作系统焦点，所以「焦点在地址栏时直接点 ⌘」只能留给真机验收。
- **与方案的偏差**：
  - 用快捷键打开时不自动展开灵岛。灵岛缩成小点时，`data-et-rect` 仍是展开后的工具栏位置，指令台贴着这个位置展开。
  - 「打开期间状态不刷新」（PR1 已记录）：点灵岛的其他按钮（切换模式、重试、引擎列表）会先关闭指令台（审查 R1），所以只剩指令台开着时用快捷键（如 Alt+A 整页翻译）切换翻译时才会出现。
  - 方案拆分表写的是 `PageRuntimeDeps.openPalette` 与 `isleRect`。按细则 1 没有加 `isleRect`，改为读宿主上已有的 `data-et-rect`。
  - 「失联后 ⌘ 隐藏」不需要额外代码：会话 halted 时 `isActive` 为假，整个灵岛退场，⌘ 随之消失。
  - 灵岛只在静止时写 `data-et-rect`。e2e 发现刚开始整页翻译、灵岛还没静止时点 ⌘，指令台读不到矩形，落回零层位置。因此点 ⌘ 时先按目标外形写一次（`publishRect` 用的是弹簧目标值，动画中途也准确），仍然只是一次属性写入。
  - 铰链落在指令台朝灵岛的那条边上，距灵岛内侧边 8px 间隔，没有贴住灵岛的边。
- **体积**（gzip，含审查修复）：content 7.55 → 7.60 KB（7728 → 7784 B，预算 7.75 KB，余约 0.15 KB）；page-runtime 26.03 → 26.33 KB（含第 3 轮小修）；palette-runtime 9.12 → 9.54 KB（9772 B）；selection-runtime 18.19 KB 不变。保留了 `paletteShortcut`。
- **测试**：单测 +22（1901 → 1923，文件数 87 不变）：
  - `place.test.ts` 4 条：三种停靠的贴灵岛位置与夹边。
  - `palette.test.ts` 7 条：右、左、底三种停靠的落位与拉出起点；底部停靠按高度淡入，并折回灵岛宽度；无灵岛时保持原逻辑；忽略无面积的灵岛和 body 里的仿冒宿主；resize 时跟随灵岛；按在灵岛上不关闭，按在仿冒宿主上关闭。
  - `isle.test.ts` 8 条：按钮位置与图标、点击调 `openPalette`、动画中途点击先写 `data-et-rect`、有无快捷键两种 `aria-label` 并在每次展开时重读、底部停靠的提示、指令台开着时离开或外部按下都不收起而关掉后恢复、关掉后外部按下照常收起、英文文案。
  - `bootstrap.test.ts` 3 条：`openPalette` 与 `palette.toggle` 行为一致（关卡片与小点、只加载一次、共用同一个指令台）、失联时不加载也不抛错、加载失败被吞掉。
  - 几何常量相关：`geometry.test.ts`、`isle.test.ts`（底部停靠尺寸、提示位置）、`card.test.ts`（灵岛避让的 `data-et-rect` 夹具改为 40×186）同步更新。
  - 先红后绿：换回改动前的 `palette.ts`，新增用例中有 5 条失败；换回改动前的 `isle.ts`，有 7 条失败。
  - e2e：`palette.e2e.test.ts` +1（69 → 70 通过，2 跳过不变）。整页翻译后点小点展开灵岛，真实点击 ⌘：指令台打开，焦点在输入框；指令台右边缘距灵岛左边缘 8px，顶边与灵岛对齐，容差 3px。在指令台里真实点击后，灵岛仍然展开。再点 ⌘，指令台关闭。
- **审查修复**（check skill，两位 Opus 审查者，无阻断）：
  - R1：`act()` 里只要不是 ⌘ 且指令台开着，就先调 `deps.openPalette()`（toggle 关闭并交还焦点），再执行原动作。指令台不再盖住引擎列表，列表状态也不会过期。
  - S1：引擎列表展开时点 ⌘，先 `setView('isle')` 再 `publishRect()`，发布的是工具栏的矩形，列表同时收起。
  - S2：`paletteOpen()` 改为遍历在 `createIsle` 里缓存的 `getElementsByTagName('et-palette')` 动态集合，不再每次指针移动都对全文档 querySelector。
  - S3：`paletteOpen()` 只认合法且可见的宿主：父节点是 `<html>`，或是 `:modal` 的 `dialog`；并且 `isConnected`、`checkVisibility?.() !== false`。网页伪造的宿主、随对话框一起隐藏的宿主都不会把灵岛钉住。
  - S4：指令台开着时在网页别处按下，`onPointerDownOutside` 用 `setTimeout(…, 0)` 在事件派发结束后复查一次，指令台因这次按下关闭了就收起灵岛；定时器在 `unlisten` 里清掉（unmount 与 destroy 都会走到）。
  - S5：`readIsle()` 要求四个有限数，并把 x/y/w/h 夹到视口内，防止 `1e308` 一类的值让弹簧溢出成 NaN、rAF 空转。`card.ts` 不动（selection-runtime 的预算）。
  - S6：指令台打开期间用 MutationObserver 观察 `<html>` 的子元素和当前 `ET-ISLE` 的 `data-et-rect`，有变化就重新定位；关闭与 dispose 时断开。灵岛退场（矩形消失）时按零层位置处理：与「打开时没有灵岛」一致，弹簧平滑移过去；保持原位会让指令台悬在一个已经不存在的东西旁边。灵岛再出现时又贴回去。
  - S7：e2e 不再读 `data-et-rect`，改为量灵岛 Shadow 里 `.bar` 的 `getBoundingClientRect`，比较 8 px 间距与顶边对齐。
  - S8：「动画中途点 ⌘」的单测改为悬停展开、未静止时点击（原先在 dot 视图下用程序点击，真实环境点不到），并断言 Y 取弹簧目标值（`768 × 0.6 − 93`）。
  - 审查修复单测 +10（1923 → 1933）：`isle.test.ts` +6（列表里点 ⌘、其他按钮先关指令台、外部按下关指令台后灵岛随之收起、复查定时器随灵岛清掉、指针移动不查询文档、伪造与隐藏的宿主不钉住灵岛），`palette.test.ts` +4（夹值、非法矩形、打开期间跟随灵岛变长/离开/出现、关闭与 dispose 时断开观察）；改写 1 条（S8），模态对话框用例补上 `open` 与 `:modal` 替身。先红后绿：换回修复前的 `isle.ts` 有 4 条失败（S2 用例另用「每次 querySelector」的替身验证为失败），换回修复前的 `palette.ts` 有 3 条失败；其余为回归保护。e2e 仍 70 通过 2 跳过。
  - 第 2 轮增量审查（Opus，通过，无阻断与重要项）后的小修：点小点展开灵岛时不再关闭指令台（与悬停展开一致，`act()` 排除 `dot`）；`paletteOpen()` 先查 `<html>` 的直接子元素，找不到才遍历动态集合找模态对话框里的宿主；其他按钮先关指令台的用例补上调用顺序断言。单测 +1（1933 → 1934），新用例先红后绿。
- **已知限制**：
  - 视口很窄时，指令台可能整个盖住灵岛，⌘ 点不到（Esc 和点别处仍能关闭）。
  - 视口高度小于约 218 px（出现重试按钮时小于约 256 px）时，⌘ 会溢出灵岛外壳：灵岛长度被夹到视口内，按钮列没有跟着收。
  - 扩展已失联、但会话尚未 halted 的窗口期内，点 ⌘ 没有反应，与快捷键路径一致（`togglePalette` 先做失联判断，不加载）。
  - 指令台打开期间切换停靠位置时，灵岛换到新边，指令台仍按打开时读到的停靠方向贴放（指令台不订阅配置），关掉重开即恢复。
  - 「焦点在地址栏时点 ⌘」与三种停靠的真实观感待真机验收。

## PR3 实施记录（#77，分支 `feat/m3c-quick-translate`）
- **范围**：拆分表第 3 行与「输入语义」一节：输入语义、方向反转（决定 7）、流式结果区、复制、过长与错误提示、列表脚注；顺带修过滤高亮的下标错位。视觉按 Design 原型 PaletteM3c 画板的结果态与脚注定稿值。
- **代码**：
  - `palette/palette.ts`：
    - 输入语义：空输入列全部指令并显示脚注；以 `/` 开头只过滤（中文输入法打出的 `／`、`、` 视为同一个前缀，与 `normalizeQuery` 共用 `registry.ts` 的 `COMMAND_PREFIX`）；其他输入时列表第一行是「翻译“…”」（引号内文字单独截断，结尾引号保留），下面是匹配到的指令。Enter 在没有用 ↑↓ 移过高亮时永远执行翻译；用 ↓ 选中指令后 Enter 执行该指令。有输入、且没按过 ↑↓ 时，列表带 `data-hover`，指针悬停只显示比高亮淡一档的底色（`color-mix` 50%，只在这一状态下有），不改高亮和 `aria-activedescendant`，读屏听到的就是 Enter 会执行的那一行；其他状态下悬停直接移动高亮，不另画底色，所以不会同时出现两行高亮。点击翻译行以外的行后，Enter 跟随点击（与按过 ↑↓ 相同）。输入法组合期间沿用 `keys.ts` 的让步。
    - 翻译：自建 `createCardRequests`（2000 字上限、SW 重启重试一次、迟到帧丢弃），请求 `stream: true`、`force: true`，方向反转时带 `target`。超过 2000 字直接显示指令台自己的过长提示，不做检测也不发请求。同一段文字再按 Enter 不重复请求，出错后再按 Enter 重试。
    - 方向反转：纯函数 `quickDirection(from, target, ui)`。输入是目标语言时译成英文；目标是英文时译成浏览器界面语言；界面语言也是英文时显示「已经是目标语言」，不发请求。`detectLanguage` 失败（含同步抛出）或判为不可靠时，用 `lib/languages.ts` 的 `isTargetScript` 按书写系统兜底，同一书写系统就当作目标语言：有假名且没有谚文算日文；谚文占字母过半算韩文；汉字占字母过半时，目标是简体中文、繁体中文或日文都算同一书写系统；只有拉丁字母时，只在目标是英文时算同一书写系统。检测可靠、但检测到的是不支持的语言（如法语）时不兜底，按原目标语言翻译。读不到配置时按原目标语言翻译。
    - 结果区在输入行与列表之间：方向行（语言名用 `languages.ts` 的自称，检测不到时用 `common.autoDetect`）、可选中的译文、流式光标、最大 168px 内部滚动并在下方有内容时加 22px 渐隐、`aria-live=polite`（流式期间 `aria-busy=true`）。流式增量用同一个 Text 节点 `appendData` 追加，遇到 reset 或最终文本不是延续时才整体替换；「是否贴底」在追加之前判断，所以一次长出超过 24px 也跟随到底，读者往上翻时不拉回。请求进行中输入行的琥珀点外加 1.5px 旋转弧。输入改变（去掉首尾空白后与已发送的文字不同）、进入引擎列表或关闭时，清掉结果并取消在途请求；检测结果迟到也丢弃。结果到达、列表重建时，高亮按行的身份（指令 id、引擎 id、翻译行）找回，不按下标。
    - 复制：「复制译文」只在有译文时出现，排在翻译行之后的第一位（↓ 再 Enter）。用剪贴板 API，失败时在 Shadow 里用 textarea + `execCommand('copy')` 回退，焦点回到输入框；回退前核对译文与指令台仍是同一次，关闭后重开不会把旧译文复制进去。成功后该行约 1.5 s 显示对勾（`--et-color-isle-ok`）和「已复制」，指令台保持打开；关闭再打开后不残留。
    - 译文可以用指针选中：译文区 `tabindex=-1`，按下时不拦默认动作，焦点留在指令台内。译文区有焦点时：可打印字符（含输入法开始组合）、Enter、Esc、Tab、↑↓ 交回输入框处理；Option（macOS）与 AltGr（Windows 上表现为 Ctrl+Alt）组合出的字符、死键也交回输入框；Shift+方向键、PageUp/PageDown、空格、Home/End 与 ⌘ / Ctrl 快捷键（复制等）留在原处，用来扩展选区和滚动；⌘A / Ctrl+A 只选中译文（`selectAllChildren`）。
  - `palette/registry.ts`：`PaletteContext` 新增 `quick`（「最近一次快速翻译的结果」，决定 2）；新增指令 `quick.copy`（`sticky`：有结果时无论查询都排第一；`stays`：执行后不关闭）；`CommandApi` 新增 `copy()`；新增 `COMMAND_PREFIX`。新增纯函数 `matchRange(label, query)`：逐字符转小写并记下原串下标，在原串上切高亮，修掉「İ」这类转小写后变长的字符导致的错位。
  - `lib/languages.ts`：新增 `isTargetScript`（复用已有的假名、谚文、字母正则；常驻层没有用到，tree-shaking 后 content 体积不变）。
  - `selection/request.ts`：`TranslateArgs` 新增可选 `target`；`reliableLanguage` 从 `card.ts` 移到这里，卡片与指令台共用。
  - `entrypoints/palette-runtime.ts`：自建 Port（写法同 `selection-runtime.ts`，首次请求时才连接），借入 `async (text) => browser.i18n.detectLanguage(text)`（同步抛出也变成 reject）。
  - 常驻层（`content.ts`、bootstrap）与 `runtime-contract.ts` 都没有改动。
- **语言检测放在 palette-runtime**：`check:build` 对按需模块只禁 `runtime.id`、`getURL` 与扩展地址，允许经 WXT 的 `browser` 调用 `i18n.detectLanguage`（page-runtime 已有同样写法）。所以没有经 deps 借用，content 体积不变。界面语言用 `lib/languages.ts` 的 `browserUiLanguage()`（`i18n.getUILanguage`），不是扩展加载的 locale 文件。
- **文案**：新增 4 条 `palette.translateText`（带 `$1`）、`palette.alreadyTarget`、`palette.slashHint`、`palette.tooLong`（带 `$1`，2026-11-24 用户定稿：「文字太长（超过 $1 字），请删减后再翻译。」）；改 1 条 `palette.placeholder`。复用 `card.copy`「复制译文」、`card.copied`「已复制」、`card.unchanged`、`common.autoDetect`；错误文案用后台附带的 `userMessage`（`error-text.ts`）。zh_TW 的翻译行用「翻譯「$1」」。
- **已知行为**：快速翻译用设置里的默认引擎，与划词卡片一致，不跟随本页会话的引擎（用户 2026-11-24 确认，代码不改）。
- **体积**（gzip）：content 7.60 KB 不变；page-runtime 26.45 KB 不变；selection-runtime 18.19 → 18.20 KB（`target` 透传）；palette-runtime 9.54 → 14.26 KB（当前预算 15）。其中 Port 客户端约 1.0 KB，其余是请求层、语言表、书写系统兜底、结果区与样式。比方案估算的 +2.5 KB 多约 2.2 KB；用户已批准 PR4 合并时把预算提到 18 KB（见「体积」一节）。
- **测试**：单测 +64（1957 → 2021，文件数 87 不变）：
  - `palette.test.ts` +44：输入语义 10（空输入与脚注、`/` 只过滤不发请求、`／` 与 `、` 前缀、普通输入首行翻译并 Enter 翻译、↓ 选指令再 Enter、有输入时悬停不移动高亮、`data-hover` 随 ↑↓ 与输入切换、点击其他行后 Enter 跟随、输入法组合期间 Enter、长文字只截断引号内）；方向 12（译入目标、目标语言反转为英文、英文目标反转为界面语言、界面也是英文时提示且不发请求、检测失败与不可靠时汉字兜底为英文、其他书写系统不兜底、短「你好」、假名、谚文、拉丁字母只在英文目标时兜底、可靠检测到法语不兜底、`detectLanguage` 同步抛出）；结果 15（流式与光标与旋转弧、同一 Text 节点追加且一次长出超过 24px 仍跟随、往上翻时不拉回、结果到达时高亮跟着行走、同一文字不重复请求且出错后重试、溢出渐隐、输入变化取消请求并丢弃迟到帧、检测迟到不发请求、过长、错误用 `userMessage`、译文区可选中、译文区按键分流、Option / AltGr / 死键交回输入框而 ⌘C / Ctrl+C 留下、⌘A 只选译文、关闭取消请求）；复制 6（只在有结果时出现且排第一、↓ Enter 复制并约 1.5 s 后恢复、剪贴板失败回退 `execCommand`、两种方式都失败时不显示「已复制」、关闭重开后迟到的失败不回退复制、「已复制」不残留）；İ 高亮 1。
  - `registry.test.ts` +3（快速翻译之后的情境、复制指令标题、`matchRange`），并补上 `copy` 的调用断言与 `／`、`、` 前缀断言；`request.test.ts` +2（`target` 透传、`reliableLanguage`）；`styles.test.ts` +2（结果区、脚注、翻译行截断；只在 `.ls[data-hover]` 下有较淡的悬停底色）；`languages.test.ts` +13（`isTargetScript` 表驱动）。
  - 已有用例中按普通文字过滤再 Enter 的，改为 `/` 前缀（Enter 现在翻译文字）；占位断言改为新文案。happy-dom 没有 `document.execCommand`，复制回退用例在每条里定义、`afterEach` 删除。
  - 先红后绿：首轮实现前 `palette.test.ts` 新增 24 条中 21 条失败、`registry.test.ts` 4 条失败。审查修复前新增与改写的用例中 15 条失败（`normalizeQuery` 前缀、全角前缀、悬停、汉字兜底、「你好」、假名、谚文、拉丁、同步抛出、Text 节点追加、高亮跟行、过长文案、译文区按键分流、⌘A、重开后迟到失败）；另有 5 条是旧实现本来就满足的回归保护（其他书写系统不兜底、法语不兜底、往上翻不拉回、同一文字不重复请求与出错重试、「已复制」不残留）。`request`、`styles`、`languages` 与首轮译文区 Esc 用例是实现后补的。
  - e2e：`palette.e2e.test.ts` +4（70 → 74 通过，2 跳过不变）：英文句子 Enter 后，等到服务端收到这一个请求、看到旋转弧再放行（`try/finally` 保证放行），结果区出现 mock 译文，请求的 `tl` 为 `zh-CN`，方向行「English→简体中文」，「复制译文」排在翻译行之后；中文句子的请求 `tl` 为 `en`，方向行「简体中文→English」；`/hello world` Enter 不发任何请求；复制：先在内容脚本的隔离世界里把 `navigator.clipboard.writeText` 换成记录函数，↓ Enter 后断言写入的正是 mock 译文，该行显示「已复制」并恢复。harness 的 `google` 记录新增 `targets`，与 `texts` 按同一下标对齐（每个 `q` 记一次 `tl`）。已有的「只看」用例改为 ↓ 再 Enter，「打开设置」用例改为输入 `/设置`。
- **审查修复**（check skill，两位 Opus 审查者，无阻断）：I1 短输入的书写系统兜底；I2 `／`、`、` 前缀；I3 文档写成终态；S1 `detectLanguage` 同步抛出；S2 高亮按行身份保持；S3 有输入时悬停不改高亮；S4 译文区按键分流与 ⌘A；S5 流式用同一 Text 节点追加、贴底判断前移；S6 回退复制前核对；S7 测试不再直接改写 `document.execCommand`，补重复 Enter、出错重试、「已复制」不残留；S8 e2e 的 `tl` 按 `q` 对齐、放行前等请求到达、读到真实写入内容；用户决定新增 `palette.tooLong`、快速翻译用默认引擎、预算 PR4 提到 18 KB。第 3 轮（增量审查，无阻断）：R1 悬停底色只在「悬停不移动高亮」的状态下启用（`.ls[data-hover]`），并比高亮淡一档，消除两行同时高亮；S-a 点击翻译行以外的行后 Enter 跟随点击；S-b 译文区把 Option / AltGr 组合出的字符与死键交回输入框；S-c 三份 locale 中 `alreadyTarget` 的注释移到该行正上方。第 3 轮单测 +3（2018 → 2021），实现前 4 条失败（含改写的样式断言），locale 注释的位置没有用例可测。
- **与方案的偏差**：
  - 决定 7 写的是用「bootstrap 借出的 `detectLanguage`」；实际在 palette-runtime 里直接调 `browser.i18n.detectLanguage`，理由见上，常驻层零改动。
  - 快速翻译用设置里的默认引擎，不跟随本页会话的引擎（见「已知行为」）。
  - 「Enter 永远执行翻译」落地为：只要没有用 ↑↓ 移过高亮，Enter 就翻译；这期间指针悬停只显示较淡的底色，不移动高亮；点击其他行后 Enter 跟随点击。
  - 「复制译文排第一」指排在指令里的第一位，翻译行仍固定在列表第一行（「输入语义」一节写的是「按 ↓ 再按 Enter 即可复制」）。
  - 过长提示没有复用卡片文案（卡片的写的是「选中的文字」），新增了指令台专用的 `palette.tooLong`。
  - mock 引擎（Google）不分段返回，e2e 只能验证「请求进行中 → 整段出现」，逐段流式与光标由单测覆盖。
- **已知限制**：
  - 短输入：Chrome 对很短的文字（如「你好」）常判为不可靠，现在按书写系统兜底（规则见上）。兜底分不出同一书写系统里的不同语言：日文目标下输入纯汉字的中文、英文目标下输入其他拉丁字母语言的短词（检测不可靠时），都会被当作目标语言而反向翻译；方向行此时显示「自动检测」。
  - 中文输入法下，在译文区按下的第一个键可能以原始字母落进输入框（焦点在 keydown 时才交回输入框，输入法还没接手）。
  - 在译文区按可打印键时，依赖「keydown 期间把焦点移回输入框，字符落进输入框」的浏览器行为，单测只覆盖焦点交回。
  - 翻译行引号内文字被截断时，省略号与结尾引号之间可能留出不到一个字宽的空隙（`text-overflow` 按整字裁切）。
  - 真实剪贴板（系统剪贴板）的内容与回退路径未在 e2e 中验证：e2e 记录的是 `writeText` 收到的文字，待真机验收。

## 附录 A：第 1 稿审查处理记录（Opus 对抗式审查，2026-11-23）
| 编号 | 问题 | 处理 |
|---|---|---|
| B1 | 在指令台里打的字会冒泡到网页，触发网页的快捷键 | 采纳：Shadow 内对按键与输入事件 `stopPropagation`；捕获阶段的残余风险写进最脆弱的假设，并加入手测网站（决定 4） |
| B2 | 区域翻译没有上限，局部译文也没有撤销入口 | 采纳：沿用 2 万字上限；`page.restore` 对局部会话也可用 |
| I1 | 抽通用加载器省不出空间 | 采纳实测结果：申请 content 7.75 KB；deps 改为通用 `send` |
| I2 | Esc 层级的前提有误，要改 `card.ts` 和 `isle.ts` | 改为三者互斥（决定 5），不改 `card.ts`；`isle.ts` 的 Esc 让步计入 PR1 |
| I3 | `exclude` 只在 discover 里判断，挡不住已登记的单元 | 判断放进 `want`/`register`/渲染过滤三处，并取消在途段；路由变化和 `stop` 时清空；按住时解除整个区域的排除 |
| I4 | 区域选择期间焦点还给了网页，拦截列表也不全 | 焦点留在 `ET-PICK` 内，用完整拦截列表，右键退出；常驻层零改动 |
| I5 | 输入前缀会高亮指令，容易误触 | 非 `/` 输入时 Enter 永远执行翻译 |
| I6 | 快速翻译只能译成目标语言 | 方向反转（决定 7），使用协议已有的 `target` 和 `force` |
| I7 | 灵岛铰链漏了两套状态机的联动 | 写进 PR6 的范围与体积 |
| I8 | `showModal` 下提示条同样会被遮住 | 改为挂进对话框子树，或模态期间不打开，写进最脆弱的假设 |
| I9 | 扩展重载后旧页面上指令台的行为没定义 | 加载走 `isContextLost`；`halted` 时显示刷新提示；失联后隐藏 ⌘ |
| S1 | 引用行号有误 | 已逐处更正 |
| S2 | 有未声明的偏离 | 补上同宿主偏离、路线图变更、DOM 约定 |
| S3 | PR1 过大，PR3 应拆开 | 拆成 6 个 PR |
| S4 | `isle.dock` 可删；窄消息要校验 sender | 删掉 `isle.dock`；两条窄消息校验 sender |
| S5 | `Alt+K` 与 accesskey 冲突，还缺 build 断言 | 改用 `Alt+Shift+K`；补 build 断言；按快捷键可开可关 |
| S6 | 部分指令的可用条件有误 | `retry` 与 `hasRetry` 一致；`halted` 时禁用；`engine.switch` 标题按状态区分；底部停靠的位置另行规定 |
| S7 | 在指令台里按住 Ctrl 会切换段落 | `isTypingFocus` 把自己的宿主算作正在输入 |
| S8 | 体积估算偏乐观 | page-runtime 一开始就申请 28 KB；palette-runtime 预算改为 15 KB |
| S9 | iframe 里关闭后焦点回不去 | 改为对 iframe 元素调用 `focus()` 交还焦点 |
