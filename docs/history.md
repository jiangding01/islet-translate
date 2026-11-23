# 项目历史归档

> 从 `HANDOFF.md` 搬出的历史记录（2026-11-23 精简交接文档时整理），内容按原文搬运，不改写事实。里面出现的「第 N 节」「本文」均指精简前的旧 HANDOFF 章节。仍然有效的已知限制与后续项见 [`known-issues.md`](known-issues.md)。新的进度写进 `CHANGELOG.md` 和本文件，不再写进 HANDOFF。

## 目录

1. 进度日志（原第 9 节，按时间倒序）
2. 里程碑批次记录（原第 4、5 节：M0 / M1 / M2 / M3a / M3d / M3b、i18n、改名、e2e、v0.2–v0.4 发版、Codex 复核、界面方向、竞品痛点、对 M2 及以后的约定）
3. 假设验证表（原第 6 节）
4. 旧开发流程与 i18n 真机验收注意（原第 8 节）
5. 原「最后更新」流水账（原文件开头一段）

## 1. 进度日志（原第 9 节）

| 日期 | 事项 |
| --- | --- |
| 2026-11-20 | **v0.4.0 发版 PR**（#68，分支 `chore/release-v0.4.0`，方案与实施记录 `docs/plans/release-v0.4.0.md`）：版本号 0.4.0；CHANGELOG `[未发布]` 归入 `[0.4.0] - 2026-11-20`，加 5 条「本版要点」（用户确认），底部比较链接更新；README 双语安装示例改为 v0.4.0，路线图 M3b 与 v0.4.0 标为已完成。合并后经用户确认推送 `v0.4.0` 标签，由发版工作流创建 Release。下一步 M3c 指令台与灵岛键盘。 |
| 2026-11-20 | **M3b PR5 已合并（#66）；PR6 设置项「按住翻译段落」已提交**（`#67`，分支 `feat/hold-toggle-setting`，实施记录 `docs/plans/m3b.md` 第 6 节；M3b 的最后一个 PR，六个 PR 全部完成）：设置页「网页翻译」卡片新增一行（en「Hold to translate」、zh_TW「按住翻譯段落」），选项 Ctrl / Alt / 关（macOS 显示「⌃ Control」「⌥ Option」），默认 Ctrl，文案用户 2026-11-20 确认；选「关」后不再响应，切换立即生效，切换后需先移动指针。实现：新配置 `page.holdKey`（types/schema/defaults，`normalizeConfig` 校验，旧配置补 `'ctrl'`，不升 schemaVersion）；常驻 `src/content/hold/watch.ts` 读配置后才挂监听，按配置挂/撤或换键，Alt 模式作废条件与 Ctrl 对称，Alt 模式手势触发后拦截该次松键默认动作；设置页新增 isMac（`navigator.platform`）与按键标签。Deep 审查（Opus 对抗式），HIGH 1 条：扩展重载后旧页面停止手势监听时先退订配置会抛错，导致监听残留、划词小点不隐藏，已改为先撤监听再退订并吞掉异常，划词监听的 `stop()` 与 `ensureConfig` 失败分支（M3a 既有）同形问题一并修复，均先红后绿；LOW：Ctrl 模式不再拦截松键等；第 2 轮无新问题。体积：content 7.36 / 7.5 KB，page-runtime 26.00 / 27 KB，popup 83.28 / 90 KB，options 89.67 / 150 KB。单测 1788 个（80 个文件，PR5 后 1762），e2e 新增 1 条，共 62 通过 2 跳过。已知限制见第 5 节。下一步按发版节奏准备 v0.4.0 发版 PR（打 tag 前先问用户）。 |
| 2026-11-20 | **M3b PR4 已合并（#64）；PR5 不开整页也能按住 Ctrl 译段已提交**（`#66`，分支 `feat/hold-toggle-scoped`，实施记录 `docs/plans/m3b.md` 第 5 节）：没开整页翻译时，指针停在段落上按住 Ctrl（macOS ⌃）约 0.6 秒，也能只翻译这一段（「局部」状态），再按住还原；局部下灵岛不出现、状态点不点亮、面板仍显示「翻译此页」；之后点「翻译此页」、整页快捷键或右键菜单升级为整页，已译的段沿用原译文。实现：会话新增 scope（对外 `PageState.scope?: 'units'`，整页与空闲不带）；`toggleAt` 空闲时先命中与预检再 begin 局部会话（不建视口观察器、不整页扫描）；升级不 clearState、不增 epoch、第一个 await 前切到 running 并通知，刷新样式缓存、对账沿用译文，源/目标语言变了先清除再整页开始；局部下变动只做 prune；`autoStart` 照常升级；灵岛 `isActive` 与面板 `pageActive` 把局部视为未激活；`bootstrap.holdToggle` 无会话时加载 page-runtime。顺带修复渲染批次可能在形态变化后插出第二份译文（过滤掉已被 forget 的单元）。**用户决定：不加面板「还原 N 段」一键清除入口**。体积：content 7.15 / 7.5 KB，page-runtime 26.00 / 27 KB（增 0.35 KB），popup 83.22 / 90 KB。单测 1762 个（79 个文件，PR4 后 1737），e2e 新增 2 条，共 61 通过 2 跳过。Deep 审查两位 Opus（会话生命周期、可见性与入口），无 HIGH，MEDIUM 5 条与若干 LOW 修复，会话类修复均先红后绿，第 2 轮增量审查无新问题。已知限制见第 5 节。下一步 PR6 设置项（`page.holdKey`，新文案需用户确认）。 |
| 2026-11-20 | **缓存单测偶发超时已修复并提交**（`#65`，分支 `fix/cache-test-flaky`）：`cache.test.ts` 的「keeps serving reads while a large eviction runs in batches」在全量单测中偶发 5s 超时（修复前 8 轮中 1 轮 5004ms，其余 3.0–3.7s，单独跑约 1.26s）。根因是测试数据量：6000 条记录在 fake-indexeddb 中填充约 870ms、淘汰约 630ms，耗时随记录数线性增长；`cache.ts` 没有缺陷，未改动。改为 65 条记录、`evictBatchSize: 5`，批次结构（13 个读写事务）与断言不变；同类的两个清扫用例改用 `sweepBatchSize: 5`。修复后全量 8 轮全过，该用例 57–155ms；变异去掉每批上限会变红；`npm run check` 连续 3 次通过（1675 个用例）；check 审查无问题。CHANGELOG 不加（用户感知不到）。 |
| 2026-11-19 | **M3d 拆分决定与 B1 已合并**（#54，分支 `fix/session-pinned-engine`，方案与实施记录 `docs/plans/session-pinned-engine.md`，经 Opus 对抗式审查后获批）：M3d 拆分与用户决定见 `docs/plans/m3d.md`；B1 让会话开始时固定实际引擎（改默认引擎不再影响已打开的页面，灵岛与面板显示实际引擎，面板页脚显示「默认引擎」标签），`setMode` 串行化（快速连切停在最后一次）；删除正在使用的自定义引擎后已打开页面暂停并提示。单测 1561 个用例，page-runtime 23.23 KB，popup 83.17 KB，`npm run check` 与 e2e 全绿，check 第 1 轮无阻断问题。下一步 B2 先监听后扫。 |
| 2026-11-20 | **M3b PR3 已合并（#63）；PR4 整页会话内按住 Ctrl 切换段落已提交**（`#64`，分支 `feat/hold-toggle`，实施记录 `docs/plans/m3b.md` 第 4 节）：整页翻译进行中，指针停在段落上按住 Ctrl（macOS 为 ⌃）约 0.4 秒，切换这一段：已译则还原并本次不再翻（「不翻译此段」），再按住恢复；失败段重试；未轮到的段立即翻译；正在翻译的段视为取消；用户停止整页翻译后记录清空；未开整页时手势不起作用（PR5 支持）。防误触只认 isTrusted 事件，夹带其他键、预先按着其他修饰键、滚轮、鼠标按下、拖拽、输入法、可编辑区、灵岛与划词卡片、失焦后未移动指针都不触发，每次按住只触发一次，移动超过 6 px 重新计时。实现：常驻 `src/content/hold/watch.ts`，`bootstrap.holdToggle` 只在已有运行中会话时转交；`session.toggleAt` 按命中点找祖先链过 `isSkipped`、先找未变化的已注册单元再对该块 rescan 对账；「不翻译此段」为 `WeakMap<根元素, Set<seg.text>>`；render 新增 `unitOf`。体积：content 6.59 → 7.16 KB（预算提到 7.5 KB），page-runtime 25.17 → 25.65 KB（余约 1.35 KB 给 PR5）。单测 1737 个（79 个文件，PR3 后 1675），e2e 新增 hold.e2e 3 条，共 59 通过 2 跳过。Deep 审查两位 Opus（手势层、会话层）无 HIGH，MEDIUM 5 条与若干 LOW 全部先红后绿修复，第 2 轮增量审查无新问题。已知限制见第 5 节；400 ms 阈值待用户真机验证。 |
| 2026-11-20 | **M3b PR2 已合并（#62）；PR3 常驻层瘦身已提交**（`#63`，分支 `refactor/content-slim`，实施记录 `docs/plans/m3b.md` 第 3 节）：「总是翻译此站」的语言判断（`sampleText`、`pageIsInLanguage`）移到按需加载的 page-runtime（新文件 `src/content/page-language.ts`），常驻层只看站点记忆，命中就加载 page-runtime 并调用新入口 `session.autoStart()`：页面已是目标语言则不开始、不上报状态；检测完成后确认会话仍空闲才开始，防止与手动开始竞态；bootstrap 的 `startIfIdle` 改名 `autoStart`。行为变化（已批准）：名单内站点即使页面已是目标语言也会加载 page-runtime，但不插 DOM、不建 Port、不上报状态。体积：content 6.99 → 6.59 KB，page-runtime 24.56 → 25.17 KB，预算按批准方案提到 27 KB。单测 1675 个（78 个文件，新增 `session.autoStart` 4 个用例），e2e 无改动；check 审查无问题，既有一条不计入（语言检测期间用户手动开始又停止，检测结束后仍会自动开始，改动前同样存在，概率极低）。**同日 e2e 已设为 main 必过**（经用户授权加入 `main protection` 规则集，此前 CI 连续 13 次完成运行 e2e 全绿且无重试告警；现必过 check、dependency-review、analyze、e2e）。 |
| 2026-11-20 | **M3b PR1 已合并（#61），PR2 版面安全已提交**（`#62`，分支 `fix/layout-safe-inline`，实施记录 `docs/plans/m3b.md` 第 2 节）：作者把单元锁成单行时不再翻译，在会话 `want` 之前判断，不发请求、不计费、不显示加载点、不计入计数。条件：行内追加（行内 run 或弹性/网格根）且根元素 `white-space` 为 `nowrap`/`pre`；或任何单元 `text-overflow: ellipsis` 加 `nowrap`/`pre`（Tailwind `truncate`）。与方案原文的差异：不含 line-clamp（现有渲染会解除 line-clamp 照常显示译文，M2a 决定）。新增纯函数 `isSingleLineLocked`，PR4 按住修饰键时可绕过。单测 1671 个（77 个文件，较 PR1 新增 12 个），e2e 新增 1 条，新增手工验收页 `tests/fixtures/layout-safety.html`，page-runtime 约 24.56 / 25 KB，预算未调；check 审查无问题，建议级一条（超过 5000 字且 nowrap 的段落仍追加「过长」提示，极少见，未处理）。 |
| 2026-11-20 | **M3b 方案获批，PR1 已提交**（#61，分支 `fix/letterless-and-separators`，拆分文档 `docs/plans/m3b.md`）：方案经 think 与两轮 Opus 审查后获批，拆 6 个 PR，体积预算为 content 7.5 KB（PR4 生效）、page-runtime 27 KB。PR1：不再翻译没有可译文字的段落（只含行内 code、`role=img` 或只剩数字），并剥掉段落首尾与正文隔开的纯分隔符（• · › » | 等，保留 ✓ ✗ ★ → 与法语书名号配对的结尾），原文不变；单测 1659 个（77 个文件），e2e 新增 1 条，page-runtime 24.46 / 25 KB，check 审查 2 轮（第 1 轮发现 `« Bonjour »` 结尾被剥，已先红后绿修复，第 2 轮无新问题）。 |
| 2026-11-19 | **v0.3.0 发版 PR**（#60，分支 `chore/release-v0.3.0`，方案与实施记录 `docs/plans/release-v0.3.0.md`）：版本号 0.3.0；CHANGELOG `[未发布]` 归入 `[0.3.0] - 2026-11-19`，加 6 条「本版要点」（用户确认），底部比较链接更新；README 双语安装示例改为 v0.3.0，路线图 M3d 与 v0.3.0 标为已完成。合并后经用户确认推送 `v0.3.0` 标签，由发版工作流创建 Release。下一步 M3b。 |
| 2026-11-19 | **发版前界面小修已合并**（#59，分支 `fix/pre-release-polish`，方案与实施记录 `docs/plans/pre-release-polish.md`，经 Opus 审查（无阻断，应修 3 条已并入）后获批）：6 项要点：body 加 `font: inherit`（Chrome 给扩展页注入的 75% 字号与系统字体，使设置页设置项标题与导航只有 10.5px，现 14px）；「样式」四张预览块等高；面板底栏上下留白（42px 到 52.6px）；添加服务弹窗占位符改用正文字体；行内与 flex 中的状态提示不再被拆行；验收页 Shorten 只改第一个 `p.dyn`。README 设置页两套 4 张截图重拍。`npm run check` 通过（1649 个用例），新增 e2e 1 条（改样式前红，变异验证变红），全量 e2e 54 通过、2 跳过，page-runtime 24.03 / 25 KB（预算已提到 25 KB）、content 6.99 KB、popup 83.20 KB，check 主会话审（Quick）无问题。下一步发 v0.3.0（打 tag 前先问用户）。 |
| 2026-11-19 | **M3d PR-E 已合并**（#58，分支 `fix/spa-route-cooldown`，方案与实施记录 `docs/plans/spa-route-cooldown.md`，经 Opus 对抗式审查（阻断 2 条）后按实测重写获批）：e2e 覆盖 `pushState` 替换主内容等 11 种场景；修两处整页重扫冷却：扩展自己移除的译文不算变动、URL 变化时冷却降到 1s；不加监听、不包 `pushState`；另加超长段落手工验收页。`npm run check` 通过（1649 个用例），e2e 53 通过、2 跳过，page-runtime 23.99 KB（余量约 7 B，未提预算）、content 6.99 KB，check 两轮（第 2 轮无新问题）。M3d 全部完成，下一步发 v0.3.0（打 tag 前先问用户）。 |
| 2026-11-19 | **M3d PR-C 已合并**（#57，分支 `feat/skipped-count`，方案与实施记录 `docs/plans/skipped-count.md`，经 Fable 5.2 裁决与两轮 Opus 对抗式审查后获用户批准）：超过 5000 字符的段落登记为不发送的单元，段末显示「此段过长，未翻译」，面板显示「N 段过长，未翻译」，灵岛读屏在完成时播报；同时修复灵岛完成播报被开始播报覆盖。新增约 38 条单测加 1 条 e2e，`npm run check` 通过（1639 个用例），e2e 42 通过、2 跳过，content 6.99 KB、page-runtime 23.89 KB（未提预算）、popup 83.20 KB，check 两轮（第 2 轮无新问题）。下一步 M3d PR-E（SPA 路由 e2e），之后发 v0.3.0。 |
| 2026-11-19 | **M3d PR-D 已合并**（#56，分支 `feat/skip-ui-mock-regions`，方案与实施记录 `docs/plans/skip-ui-mock-regions.md`，经 Opus 对抗式审查后获批）：`role=img` 子树不再翻译、行内 `role=img` 原样保留；代码块上方的语言、文件名与复制按钮栏不再翻译；站点表首条 claude.dev 的 `.efx-fig`（界面示意图）。新增 24 条单测，`npm run check` 通过（1595 个用例），e2e 41 通过、2 跳过，page-runtime 23.63 KB，check 第 2 轮无新问题。既有问题：只含行内 `code` 或 `role=img` 的块会发出只有占位符的请求，已记入待处理。下一步 M3d PR-C（跳过计数「N 段过长，未翻译」）。 |
| 2026-11-19 | **M3d B2 已合并**（#55，分支 `fix/session-watch-before-scan`，方案与实施记录 `docs/plans/session-watch-before-scan.md`，经 Opus 对抗式审查后获批）：会话先监听后初扫，扫描期间的脏元素缓存、扫完统一 rescan，配置订阅提前到读配置之前；`discover` 把扫描期间追加的未访问子元素当块边界（行内父元素除外），不再并块；e2e 第 19 条启用（隔离世界包装 `scheduler.yield` 做暂停点）。单测与 e2e 共 1571 个用例，page-runtime 23.27 KB，`npm run check` 与 e2e 全绿，check 第 2 轮无新问题。下一步 M3d PR-D（跳过界面示意区域）。 |
| 2026-11-18 | **v0.2.0 发版**（分支 `chore/release-v0.2.0`，方案与实施记录 `docs/plans/release-v0.2.0.md`）：版本号 0.1.0 改为 0.2.0（`package.json`、`package-lock.json`）；CHANGELOG「未发布」归入 `[0.2.0] - 2026-11-18`，顶部加面向用户的「本版要点」；新增发版工作流 `.github/workflows/release.yml`（推送 `v*` 标签：校验标签与版本、CHANGELOG、提交在 main 上，跑完整检查与 `npm run zip`，附 zip 与 SHA-256 创建 Release，说明取自 CHANGELOG）；README 双语安装一节新增「从 GitHub Release 下载」；路线图该项改为已完成。标签由用户确认后推送。 |
| 2026-11-18 | **冒烟 e2e 第 15 条与扩展重载后报错修复已合并**（#51，分支 `feat/e2e-reload-extension`，方案与实施记录 `docs/plans/e2e-reload-extension.md`，经 Opus 对抗式审查后获批，「失联即 halt」由用户选择一并做）：实测发现扩展重载后旧页面会报未处理的「Extension context invalidated」，原因是内容脚本取文案的 `lookup()` 没接住失联时同步抛出的 `getMessage`。修复：`lookup()` 捕获异常返回空串；`session.ts` 新增可选 `alive()`，失联后下次通知即 halt（灵岛卸载、译文保留），`page-runtime.ts` 传入 `i18n.getUILanguage()` 是否可调用的判断（最初读 `browser.runtime?.id`，被 `check:build` 防探测规则拦下）；方案外两处：halt 里退订 `storage.onChanged` 包 try，`begin()` 扫描期间失联立即 halt。harness 新增 `reloadExtension()`（717 行，用 `developerPrivate` 开开发者模式后 `runtime.reload()`），新增 `reload.e2e.test.ts` 4 条（翻译中重载、完成后页面变动、重载后点灵岛、重载后新页面能翻译）与单测 2 条。先红后绿：修复前 A、B 报错、C 灵岛不消失，修复后全绿；变异去掉 `lookup` 捕获则 A、C 变红（B 仍绿，因 `alive` 先触发 halt），去掉 `alive` 则 C 变红。同类排查：失联后同步抛错的 API 共 7 个，除 `getMessage` 外调用点都在 async 或 try 内。验证：lint、tsc、`npm test`（1552 个用例）、build 通过，page-runtime 23.10 增至 23.16 KB，其余不变，`reload.e2e` `--retry=0` 连跑 5 次全绿，全套 e2e 38 通过、2 跳过。check 第 1 轮无阻断问题。已知限制：`developerPrivate` 只在本机 macOS 验证过。<br>CI 曾因 `check:build` 的防探测规则失败（内容脚本不得读取扩展 ID），改为 `i18n.getUILanguage` 判断失联后通过，合并后 CI（ubuntu）上 `reload.e2e` 通过（Linux 共 40 通过）。<br>**下一步**：观察 e2e 未经重试全绿的次数，满约 10 次由用户在规则集设为必过；然后准备 v0.2.0 |
| 2026-11-18 | **Codex 第 5 条缓存清扫与如实报错已合并**（#50，分支 `fix/cache-honesty`，方案与实施记录 `docs/plans/cache-honesty.md`，经 Opus 对抗式审查后获批，新增文案用户已确认）：缓存新增 `sweepExpired`，按 `createdAt` 全表分批清扫过期记录（每批不超过 500 条，同事务扣 `meta.totalBytes`，最后一批同事务写 `sweptAt`），本次 SW 生命周期第一次 `put` 后触发，24 小时节流，失败只记警告；`clear` / `stats` 失败改为如实抛 `internal/cache-unavailable`，其余缓存操作仍降级；设置页统计失败显示新文案「暂时无法读取缓存」，清空按钮仍可点。不改 `background.ts`、权限与 DB 版本。已知限制：清扫每次从头扫，缓存极大时若 SW 中途被回收可能长期扫不完，此时由 100 MiB 的 LRU 淘汰兜底；设置页 unavailable 状态只有单测，需手工看。测试：新增 13 条（cache 11、admin 1、copy 1），变异四组均变红。验证：lint、tsc、`check:i18n`、`npm test`（1550 个用例）、build 通过，background 57.13 增至 57.52 KB，options 89.10 增至 89.32 KB，e2e `--retry=0` 连跑 2 次，34 通过、2 跳过。check 第 1 轮无阻断问题。<br>**下一步**：按排期做第 15 条重载扩展 e2e 小 PR，然后准备 v0.2.0；e2e 设为必过仍待连续约 10 次未经重试全绿 |
| 2026-11-18 | **Codex 第 7 条面板「仍然翻译」已合并**（#49，分支 `fix/popup-translate-anyway`，方案与实施记录 `docs/plans/popup-translate-anyway.md`，经 Opus 对抗式审查后获批，新增文案用户已确认）：面板在页面 `<html lang>` 等于目标语言（native）时，原有提示下方新增次级按钮「仍然翻译」（复用 `IdleActions` 的 anyway 变体，引擎未就绪时换成用 Google 翻译一次）；native 也显示目标语言选择与页面语言名；「总是翻译此站」在 native 页面始终不显示。不改页面语言判断、内容脚本、会话与后台同语言跳过。已知限制：整页全是目标语言时点「仍然翻译」不会出译文，与快捷键一致。测试：新增 `tests/fixtures/e2e-native.html` 与 e2e 用例，去掉 native 按钮、`canAlways` 改回原条件两组变异均变红。验证：lint、tsc、`check:i18n`、`npm test`（1536 个用例）、build 通过，popup 83.09 增至 83.15 KB，e2e `--retry=0` 34 通过、2 跳过。check 第 1 轮无阻断问题。<br>**下一步**：合并后做第 5 条缓存清扫与如实报错，方案已获批在 scratchpad，开分支时移入 `docs/plans/cache-honesty.md` |
| 2026-11-18 | **e2e PR2 已合并**（#48，分支 `feat/e2e-smoke-pr2`，方案与实施记录 `docs/plans/e2e-smoke-pr2.md`，经 Opus 对抗式审查后获批）：新增 10 条用例（仅看译文布局、动态内容、总是翻译此站、引擎 403、SW 被停后继续、丢标签与回显重试、快速停止再开始、面板真实链路），harness 由 627 行增至 680 行（Google handler 区分 html 与 single、`setViewport`、`extPage` 的 `preload`）。**偶发失败根因**：面板用例的等待条件弱于断言，面板经过「正在載入…」「正在讀取頁面…」过渡态时就放行，CPU 节流可复现；改为等到 blocked 文案，修复后 30 次 `--retry=0` 全绿，旧版节流下 16 次失败 1 次。CI 对靠重试才通过的用例输出 `::warning::` 注解并打印首次失败的错误，产物上传改为 `!cancelled()`。check 两轮：第 1 轮发现布局用例只比边框盒、测不出百分比内边距被钉成像素（中，已改为同时比内容盒，变异验证变红），另有用例名、注释、`ExtPage.close` 吞错、上传条件、换行转义等 5 处低级别问题，均已修复；第 2 轮复审修复增量无阻断问题（A 的内容盒比较经变异验证会红，E 只容忍目标不存在，F 取消时不上传）。验证：lint、tsc、`npm test`（76 文件 1536 用例）、build 通过，e2e `--retry=0` 整套连跑 2 次全绿（33 通过、2 跳过，约 37 秒），无残留浏览器进程与临时目录。<br>**下一步**：合并后观察 CI 未经重试全绿的次数，满 10 次由用户在 `main` 规则集把 `e2e` 设为必过；之后按排期做第 15 条小 PR 与 v0.2.0 前的第 7、5 条小 PR |
| 2026-11-18 | **段落加载态已合并**（#47，分支 `feat/paragraph-loading`，方案与实施记录 `docs/plans/paragraph-loading.md`，经 Opus 对抗式审查后获批）：整页翻译时段落在视口内等译文超过 600 毫秒，段末显示琥珀小圆点（`<et-tr data-et-state="loading" aria-hidden="true">`，无文字，不进 `rendered` 表），译文或失败占位同帧替换；点重试后立即显示。`render.ts` 新增 `showLoading` / `hideLoading` / `hideAllLoading`；`session.ts` 用 `wantedAt` 加固定 300 毫秒扫描；`mutations.ts` 新增 `ignoreRemoved`，替换加载点不触发重扫；`halt` 后与引擎暂停期间重试不显示。推翻 `m2-page-translation.md` 附录 A 的「不做加载指示」。实测：视口上方插入译文，原生滚动锚定完全补偿；视口内插入只保住视口顶部那段（已更正 `m2-page-translation.md`、`ui-isle-direction.md`）；不做手动锚定，用 e2e 锁定。新增 e2e `loading.e2e.test.ts` 4 条，harness 的 Google mock 支持延迟回包。变异验证 12 项变红，另一项是等价变异。check 两轮：第 1 轮（Opus）修了替换加载点触发重扫、`halt` 后重试残留、视口只判纵向等 6 处与 3 处空过测试，第 2 轮无阻断。验证：lint、tsc、`npm test`（76 文件 1536 用例）、build 通过，page-runtime 22.31 到 23.10 KB（预算 24），e2e `--retry=0` 多次连跑 24 通过、2 跳过。**未做**：手工验收（调大 mock 延迟看外观、深色站点、减少动态效果），请用户点一遍。<br>**下一步**：合并后按排期做 e2e PR2；另有待办「`setMode` 未串行化」（见第 5 节 6c） |
| 2026-11-18 | **Codex 第 2 条样式精确恢复已合并**（#46，分支 `fix/translation-only-style-restore`，方案 `docs/plans/translation-only-style-restore.md`，经 Opus 对抗式审查后获批）：退出「仅看译文」整串覆盖 style，会抹掉网页在这期间的改动。`render.ts` 中 `Rendered.only` 改为 `{ original, applied }`，`applyOnly` 钉完后立即读回存为 `applied`；新增 `restoreStyle`：现值等于 `applied` 就整串还原，网页删掉 style 属性则保持无属性，否则写回原样式并重放网页的改动（逐个长写属性比较值与优先级），最后原本无 style 且已空则读一次后删属性。**空 `style=""` 根因**：Chrome 中 `style.setProperty` 后属性惰性同步，直接 `removeAttribute` 会在之后序列化时补出 `style=""`，Chrome for Testing 158 纯 DOM 复现，与扩展和动画无关；`removeAttribute` 前读一次 `getAttribute('style')` 即可避免（happy-dom 没有这套惰性同步，单测抓不到）。新增 `render.test.ts` 6 条；e2e 把 `it.fails` 改为普通 `it`，新增两条（保留网页改的样式、`var()` 简写 margin），提前完成 e2e PR2 第 18 条。变异验证：改回整串覆盖则单测 5 条与两条新 e2e 变红；两处读取都去掉则空 style 的 e2e 变红；只去掉还原开头那次读取仍绿。验证：lint、tsc、`npm test`（76 文件 1510 用例）、build 通过，page-runtime 22.13 到 22.31 KB，e2e 连跑 3 次全绿（macOS 20 通过、2 跳过），check 第 1 轮无阻断问题。<br>**下一步**：合并后做「段落加载态」（见第 5 节，评估见 `docs/reviews/2026-11-18-ux-triage.md`） |
| 2026-11-18 | **P1 编辑区重扫修复已合并**（#45，分支 `fix/rescan-protected-areas`，方案 `docs/plans/rescan-protected-areas.md`，经 Opus 对抗式审查后获批）：Codex 评审第 1 条，动态重扫可从编辑区等受保护区域内部开始，草稿被送去翻译。`dom-rules.ts` 拆出 `isProtected`（跳过规则去掉 hidden、inert、aria-hidden）并新增 `protectedAncestor`，`session.ts` 的 `rescan` 对每个被改动元素先查到 body 之间的祖先，命中就跳过。新增 `dom-rules.test.ts` 8 条与 `session.test.ts` 7 条，e2e 提前完成 PR2 第 17 条；(c) 因行内 span 会被爬升后丢掉，补了 `display:block` 的可编辑 span。变异验证：去掉检查后 (a) 到 (e) 与新 e2e 变红。验证：lint、tsc、`npm test`（76 文件 1504 用例）、build 通过，page-runtime 22.08 到 22.13 KB，e2e 连跑 3 次全绿，check 第 1 轮无阻断问题。<br>**下一步**：已合并；接着做第 2 条样式精确恢复（见上一行） |
| 2026-11-18 | **冒烟 e2e PR1 已合并**（#44，分支 `feat/e2e-smoke`）：方案经 Fable 裁决、Opus 审查合并后获批；Opus 写 harness 与样板用例，Sonnet 补其余用例、CI job 与文档。零依赖 CDP 驱动加 Vitest（`npm run test:e2e`），6 个文件：16 通过、1 预期失败、2 跳过（Linux 才跑的 `--lang` 回退用例），`--retry=0` 连跑 5 次全绿。CI 新增 `e2e` job（首版不阻断，Chrome for Testing 158.0.8127.36）。harness 621 行，超过 400 行目标，暂不触发换 `playwright-core` 的退出条件。**已知问题（已修复，见 2026-11-18 样式精确恢复一行）**：进入「仅看译文」再显示原文后，块根元素残留空 `style=""`，原用 `it.fails` 记录。<br>**Codex 两轮评审已核实**（`docs/reviews/2026-11-18-codex-review-verification.md`）：7 条不足均成立或部分成立，从零设计 5 条部分采纳。排期：第 1 条 P1 编辑区取文最先修，其次第 2 条样式精确恢复，再 e2e PR2；v0.2.0 前做第 7、5 条小 PR；M3d 做第 4、3、6 条。<br>**用户确认主会话分工**：主会话只做澄清、拆解、分发、验收，实现类工作派子代理，Fable 用于核心难点。<br>**下一步**：check 三轮审查已通过（第 2、3 轮修复了输入框与可编辑区反例的空断言、`tell` 只在内容脚本未就绪时重试）；CI 首跑确认 setup-chrome 装的是 Chrome for Testing、Linux `--lang` 回退用例实际运行；已合并，第 1 条 P1 编辑区取文修复已开工（见上一行） |
| 2026-11-18 | **#42（仓库内引用与内部标识改名）已合并**。**i18n 第 6 批 zh_TW 已实现**（分支 `feat/i18n-batch6-zh-tw`）：`zh_TW.yml` 由 Sonnet 起草、主会话审校、Opus 独立审查（「划词」在台湾改称「反白」等）；中文字体改为按 `lang` 由 Chrome 选择（去掉写死的 SC 字体名，CDP 实测 zh-CN/zh-TW/ja 各用对应字体，Shadow DOM 继承宿主 lang），已知小回归是 lang 为 en 或空时 Linux 可能显示日文字形；设置页预览示例跟随目标语言；zh_HK 不单独做（Chrome 桌面中文界面只有 zh_CN/zh_TW）；繁体 README 暂不做。用户追问方案没走 think skill，补走 think 后改进了字体方案；**用户重申完整开发流程**（think 写方案并参考 docs/plans 与 FluentRead → 方案审查 → 实现 → check 循环 → 更新文档 → 再问提交/PR → 合并后清理旧分支与 worktree），已记入记忆。<br>**下一步**：用户确认后提交、开 PR；之后冒烟 e2e（含「中文/繁体环境下扩展能加载」）→ v0.2.0 |
| 2026-11-18 | **#41（改名）已合并；GitHub 仓库改名为 `jiangding01/islet-translate`**，本地 `origin` 已指向新地址。**本地文件夹改为 `~/islet-translate`**：旧路径 `~/easy-translate` 保留为指向新文件夹的符号链接，旧的桌面端会话照常可用；Claude Code 项目记忆已复制到新路径（`~/.claude/projects/-Users-jiangding-islet-translate/memory`），旧会话记录仍在原目录；改名前的备份在 `~/.claude/backups/rename-islet-*`。分支 `fix/repo-rename-refs`：README 徽章与产物名、CI 产物名、`package.json` 包名与链接、`package-lock.json`、`SECURITY.md`、CHANGELOG 链接改为新仓库名；随后按用户要求（目前只有用户自己在用）把内部标识也改掉：IndexedDB 库名 `islet-translate`（旧库 `easy-translate` 不自动删除，已有缓存作废，重新翻译即可）、按需模块全局键、控制台日志前缀、CodeQL 配置名、m1/m3a 方案文档；注明日期的评审文档与 `docs/design/` 归档保持原样。`npm run check` 通过，新链接均返回 200。<br>**下一步**：用户确认后提交、开 PR（改到 CI 配置，需用户过目）；旧会话都归档后可删除 `~/easy-translate` 符号链接与旧项目目录；之后第 6 批 zh_TW |
| 2026-11-18 | **改名为译屿 / Islet Translate 已实现**（分支 `feat/rename-islet`）：#40（双语 README）已合并。名称、短名称（新增）、描述、工具栏提示、设置页标题按界面语言改名；仓库名、包名、IndexedDB 库名 `easy-translate`、按需模块键与日志前缀不变（改了只会让缓存作废、没有用户价值）。**图标**：试了穹顶、双峰、钟形、圆点四类小岛造型，16px 下都会被误读（日出、云、弹出按钮、列表项）；用户更喜欢在原图标上优化，Fable 5.2 独立评审同样选「保留胶囊 + 淡琥珀倒影」并收紧了像素参数，定稿「暗岛微光 · 倒影」，记入 `docs/plans/ui-isle-direction.md` 第 6 节，Design 原型新增「改名 · 译屿图标」页。用户要求同时出 SVG：`build-icons` 新增无边距主图 `docs/assets/icon/icon.svg`。设置页品牌位换成 48px 图标（24px 显示）+ 跟随界面语言的名称。两套 README 截图（12 张）用截图脚本全部重拍。check 审查无阻断问题，`npm run check` 通过（1489 个用例，options 89.00KB）。<br>**下一步**：用户确认后提交、开 PR；仓库已改名为 islet-translate（见上一条）；之后第 6 批 zh_TW |
| 2026-11-18 | **i18n 第 5 批（双语 README）已实现**：README 重写为英文默认、新增 `README.zh-CN.md`；用户要求目录用 tree、排版美化、加入设计理念、功能做成表格并配示例图。截图按读者方向拍（英文 README 中译英、中文 README 英译中），用户确认这一做法并要求全部 2 倍图。截图流程沉淀为仓库工具 `scripts/screenshots/`（用户同意并进本批）。write 润色英文、对照中文；check skill 两轮：README 事实逐条核对代码，补了根目录漏列的 `DESIGN.md`、`vitest.setup.ts` 和音标分片预算；脚本修了失败时不关浏览器、不删临时目录的问题并实测。`npm run check` 通过（75 个文件、1489 个用例）。已开 PR #40，GitHub 页面实测两份 README 的标题锚点、图片、表格、折叠块均正常；CodeQL 报截图脚本 CDP 回包分发为「未校验的动态方法调用」，已加类型校验修复。<br>**下一步**：等 CI 通过后合并；之后改名（含图标与设置页接入插件图标） |
| 2026-11-18 | **i18n 第 4 批（按需模块）已实现**：方案经 Opus 审查（阻断 1 条：宿主设界面语言会让卡片原文/译文继承错的 lang，改为分层设置；应修 5 条已并入）；英文设计点出效果图，用户选定灵岛图标 + 简称「C」，并提出**以后 UI 设计取舍用 Design 原型自行决策**（已记入记忆）。Sonnet 子代理实现，47 条迁移、基线清零；Chrome for Testing 经后台消息触发整页翻译与划词卡片截图，中英文灵岛与英文卡片正常，中文产物能加载。代码经 Opus 深度审查（提示气泡宽度测量、音标 lang 两条已修）与 check skill 第二轮复核（同类的卡片提示气泡一并修复，360px 窄屏底部停靠实测通过）；用户再次强调流程：改完必须正式走 check → 修复 → 二次审查 → 更新文档 → 再提交（已记入记忆）。#32（TypeScript 6.0.3）：Dependabot 未响应 rebase，本地在最新 main + TS 6 的临时 worktree 跑 `npm run check` 通过，用户合并。<br>**下一步**：Opus 代码审查后提交并开 PR；之后第 5 批双语 README |
| 2026-11-18 | **i18n 第 3 批 3b（设置页）已实现**：142 条由 Sonnet 子代理按方案迁移，主会话审查：中文逐条比对一致（4 条改为 `$1` 模板，代入后逐字相同）；Chrome for Testing 截中英文图时发现两个问题并修复：① **3a 的 `$1$2` 让中文环境下扩展加载失败**（Chrome 把 `$1$` 读成 `$name$`），改为 `$1：$2`，check-i18n 按 Chrome 规则扫描 `$name$`；② 分段控件改宽后段内无内边距、滑块铺满整个控件（绝对定位网格项的 `auto` 线落在内边距边缘），改为最小 72px + 内边距 + 网格线写全 `1 / 2`，用脚本量过各组滑块在首段、末段都与分段完全重合。基线 189→47，75 个文件、1475 个用例，options 90.10→88.99KB。用户提出：改名换图标后设置页接入插件图标（已记入路线图第 5 项）。用户反馈深色下分段控件选中态不明显：深色 `elevated` 只比 `surface` 亮 1%，新增 `--et-color-segment-thumb/ring` 提亮滑块（未用琥珀描边，理由见 i18n.md），用户确认效果。提交前补做 check 审查（用户追问后发现漏了这一步）：Opus 深度审查无高严重度问题，修了 4 条（`$name$` 扫描、英文选中加粗致宽度跳动、中文冒号、数字格式测试），修复提交单独在 worktree 验证过。过程失误：组合命令末尾误加 `git stash` 暂存了全部改动，已立即 pop 恢复并记入记忆。<br>**下一步**：用户确认后提交（修复与 3b 分两个提交）并开 PR；之后第 4 批 |
| 2026-11-18 | **i18n 第 3 批 3a（工具栏面板）已实现**：方案经 /think 与 Opus 审查（阻断 1 条：Mac 上 Chromium 不认 `--lang`，英文截图会截成中文；应修 4 条：面板引擎名与原因直接拼接、设置页分段控件定宽、测试计划假设了不存在的组件测试、`common.*` 过宽），拆成面板 3a 与设置页 3b。3a 迁移 44 条，基线 233→189；新增 4 个英文用例（复数、暂停原因、拼接）；迁移前后中文逐条比对一致（段数超过 999 时改为带千位分隔符）。英文布局：Chrome for Testing 用删掉 zh_CN 语言包的副本截图，`openPopup()` 拿不到 activeTab 只截到「浏览器页面」状态，其余长串用实际字体测量，均不溢出。popup 83.58→83.10KB。<br>**下一步**：用户确认后提交并开 PR；合并后做 3b 设置页 |
| 2026-11-18 | **灵岛拖动窗口时的残影已修**（分支 `fix/isle-resize`）：用户在只看译文 fixture 上拖动窗口发现，变宽时圆点拉出黑色长条、变窄时圆点消失。原因：灵岛的 clip-path 和内容按缓存的视口像素定位，`onResize` 要等 100ms 不再变化才重算，慢速拖动时一直用旧尺寸。改为每次 resize 立即读视口、贴边重绘，避让页面元素的探测仍等窗口停下。划词卡片的 `onResize` 本来就立即刷新视口，无同类问题。先红后绿，新增 1 个回归用例。用户在 Chrome 里用 #35 与本修复的合并构建验收了 fixture 全部 8 个用例，灵岛贴边无长条。已开 PR #36。<br>**下一步**：合并后开始 i18n 第 3 批（面板与设置页） |
| 2026-11-18 | **`fix/translation-only-pins` 已实现**：只看译文时 margin/padding 改读 Typed OM，`margin: 0 auto` 保持居中、百分比 padding 随窗口变化；根元素的 `letter-spacing`/`word-spacing` 以变量设回译文。先红后绿，新增 1 个回归用例（另有 2 个 DOM 约定锁定用例）；page-runtime 22.04→22.11KB；真机验收待做。**Inkmark 协作需求**（网页转 Markdown 扩展，文档在用户本地）：经核实 P1、P3 合理，写成 `docs/dom-contract.md` 并加锁定测试，随本 PR 单独提交；P2（代码块工具栏不翻译）记入 M3d 待处理项第 5 条。**CI**：picomatch 无补丁高危公告拦下所有分支，经 Fable 5.2 决策改为按公告 ID 限期豁免（#34），#33 随后合并。<br>**下一步**：用户确认后提交并开 PR；之后 i18n 第 3 批（面板与设置页） |
| 2026-11-18 | **i18n 第 2 批（后台与公共库）已实现**：错误文案 31 条加兜底、引擎名称与就绪状态、右键菜单迁到 `src/locales`；`error-text.ts` 与完整错误表共用键；check-build 改用键名标记并加正向断言，另断言常驻 `content.js` 不含 `getMessage`。方案经 /think 与 Opus 审查（无阻断，4 条应修已并入，含「`session.ts` 被误列为常驻脚本」）；实现后 check 审查发现两处可简化（engine-options 复用 `readiness.problem`、去掉多余的 `hasOwn`），已修。中文文案经脚本逐条比对与迁移前一致；`npm run check` 通过（73 个文件、1452 个用例），基线 287→233，background 58.20→57.14KB。<br>**下一步**：用户确认后提交并开 PR；合并后做 `fix/translation-only-pins` |
| 2026-11-17 | **Google 丢标签时用 HTML 模式重试，已合并**（PR #30，`a4f06fa`）。PR #28 合并后用户复验：只看译文已隐藏首段原文，但首段译文没有链接。用户两次 curl 取证：纯文本模式把 `<t0>` 整个丢掉；`format=html` 能把标签放到「由 Claude 编写和审查的」上；`<a>` 套 `<a>` 会被拆平，`<a>` 套 `<b>`、空 `<code>` 都能保留。用户另测 DeepSeek 本来就能保住链接，所以只改 Google 适配器：标签不完好的条目合批用 HTML 模式重试一次（`google-html.ts`），失败或回显时保留第一次的译文。方案经 /think 获批；check 时 Fable 审查发现「HTML 回显原文会覆盖已有译文」与编号按数字比较两处，已修并补测试，1448 个用例。**已缓存的坏译文需清缓存后才会修好**。用户清缓存后真机验证通过：首段译文「由 Claude 编写和审查的」带链接，其他段落链接正常。**流程调整**：Fable 审查改为视情况使用，只用于十分重要且复杂的改动 |
| 2026-11-17 | **只看译文露出原文的修复已合并**（PR #28，`ad3d8ba`；同日 PR #27 修了 `ch`/`em` 限宽段落塌成竖排）。用户在 claude.dev 博客 verification 一文发现，切到只看译文后第一段英文没有隐藏。根因：首段含链接，Google 返回时把 `<t0>…</t0>` 整个丢掉（用户用 curl 取证），段落退回纯文本；按 M2 方案附录 C 第 8 条，这类段落在只看译文下保留双语。**用户决定推翻该条**：照常隐藏原文，链接切回双语可用。删掉失效的 `keepOriginal`、`hasLink`；放宽标签识别（对此情况无效）和 `format=html` 重试都不做，后者仍按风险 1 的 10% 阈值评估 |
| 2026-11-17 | **i18n 第 1 批已合并**（PR #26）：方案经对抗式审查后获批；实现经 3 轮独立审查（第 1 轮 5 条应修，含基线可绕过、联合键绕过插值检查等；第 2 轮 1 条复数插值漏检；第 3 轮无应修）。**「仅看译文」竖排**：用户在 claude.com 文章页发现，子会话定位为 `font-size:0` 让 `max-width: 80ch` 归零，修复合并为 PR #27；子会话另报 4 个遗留问题，主会话在 Chrome 156 实测全部属实（另发现百分比 padding 同类问题），记入 `docs/reviews/2026-11-17-translation-only-followups.md` 并排期。<br>**下一步**：新会话开始 i18n 第 2 批，开分支时带上本地未提交的两份文档 |
| 2026-11-17 | **音标已合并**（PR #15）。**原型**更新到第 36 版：4 个画板对齐当前实现，没有实际渲染检查，请用户打开确认。**命名**：候选有译屿、屿光、渡、隐屿等，查重后定为「译屿 / Islet Translate」；Isleglow 已被占用，放弃。**路线图**：PR-A → CI 增强（产物上传、依赖审查、CodeQL）→ i18n 与双语 README → 改名 → 冒烟 e2e → 发 v0.2.0（只发 GitHub Release，暂不上架）→ M3d |
| 2026-11-17 | **供应商图标已合并**（PR #14）。**英文单词音标**：ECDICT 调研 → 方案复查（修了音标分片被当成最终译文、晚到被丢等 3 处设计错误）→ 英音 3 万词 → 用户要求英美双音标（美音 ipa-dict en_US）→ 真机发现中文页面不显示（语言判断过严）和长尾词缺失 → 改全量分片 → 补美式拼写互查、UK/US 标签 → 真机发现朗读卡死，子代理在真实 Chrome 复现出 Google 在线声音「cancel 后立即 speak」的浏览器级 bug 并修复 → 底部朗读英文默认美音。用户验收通过。**Codex 复核清单**由 Opus 子代理逐条核实（第 1–4 条属实，定级下调），排进 PR-A 和 M3d。<br>**下一步**：音标 PR → 原型 → PR-A |
| 2026-11-17 | **面板设置入口已合并**（PR #13）。**引擎供应商图标**：先出效果图，用户确认后出方案并获批；图标来自 lobe-icons 1.102.0（MIT），存成路径数据，卡片和灵岛的图标由后台随 `engine.options` 下发，面板和设置页直接引用；审查时把 `customShort` 挪到 `engine-view.ts`；用户在浅色、深色下逐一检查 5 处，均无问题。**排期**：i18n 基础设施提前到音标之后、M3d 之前。<br>**下一步**：提交并开 PR |
| 2026-11-17 | **M3a 已合并**（PR #12，合并前带入 PR #10、#11 的测试修复）。真机反馈修复：Google 原样回显不写缓存并重试、卡片优先向右展开、卡片细滚动条。<br>**面板设置入口**：设置按钮的图标像太阳，用户没认出来；出三种样式效果图，用户选「齿轮 + 设置」，分支 `fix/popup-settings-entry`，真机确认亮暗两套。<br>**下一步**：提交并开 PR；评估引擎供应商图标 |
| 2026-11-16 | **M2b PR2 灵岛已合并**（PR #9）。**M3 规划**：拆成 5 个小批次；调研 FluentRead。**M3a 划词翻译完成实现与自查**（分支 `feat/m3a-selection`，未提交）：原型确认 → 方案（Opus 审查查出 3 项阻断、12 项应修，已修订）→ 三段实现，887 个测试 → Chrome for Testing 自查 8 项通过。按用户要求，**暂停于 check Deep 审查之前**。<br>**另开事项**：`cache.test.ts` 的时序用例已在单独的会话中修稳（PR #10，只改了测试文件，待合并）；该会话又发现 `service.test.ts` 有一条偶发失败的用例，原因是 `waitFor` 只等到 8 个挂起请求中的 6 个已派发，`hanging[0]` 可能还没派发就被取消，导致 aborts 计数为 0。这条还没修，需要另行处理 |
| 2026-11-16 | **M2b PR1 已合并**（PR #8）。**M2b PR2 灵岛完成实现与审查**（分支 `feat/m2b-isle`）。<br>**原型**：在 Design artifact 新增 `IsleM2` 页，用户确认；规范第 2 节第 7 条改为「暗色网页上也用深岛加描边」。<br>**方案**：m2b 方案第 9 节，经 Opus 对抗式审查（3 项阻断、14 项应修）修订，再由主会话对照代码复核。<br>**实现**：分两段（Sonnet 做接口和配置，Opus 做灵岛），page-runtime 21.34KB。<br>**审查**：check Deep，修了停靠来回切换后隐身、换引擎后错误算错引擎等，633 个测试。<br>**验收**：自动 10 条通过；用户真机 4 倍降速下 INP 40ms。<br>**真机后调整**：底部停靠改右下角、横幅抬升、避让对齐、提示框淡出、小点暗边（附录 H），增量审查修 5 项，682 个测试，用户复验通过。<br>**下一步**：PR 合并 → M3 |
| 2026-11-16 | **M2b PR1 按需加载完成实现与审查**（分支 `feat/m2b-lazy-runtime`）。<br>**调研**：灵岛加载方式由 Fable 5.2 裁决，选动态 URL + 单文件按需模块；实测否决后台注入（需全站权限）。<br>**方案**：`docs/plans/m2b-lazy-runtime-and-isle.md`，经 Opus 对抗式审查修订。<br>**实现**：内容脚本 19.43KB → 4.88KB，会话代码拆进按需模块 `page-runtime.js`（12.29KB）；配置读取改原生 storage；最低 Chrome 130；构建检查用 `node:vm` 验证单文件、严格模式下可执行和注册生效。<br>**审查**：check Deep（安全与架构、对抗式各一位 Opus），修了 WXT 默认向网页广播扩展 ID 等 5 项，550 个测试。<br>**下一步**：真机验收 → 提交并开 PR → PR2 灵岛原型 |
| 2026-11-13 | 熟悉骨架与旧方案；Fable 5.2 完成两轮评审，产出最终方案和 UI/UX 规范；用户拍板全部决策（见第 3 节）；暂不做高保真设计稿；创建本文和 `CHANGELOG.md`，提交并推送到 main。约定开发流程（见第 8 节）。下一步：M0 |
| 2026-11-13 | M0 方案 `docs/plans/m0-foundation.md` 经审查后获批。在 `feat/m0-foundation` 上实现 M0（工具链与 CI、配置仓库、消息协议与 Port 传输层、设计 token 与主题），`npm run check` 通过。状态：**已实现，待审查和合并**；第 9 节手工验收待在真实 Chrome 中执行。下一步：审查 → 推送并开 PR → CI 通过后由用户合并 → M1 |
| 2026-11-13 | 已开 PR jiangding01/easy-translate#1。按 check skill 的 Deep 流程补做了完整审查：安全、架构 2 个专项审查，加上 4 个角度的对抗式审查。确认 13 项问题并修复，每项都先写回归测试；其中 Port 修了「无法序列化的响应会让请求永久挂起」等问题。M1 开工前必须决定的事项已记入第 5 节。状态：**等待用户合并** |
| 2026-11-13 | **M0 已合并**（PR #1，合并提交 `c5b7bb2`，main 上的 CI 通过）。用户在真实 Chrome 中完成手工验收：第 1、2、3、4、5b、6 项通过；5a（`chrome://` 页面的提示）只有单元测试覆盖。LCU 的 URL 策略只允许 http/https，不能用来测试扩展页面。下一步：M1 翻译核心（分支 `feat/m1-translation-core`） |
| 2026-11-14 | **M2a 已合并，真机验收通过**。<br>**合并**：M2a（PR #4，`29bc384`）、扩展图标「暗岛微光」（PR #5，`4b61fca`，另开会话完成；状态点改为直接读 16、32 号图标）、分段边界修复（PR #6，`cbd7a3b`）。<br>**真机验收**：用户在 claude.dev 博客页验证：正文按模块随懒加载翻译，刷新后命中缓存直接显示；发现列表、页脚、目录的译文错位，根因是先看标签把排成块的 `<a>`、`<span>` 当行内，PR #6 改为按计算样式判断（对齐 FluentRead），Fable 审查补了脱离文档流元素、行内弹性小块和 ruby 三个例外，523 个测试。导航、按钮、标签页、输入框按规则跳过；界面小标签（如「TREE」）的排除和专有名词保护分别留给 M3 站点规则和 M4 术语库。<br>**下一步**：新会话开始 M2b（先定按需加载方式与订阅接口，再补原型） |
| 2026-11-14 | **M2a 整页翻译完成实现与审查**（分支 `feat/m2-page-translation`）。<br>**实现**：扫描与分段、视口队列与 Port 会话、渲染与动效（WAAPI，只动 opacity 和 filter）、双语与仅译文、动态内容、快捷键、图标状态点、站点记忆、面板与设置页「译文」。顺带完成 M1 留下的两项：大模型流式输出 64000 字上限、最低 Chrome 117。<br>**审查**：check Deep，三路专项（安全 Fable、架构 Sonnet、对抗式 Fable），修复后 Fable 复查；确认问题见第 5 节，全部修复并有回归测试；第二轮复查发现的新问题也已修复，515 个测试。<br>**下一步**：推送并开 PR → CI → 用户真机验收并合并 → 新会话开始 M2b（先定按需加载方式与原型） |
| 2026-11-14 | **M1 已合并**（PR #2，CI 全绿，用户手动合并）。用户用生产构建做了真机验收，主要流程都通过。发现 7 个问题：展开行背景偏粉（白色 token 色相为 0，OKLCH 混合时被拉向粉色）、本地 Ollama 返回 403 被误报为密钥无效、对话框初始焦点、文字按钮焦点框、详情区首行焦点框被裁、下拉宽度、README 缺 Ollama 说明，都在 PR #3 修复。<br>**下一步**：PR #3 合并 → M2 整页翻译方案（先出原型） |
| 2026-11-14 | **M1 第 3b 步完成**。<br>**原型**：设置页、工具栏面板，以及加宽的「添加服务」对话框和自研下拉，用户确认后实现。<br>**变更**：自定义服务从 1 个改成最多 10 个，按条目写入；主题换成琥珀，组件只引用 token；自研下拉取代原生下拉；工具栏面板体积预算调到 90KB。<br>**审查**：3b 做了两轮 Deep 审查（安全、架构、四个对抗角度，加修复后复查），下拉组件做了一轮 Standard 审查。修掉的主要问题：同一服务快速连改两处会互相覆盖；删除后的迟到修改会让服务复活；记录键名含「.」或叫 `constructor` 时会清空全部设置；孤儿密钥（改为后台负责清理，只读配置下不清理）；测试连接可能占住调度槽 180 秒。下拉组件的审查修了读屏读不出当前值、面板误把未授权服务标为可用等 8 项。共 416 个测试。<br>**下一步**：推送并开 PR → CI → 用户手工验收并合并 → M2 |
| 2026-11-14 | **M1 后台能力完成，暂停于 3b 之前**（应用户要求，下次继续）。<br>**实现**：分三段完成。第一段 Sonnet：配置、provider、缓存。第二段 Opus：调度器与服务。3a Sonnet：后台接线。<br>**审查**：按 check skill 的 Deep 流程，做了安全、架构 2 个专项审查，加上 4 个角度的对抗式审查，确认的问题已全部修复。主要有：OpenAI baseURL 绕过权限检查；配置写入没有校验发送方；冷却作用域与超大 Retry-After；缓存淘汰阻塞读取，TTL 删除与写入有竞态；LLM 输出被截断或被拦截时，真实原因被掩盖。每项修复都有先红后绿的回归测试，目前共 356 个测试。<br>**设计**：界面方向确认为「隐中生岛」加琥珀主题色，见 `docs/plans/ui-isle-direction.md`。<br>**下一步**：3b 原型 → 3b 实现 → check → 推送并开 PR |

## 2. 里程碑批次记录（原第 4、5 节）

#### 4. 当前代码状态

- **main**（截至 d180ea2，PR #51）：
  - **M0 地基**（PR #1）：质量门禁、配置仓库、类型化消息与 Port、设计 token。
  - **M1 翻译核心**（PR #2、#3）：`src/lib/translate/`（provider、调度器、缓存、密钥、权限、翻译服务、Port `et-translate`）；最多 10 个自定义服务；设置页与工具栏面板（「隐中生岛」琥珀主题，`src/styles/tokens.css`，对比度由 `scripts/check-contrast.mjs` 校验）；页面共用 `src/lib/engine-view.ts`、`src/lib/endpoint.ts`、`src/components/Select.tsx`。
  - **M2a 整页翻译**（PR #4、#6）与扩展图标（PR #5）：`src/content/`（扫描分段、视口队列与会话、渲染、动态内容、站点记忆）。
  - **M2b**（PR #8、#9）：内容脚本只留首屏引导（`src/entrypoints/content.ts` + `src/content/bootstrap.ts`），整页会话是按需模块 `page-runtime.js`（动态 URL 的 WAR，最低 Chrome 130）；灵岛 `src/content/isle/`（配置 `page.isleDock`）。
  - **测试修复**（PR #10、#11）：`cache.test.ts`、`service.test.ts` 的偶发失败。
  - **M3a 划词**（PR #12）：后台流式（`stream`/`force`、delta/reset）；第二个按需模块 `selection-runtime.js`；选区观察 `src/content/selection/watch.ts`；卡片 `src/content/selection/`；右键菜单（`contextMenus` 权限）与快捷键 `translate-selection`；配置 `selection.showDot`；Google 原样回显不写缓存（`src/lib/translate/echo.ts`）；错误文案由后台附 `userMessage`。
  - **面板设置入口**（PR #13）：齿轮加「设置」文字。
  - **引擎供应商图标**（PR #14）：`src/lib/provider-icons.ts`（路径数据，lobe-icons MIT）、`src/components/ProviderIcon.tsx`、`src/content/svg-icon.ts`；卡片和灵岛的图标随 `engine.options` 下发。
- **2026-11-17 起合并的其他 PR**：
  - **PR-A**（PR #17）：重试等待期间暂停导致漏译、旧启动失败停掉新会话、划词配置被旧值覆盖。
  - **CI 增强**（PR #18）：构建产物上传、依赖审计与审查、CodeQL、Dependabot；Dependabot 升级（#20、#24）。
  - **扩展重载后旧页面划词报错**（PR #22）、**CodeQL 告警修复**（PR #25）。
  - **开源准备**（PR #23）：MIT 许可证、THIRD_PARTY_NOTICES、SECURITY.md、仓库元数据。
  - **i18n 第 1 批基础设施**（PR #26）：方案 `docs/plans/i18n.md`；`scripts/check-i18n.mjs` 与 `scripts/i18n-baseline.json` 卡住新增中文字面量。用 `@wxt-dev/i18n`，文案在 `src/locales/en.yml`、`zh_CN.yml`，默认 en、跟随浏览器；manifest 文案已本地化；按需模块用 `src/content/i18n.ts`（类型化 `message`/`pluralMessage`），扩展页用 `i18n.t`；`npm run check:i18n` 校验语言文件，中文硬编码按哈希基线（287 条）只减不增。规则见 [`docs/plans/i18n.md`](docs/plans/i18n.md) 第 4 节。
  - **只看译文修复**：`ch`/`em` 限宽段落不再塌成竖排（PR #27：根元素 `font-size:0` 会把 em/ch 长度归零，`render.ts` 在切换前读计算值钉成内联像素 `PINNED`/`PINNED_TYPED`，遗留问题见第 5 节 4b）；链接标记丢失、退回纯文本的段落照常隐藏原文（PR #28，推翻 M2 方案附录 C 第 8 条）。
  - **Google 标签修复**（PR #30）：纯文本模式丢掉行内标签时，适配器对这些条目用 `format=html` 重试一次（`src/lib/translate/providers/google-html.ts`），保住译文里的链接。
- **音标（PR #15，已合并）**：UK/US 音标（`src/lib/phonetic/`，数据 `public/dict/gb|us/` 分片，生成脚本 `scripts/build-phonetics.mjs`）、朗读卡死修复（`src/content/selection/speech.ts`）、底部朗读英文默认美音；`docs/reviews/` 收录 Codex 复核清单与核实结论。方案 [`docs/plans/phonetics-en.md`](docs/plans/phonetics-en.md)。
- **体积（gzip，`npm run check:size`）**：content 7.36/7.5KB（预算按已批准方案于 PR4 提到 7.5 KB，PR6 后余 0.14 KB，改引导层或常驻监听前必须先评估）、page-runtime 26.00/27KB（余约 1.0 KB）、selection-runtime 18.17/19KB、background 57.52/60KB、popup 83.28/90KB、options 89.67/150KB；音标分片英 1.41MB、美 0.80MB（各 2MB，单片 40KB）。
- **可用命令**：`npm run dev | build | lint | format | typecheck | test | check | check:contrast | check:size | zip`。`check:i18n`、`check:build` 也在其中。`npm run check` 通过（截至 B1（#54）：单测 1561 个用例；e2e 11 个文件，39 通过、2 跳过，CI Linux 41 通过）。
- **还没有**：M3c 指令台与灵岛键盘、M3e 本地引擎；~~e2e 设为必过~~（已完成，2026-11-20 加入 `main` 规则集）；（v0.2.0 已发布，之后的版本打 `v*` 标签即由发版工作流发布，打 tag 前先问用户）。

#### 5. 批次状态与下一步

- **M0 地基**：已合并（PR #1）。**实际设计以 [`docs/plans/m0-foundation.md`](docs/plans/m0-foundation.md) 为准**，其第 6 节记录了相对最终方案的 7 处偏离：体积门禁用自写脚本而非 size-limit；token 只用一个纯 CSS 文件；schema 按批次追加字段；客户端不用 zod；消息返回 `Result`；happy-dom 和 idb 推迟引入；Port 只做传输层。
- **M0 留给后续批次的约定**：
  - 新增配置字段时，在 `schema.ts` 和 `defaults.ts` 中追加并给出默认值，不需要提升版本号。只有破坏性变更才提升 `schemaVersion` 并编写迁移。
  - Port 的调用方在切换会话前必须先 `cancelAll()`。
  - popup 的 gzip 体积预算已调到 90KB（现 84.48KB），往 popup 新增依赖之前要先评估。
  - **M1 开工前必须决定（来自 M0 深度审查）**：
    - 配置路径对数组和 Record 只支持整体替换。如果 provider 设置按 id 存成 Record，两个页面同时修改不同的 provider 时，后写入的会覆盖先写入的。二选一：改成固定键的对象（每个 provider 一个分支），或者给 `ConfigChange` 增加按记录合并或删除的操作。
    - Port 客户端本身没有超时，请求超时和中止由 M1 的调度器负责。否则 handler 不返回时，请求会一直挂起，ping 也会让 SW 一直保活。
    - `call()` 把所有发送失败都归为「后台不可达」。M1 新增的写操作应当保持幂等，因为可能出现「实际已写入、但回包丢失」的情况。
    - 以上 3 项已在 [`docs/plans/m1-translation-core.md`](docs/plans/m1-translation-core.md) 中定案：provider 用固定键对象；超时由调度器分三层负责；写操作保持幂等。
- **M1 翻译核心**：方案见 [`docs/plans/m1-translation-core.md`](docs/plans/m1-translation-core.md)，状态以该文件头部为准。
  - **已合并**（PR #2）：
    - 后台：provider（google 用 POST，LLM 一律流式）、编解码、提示词、IndexedDB 缓存、密钥、权限、调度器、翻译服务、后台接线；
    - 3b：多个自定义服务、琥珀 token 与对比度校验、设置页、工具栏面板、自研下拉组件；
    - 审查：后台部分做过一轮 Deep 审查；3b 做过两轮 Deep 审查（安全、架构、四个对抗角度，再加修复后复查），下拉组件做过一轮 Standard 审查；确认的问题都已修复并补了回归测试。
  - **真机验收**（2026-11-14，用户在 Chrome 中用生产构建验证）：Google 测试连接、DeepSeek 保存密钥、添加本地 Ollama（授权提示、设置 `OLLAMA_ORIGINS` 后连通）、删除默认自定义服务回退到 Google、通用页下拉（含键盘）、亮暗主题、工具栏面板的各种状态都通过。清空缓存要等 M2 有网页翻译后才能测。发现的问题在 PR #3 修复。
  - **开发版提示**：WXT 的开发构建会给 manifest 加上 `http(s)://*/*`，Chrome 会提示可选权限多余；授权流程只能用生产构建（`npm run build`）测试。
- **M2 整页翻译**：方案见 [`docs/plans/m2-page-translation.md`](docs/plans/m2-page-translation.md)。
  - **M2a（已合并，PR #4、#6）**：check Deep 审查完成（安全、架构、对抗式三路，会话与渲染加 Fable 复查）。确认并修复的问题：停止与在途渲染写入的竞争（会留下孤儿译文）、会话译文记忆用 32 位哈希作键（可被碰撞顶替译文，改用完整原文）、对话框把应用根标为 `aria-hidden` 时整页译文被清掉、长会话里已卸载 DOM 被强引用、「仅译文」自身 CSS 干扰块级判断、停止时取消整个 Port、页面可伪造 `<style data-et>`、启动失败卡在运行中、面板轮询乱序。每项都有先红后绿的回归测试。第二轮 Fable 复查确认修复有效，并抓到一个由修复引入的重复译文问题（混合父元素失去块级子元素），已修复。共 515 个测试。
  - **M2a 真机验收**：按方案第 10 节，包括 4 倍 CPU 降速下的动效检查；设置页「译文」卡片与面板的实际观感需要在真实 Chrome 里看。
  - **分段边界规则（2026-11-14 真机验收后修订）**：块级还是行内只看计算样式（`src/content/dom-rules.ts` 的 `isInlineElement`，对齐 FluentRead `isBlockBoundary`）：语义块标签总是边界，`code`/`img`/`br` 等总是行内，其余按 `display`（`inline*`、`contents` 为行内）。弹性布局和网格的子元素会被浏览器块级化，因此各自成为单元；M2a 原先「横向弹性布局合成一个单元」的做法已放弃：项之间的间距由 CSS 绘制，合并会把文字粘在一起（如「01Home PAGE」）。
    - 例外（仍留在句子里）：脱离文档流的元素（`sr-only`、浮动徽章）按标签判断；`inline-flex`/`inline-grid` 小块内部的项算行内；`display: ruby*` 算行内，注音 `rt`/`rp` 不翻译。
    - 已知取舍（与 FluentRead 相同）：弹性容器里「直接写的文字 + 链接」会被分成两段翻译，行内片段的译文还会成为容器的一个新项，在 `justify-content: space-between` 的容器里可能被推到中间。FluentRead 靠把原文包进一个合成 span 来避免，我们不移动网页节点，暂不做；真机验收时留意。
  - **M2b**：方案见 [`docs/plans/m2b-lazy-runtime-and-isle.md`](docs/plans/m2b-lazy-runtime-and-isle.md)，拆成两个 PR。
    - **加载方式已定（2026-11-16，用户拍板）**：内容脚本 `import()` 声明了 `use_dynamic_url` 的单文件 WAR。后台注入被否决：`executeScript` 只认 `host_permissions`，内容脚本的 `matches` 不算，必须申请全部网站权限。调研和实测见方案附录 A。
      - 硬约束：按触发时机分包；按需文件是单文件、零 import；跨包只共享类型和无副作用的常量；灵岛等 UI 里**禁止出现任何扩展地址**（图片、CSS `url()`、字体），否则网页能截获动态地址；自定义品牌字体基本不可用。
    - **PR1 按需加载与首屏瘦身**：已合并（PR #8）；check Deep 审查完成（方案附录 C）。自动验收 8 条通过，第 6 条和版面观感由用户手动确认通过（方案附录 D），待提交并开 PR。
    - **PR2 灵岛**：原型已确认（Design artifact 的 `IsleM2` 页），方案见第 9 节；已实现，check Deep 审查完成（附录 F）；自动验收和用户真机验收通过（附录 G）；真机验收后，按新原型把底部停靠改为右下角，并补上横幅抬升、避让对齐、提示框淡出和小点暗边的修复，已经过增量审查（附录 H），用户复验通过，已提交并开 PR。分支 `feat/m2b-isle`。新增配置 `page.isleDock`、后台只读消息 `engine.options`、会话的 `subscribe`，以及 `src/content/isle/`、`src/styles/tokens-isle.css`。
    - **已知限制**：WXT 内容脚本包装层仍会在 `document` 上派发带扩展 ID 的 CustomEvent，已知 ID 的网页可以借它确认扩展存在；`postMessage` 广播已关闭。带 `CSP: sandbox` 头的本地页面实测能正常加载按需模块并翻译，没有回归。
    - **另开事项（2026-11-20 已解决，见进度日志）**：`src/lib/translate/cache.test.ts` 的「keeps serving reads while a large eviction runs in batches」全量跑时偶发超时。根因是测试数据量：6000 条记录在 fake-indexeddb 里填充加淘汰单独跑就要约 1.3s，全量并行时 3–3.7s，偶尔超过 5s；`cache.ts` 的淘汰耗时与记录数线性相关，没有缺陷。现用 `evictBatchSize: 5` 把数据量缩到 1/100，批次结构不变。
  - **审查留下的结构建议（不阻塞）**：内容脚本的装配可抽成 `src/content/runtime.ts`，供 M3 划词共用 Port 与配置；`PageState` 与 `PageStatus` 可合并成一份；设置页预览引用了 `src/content/styles.ts`，样式常量可移到 `src/lib`；`site-memory.ts` 可拆读写两侧，给内容脚本减重。
  - **图标**：已完成「暗岛微光」（PR #5）：暖黑超椭圆底板，一条暖白长线（原文）加一条琥珀短药丸（译文），右下角给状态点留位置；16/32/48 各自按像素网格绘制，128 四周留 16px。PNG 与 `docs/assets/icon/` 的 SVG 都由 `scripts/build-icons.mjs` 生成（`npm run build:icons`）；状态点的底图读 `icon/16.png` 和 `icon/32.png`。
- **M3**（2026-11-16 用户拍板）：拆成 M3a 划词 → M3d 动态页与站点规则 → M3b 段落级交互 → M3c 指令台与灵岛键盘 → M3e Chrome 内置本地引擎。词典态推迟到 M5，与生词本一起做；朗读用 `speechSynthesis`。竞品机制参考 [`docs/reviews/2026-11-16-fluentread-m3-research.md`](docs/reviews/2026-11-16-fluentread-m3-research.md)（本地 FluentRead 调研，只借鉴思路）。
  - **M3a 划词**：原型是 Design artifact「M3 划词翻译」页的 `SelectionM3a`（已确认）；方案经 Opus 对抗式审查修订后获批；分三段实现（A 后台流式、B 接线与配置、C 卡片），`npm run check` 全绿（887 个测试）。
    - Chrome for Testing 自查 8 项通过：用真实 Google 引擎实测，单词、半句、整句三种选区的原文行和译文都一一对应；自查中修了「小点自己展开」的 bug。
    - 用户已同意：方案 1.4 节的全部文案；首屏预算 7KB；`selection-runtime` 预算 18KB；卡片语言名与面板统一（English → 简体中文）。
    - **2026-11-17 已完成 check Deep 审查**：两位 Opus 审查者按领域分工，发现中等问题 4 项、低等若干项，全部修复并补了回归测试，共 924 个测试（方案附录 B）。首屏体积 6.96KB / 7KB，余量很小，以后往引导层加东西前要先评估。
    - **2026-11-17 真机反馈调整与增量审查已完成**（方案附录 D、E）：卡片以小点为锚、滚出视口后停放、避开灵岛、朗读选声、小点避开指针；体积方案选择错误文案改由后台提供（Fable 裁决），共 993 个测试。**首屏 content 只剩约 10 字节余量，下次改引导层前要先处理**（瘦身，或经用户同意调预算）。
    - **已合并**（PR #12，2026-11-17）：用户真机验收通过；真机反馈修复见方案附录 F。
    - **英文单词音标：已实现**（2026-11-17，分支 `feat/phonetics-en`，方案 `docs/plans/phonetics-en.md`，下面是最初的规划，最终实现见方案第 9–11 节）：UK/US 双音标，英音来自 ECDICT（约 17.5 万词）、美音来自 ipa-dict en_US（约 11.7 万词），按前两个字母分片、按需加载；规则变形按音系规则推导读音；英式拼写在美音表按美式拼写互查；朗读修了 Chrome 在线声音的队列卡死；底部朗读对英文默认美音。selection-runtime 预算调到 19KB（用户批准）。
    - **原始规划：M3a 之后的小 PR：英语单词音标**（2026-11-17 用户拍板）：
      - 显示规则：只在选中单个英文单词时显示（允许连字符、撇号），在原文行单词后面显示 `/IPA/`；查不到就不显示。
      - 数据源：ECDICT（MIT 许可，与 M5 词典共用同一份数据）按词频取约 3 万个常用词，只取音标字段，随扩展打包，由后台按需读取；离线、不新增权限。音标偏英式，每个词只有一种读音。
      - 流程：M3a 合并后另开分支，先出方案。
    - **整页翻译待处理（2026-11-17 用户真机发现，留到 M3d 专门处理）**：
      - **处理结果（#56）**：第 1 条已处理：`efx-fig` 用内置站点表跳过；等宽字体启发式与 `figure` 只翻 `figcaption` 不做（原因见 `docs/plans/skip-ui-mock-regions.md`）；装饰符号、版面安全、手动不翻译此区域后移 M3b。第 5 条已解决（#56）。
      - **既有问题（#56 核对时发现，已在 M3b PR1 处理，#61）**：只含行内 `code` 或 `role=img` 的块曾发出只有占位符 `<t0/>` 的请求，白发一次请求，双语模式还会再克隆一份。现 `segment` 新增 `prose` 字段（去掉原样保留元素与 `role=img` 后的文字），`discover` 用 `classifyText(seg.prose)` 判断，不足 2 个字母的单元不发请求。
      - **后续项（#57 记录）**：
        1. 「按句切分」：过长段落按句切分后照常翻译，参考 FluentRead `Intl.Segmenter` 加 480 字符回退；行内标记跨句的段落保留占位，届时可改为可点的「分句翻译」，新文案需用户确认。
        2. 渲染层一帧空窗的既有问题：`fail()` 与 `insert()` 等帧后不检查单元是否已被遗忘，可能留下孤儿失败占位或孤儿、重复译文（`render.ts` 的 fail 写入段与 insert 约 501-560 行），可参照 #57 的 `skipping` 守卫修。
        3. 若真机觉得段末占位太弱，升级路径是占位自身左侧 2px muted 竖条（不碰原文）。
      - **后续项（#58 记录）**：
        1. 冷却计时用 `Date.now`（`mutations.ts`），系统时钟回拨时整页重扫会等到时钟追回，可改 `performance.now`。
        2. `onDirty` 里 `void rescan` 没有串行保护，大页面整页重扫超过 1s 时可能叠跑（PR-E 让 1s 档更常见）。
        3. page-runtime 预算已按 M3b 方案提到 27 KB（PR3 起，`scripts/check-size.mjs`），PR4 后实测 25.65 KB，PR5、PR6 后实测 26.00 KB，余约 1.0 KB，需盯紧。
      - **M3b PR4（按住 Ctrl 切换段落）已知限制**（详见 `docs/plans/m3b.md` 第 4 节实施记录）：
        1. 同一根元素下多段文字相同的 run，可能切错段，且会被一并排除（「不翻译此段」集合按 `seg.text` 记）。
        2. 页面框架替换段落根元素（虚拟列表、keyed 重挂载）后，「不翻译此段」失效。
        3. 焦点在同页 iframe 时顶层收不到按键，需先点回主页面。
        4. 显示加载点的段按住视为取消（按「看到的状态取反」统一规则）。
        5. 按住阈值：首版 400 ms 经用户真机验证容易误触（2026-11-20），已按方案预留的退路调到 600 ms（`src/content/hold/watch.ts` 的 `HOLD_MS`）；若仍嫌灵敏，下一步改为双击修饰键。
        6. 未开整页翻译时手势不起作用（已由 PR5 支持，见下）。
      - **M3b PR5（不开整页也能按住 Ctrl 译段）已知限制**（详见 `docs/plans/m3b.md` 第 5 节实施记录）：
        1. 局部模式下页面框架重挂载根元素后，按住的段直接消失，不从缓存补回。
        2. 局部会话建立期间（配置读取中）的第二次按住会被丢弃。
        3. 在 body 上空白处按住且全页原文不超过 2 万字时，会多做一次扫描（不留痕迹）。
        4. ~~PR6 加开关前，任何网站按住 Ctrl 0.6 秒都会翻译该段~~（已由 PR6 设置项解决，可选 Ctrl / Alt / 关）。
        5. 局部状态下没有一键清除入口：用户 2026-11-20 决定不加面板「还原 N 段」，清除靠在该段再按住一次或刷新页面。
        6. 与其他翻译扩展同时开启（2026-11-20 用户真机发现，coco-translate）：对方也用 Ctrl+悬停，按一次会两边同时翻译（两份译文、对方的绿色 loading）；对方往段落里插入的 `display:block` 包裹元素（类名 `cc-notranslate`，非标准 `notranslate`）会让我们把该段当成混合块，译文变成行内追加。关掉对方后恢复正常。不做兼容（需要维护各家私有类名）；用户可在设置里把按键改成 Alt 或关闭来错开。
      - **M3b PR6（设置项「按住翻译段落」）已知限制**（详见 `docs/plans/m3b.md` 第 6 节实施记录）：
        1. Alt 模式下手势触发后拦截松键默认动作（为 Windows 松开 Alt 时 Chrome 聚焦菜单按钮），**未在 Windows 真机验证**；若无效，按方案退路在 Windows 上隐藏 Alt 选项。
        2. 切换按键或从「关」切回后，需要先移动一下指针才生效。
        3. 常驻层读配置失败时不挂监听，直到下次配置推送。
      - **现象**：claude.dev 博客 `spending-your-effort` 页「Lightly specified design task」小节的示意图（`figure.efx-fig` 里用 DOM 画的终端设置界面：等宽字体、flex 行、短标签，并且由 `efx-slot` 懒加载）被翻译后排版拥挤。标题变成「Settings设置」；标签页一行在原有标签后面追加了「常规 显示 输…」，挤出容器被裁掉；每行在标签后面追加译文，比如「Model› 模型」「Default (recommended)默认（推荐）」。
      - **DOM 已确认**（用户在 DevTools 里截图）：`figure.art-fig.viz.efx-fig[aria-label="The Claude Code /config redesign at each effort level"] > .efx-view > .efx-rail > .efx-slot[role=group][aria-label="Low effort config screen"] > .efc-low > .stage(grid) > .term[tabindex=0][aria-label="Interactive config mock"](可滚动)`。标签页那一行是 `div.efc-low-row.tabs`，里面是一串行内 `span`，整行被当成一个单元，`<et-tr>` 以行内方式追加在这一行的末尾，被挤出容器后裁掉。
      - **顺带发现两处**：
        1. 产品名被直译：「Sonnet」被译成「十四行诗」。这属于专有名词保护，留给 M4 术语库；
        2. 行首的装饰符号「•›」被带进了译文，变成「Model •› 模型 •」。
      - **初步判断**：
        1. 页面特殊：这是用 HTML 画的「界面截图」，读者通常不需要翻译里面的界面文字；
        2. 我们的算法也有不足：flex 行里的短标签各自成为一个单元，译文以行内方式追加在原文后面。遇到定宽、`overflow:hidden`、不换行的容器，就会挤乱或被裁掉。
      - **候选改法**（待 M3d 出方案时定）：
        1. **（已处理：efx-fig 用站点表跳过，其余不做，见上）** 识别「界面示意」区域：以等宽字体为主、由大量短文本组成的容器，或 `role=img`、`aria-hidden` 的 figure，默认不翻译。也可以考虑：在 `<figure>` 内部只翻译 `figcaption` 和普通段落；
        1b. 单元里的装饰符号（•、›、▸ 等）不要进入要翻译的文本；
        2. **（已处理，M3b PR2，`#62`）** 版面安全：单元所在的容器定宽、隐藏溢出或不换行时，不做行内追加，改为放到下方，或者跳过；实际收窄为：作者把单元锁成单行（行内追加遇 `nowrap`/`pre`，或任何单元 `ellipsis` 加 `nowrap`/`pre`）时直接不翻译，见 `docs/plans/m3b.md` 第 2 节；
        3. 站点规则（M3d 本来就要做）：允许按站点排除选择器，例如 `.efx-fig`；
        4. 以后可以加「不翻译此区域」的手动入口。
        5. **（已解决，#56）代码块工具栏**（2026-11-18，Inkmark 协作需求 P2）：claude.dev 的 `<div class="art-code"><div class="ch"><span>CODE<span class="lang">Python</span></span><button>Copy</button></div><pre>…</pre></div>` 中，`CODE Python` 被翻成「代码Python」，污染页面和导出。候选条件：紧邻 `PRE` 的兄弟元素，且含按钮或语言类 class（`lang`、`language`、`filename` 等），且文本很短。出方案前多看几个站点的工具栏结构（有的在 `pre` 之后或之内），与第 1 条「界面示意」统一成一套规则。
      - **另一项 M3 后的改进**：AI 引擎的整页翻译改为逐段出现。模型还在生成一批时，后台边收边解析，某一段完整了就立即渲染；首屏第一批切小。用户已同意排在 M3a、音标之后。
    - **2026-11-17 真机反馈修复已验收通过**（方案附录 F）：
      - Google 偶发「部分句子原样回显」被写进 7 天缓存，每次复现。新增 `src/lib/translate/echo.ts` 的 `isEchoedTranslation`；`scheduler.ts` 的 `complete()` 对回显条目不写缓存；`providers/google.ts` 的 `retryEchoed` 用 `/translate_a/single` 重试一次，失败则保留原结果并停止重试。已补回归测试。
      - 卡片水平定位改为优先向右展开（`src/content/selection/place.ts`）；卡片滚动条改为透明轨道加细滑块。
      - 验收第 3 项（错误文案）、第 8 项（DeepSeek 流式）通过。
      - 体积（gzip）：content 6.99/7KB、page-runtime 21.86/24KB、selection-runtime 17.06/18KB、background 49.08/60KB、popup 79.59/90KB、options 86.21/150KB。
    - **M3a 之后的待办**：
      - ~~**面板设置入口不易发现**~~：已改为齿轮加「设置」文字（2026-11-17，分支 `fix/popup-settings-entry`，用户真机确认亮暗两套）。
      - **引擎供应商图标**（2026-11-17 用户确认效果图和方案）：已实现，见 `docs/plans/provider-icons.md`。设置页「添加服务」对话框里的预设单选项还没有图标，需要时再补。
      - **路线图与发版（2026-11-17 用户确认）**：
        1. 更新高保真原型：**已完成**（原型第 36 版，补了供应商图标、UK/US 音标、齿轮设置入口、卡片优先向右展开等）。
        2. **PR-A** `fix/session-retry-and-start-race`：修复 Codex 清单第 1、2、4 条（见下）。**已合并**（PR #17）：先红后绿，新增 11 个回归用例，69 个测试文件 / 1361 个用例全部通过；content 只增加 1 B。
        3. **CI 增强小 PR**（**已合并**，PR #18）：
           - 构建产物 `.output/chrome-mv3` 作为 artifact 上传，保留 7 天，验收时直接下载；
           - `npm audit --omit=dev --audit-level=high` 硬拦截；全量 audit 只报告；增加 `npm audit signatures`；
             2026-11-18 起硬拦截改由 `scripts/check-audit.mjs` 执行：`scripts/audit-allowlist.json` 按公告 ID 限期豁免（理由 + 到期日），过期、豁免条目不再出现、审计本身出错都会失败。曾有一条 picomatch 的 GHSA-fc5q-39xc-vjpf（ReDoS，只在构建时用），2026-11-19 审计已不再报告，按规则移除（#54），豁免表现为空；
           - Dependabot 每周检查 npm 和 Actions；
           - checkout 加 `persist-credentials: false`，job 加 15 分钟超时；
           - happy-dom 升到 21.0.4，修复一个高危漏洞。

           2026-11-17 用户把仓库改为公开，同一个 PR 里补上了 CodeQL（`codeql.yml`，`security-extended`，PR、push 和每周一运行）和 `actions/dependency-review-action@v5.0.0`（只在 PR 上运行，`fail-on-severity: high`）。需要用户在 Settings → Code security 里开启 Dependabot alerts。**仓库还没有 LICENSE**，待用户决定用哪个许可证。
        - **开源（2026-11-17）**：用户把仓库改为公开。已完成：
          - CI 补上 CodeQL 和 dependency review（PR #18）；
          - main 规则集 `main protection`：禁止删除和强推，合并必须走 PR（审批数 0），并且必须通过 check、dependency-review、analyze 三项检查。以后需要强推时，先临时停用这个规则集；
          - 开启 Dependabot alerts、私密漏洞报告、secret scanning 和 push protection；
          - 历史中 15 个使用公司邮箱的提交已改写成个人邮箱，并已强推；旧提交在 PR #8–#21 中的引用已提交 GitHub 支持工单 #5016642 申请清除，等待答复；本仓库的 local git 邮箱已改为 noreply；
          - 开源准备 PR：LICENSE（MIT）、THIRD_PARTY_NOTICES（扩展包内也附一份，由 check-build 校验两份一致）、SECURITY.md、package.json 的元数据、去掉文档中的本机路径。
          - Dependabot：TypeScript 7 已设为忽略（`@dependabot ignore this major version`）。以后单独升级时，需要修改 `src/entrypoints/options/providers.ts:37` 的 Uint8Array 类型。
        4. **i18n 基础设施**（**已完成**：6 批均已合并（#26、#33、#37、#38、#39、#40、#43），改名与内部标识更新已合并（#41、#42）；以下为当时的规划记录：用户已定界面语言跟随浏览器；方案 `docs/plans/i18n.md` 已获批，分 6 批；**第 1 批基建已合并**（PR #26，经 3 轮审查）；**第 2、3、4 批已合并**（#33、#37、#38、#39），**第 5 批双语 README 已实现**（实施记录见方案第 5 节第 5 条），下一步改名，再第 6 批 zh_TW；第 1–4 批之间不发版。后续小项：CI 在 PR 上把 `scripts/i18n-baseline.json` 与 `origin/main` 比较，每个哈希的次数不得超过主分支，防止手工往基线里加条目）：用 `@wxt-dev/i18n` / `chrome.i18n`，文案放到 `_locales`（zh-CN、en）；读屏的 aria-label 也一起改。**同批完成中英双语 README**：`README.md` 改成英文（默认显示），新增 `README.zh-CN.md`，两份文件顶部互加 `English | 简体中文` 链接；术语和 i18n 的英文文案统一。
        5. **改名**（**已实现**，分支 `feat/rename-islet`，见进度日志 2026-11-18）（用户已定）：中文名 **译屿**，英文名 **Islet Translate**，`short_name` 用「Islet」/「译屿」。查重记录：「译屿」没有发现重名；「Islet Translate」也没有，但 Chrome 商店里有两个只叫「Islet」的扩展（一个日记、一个下载提示），都不是翻译类；Isleglow 已被 Cay Skin 的 Isle Glow 等占用，放弃。需要改的地方：manifest 的 `name`/`short_name`、面板和设置页标题、README、包名（另议）。**设置页左上角还没用插件图标**（目前是一个琥珀圆点加文字，用户 2026-11-18 提出）：改名、换图标完成后一起接入，并检查面板等其他位置是否也该用新图标。图标沿用「暗岛微光」，微调成小岛的意象，**用 Design 原型出方案并自行决策**（见记忆「UI 设计自行决策」），说明取舍后附图汇报。放在双语 README 之后、zh_TW 之前。改名时两份 README 的标题、正文与截图一起改：改完用 `scripts/screenshots/shoot.mjs` 重拍两套截图（灵岛、设置页会带上新名字和图标）。
        4b. **「仅看译文」遗留问题**（2026-11-17 核实，PR #27 已修竖排塌陷）：核实记录见 [`docs/reviews/2026-11-17-translation-only-followups.md`](docs/reviews/2026-11-17-translation-only-followups.md)。小 PR `fix/translation-only-pins`（**已实现**，2026-11-18）：margin/padding 改读 Typed OM（`auto` 不钉、百分比原样），`letter-spacing`/`word-spacing` 以变量 `--et-ls`/`--et-ws` 设回 `et-tr`，补回归测试。同 PR 另一个提交：对外 DOM 约定 [`docs/dom-contract.md`](docs/dom-contract.md)（来自网页导出扩展 Inkmark 的协作需求 P1、P3：`et-tr`、`lang`、`data-et-inline`、`data-et-only`、`data-et-state` 定为约定，改动须在 CHANGELOG 标「DOM 约定变更」；`render.test.ts` 的「DOM contract」一组锁定）。视口单位与媒体查询不跟随接受为已知限制；em 边框/圆角归零等真实反馈再修。
        6. **冒烟 e2e**（i18n 之后）：用 Playwright（Node 版）加载构建产物，在本地测试页上验证三条主流程：整页翻译出译文、划词出现小点和卡片、面板能打开。翻译请求用 mock。另加「仅看译文」布局 fixture（已有手工版 `tests/fixtures/translation-only-layout.html`，含 `max-width: Nch`、`width: Nem`、`flex: 0 0 Nem`、`margin: 0 auto`、`padding: N%`、`letter-spacing: Nem` 及两个已知限制用例），断言切换前后译文根元素不塌陷、不偏移。先作为可选命令，不进 `npm run check`。**进度（2026-11-18）**：PR1 已合并（#44，零依赖 CDP 驱动 + Vitest，`npm run test:e2e`，16 通过、1 预期失败、2 跳过），PR2 已合并（#48，分支 `feat/e2e-smoke-pr2`，新增 10 条用例、修复面板用例偶发失败、CI 标出重试过的用例，e2e 33 通过、2 跳过；第 17、18、24 条已提前完成，第 15 条另开小 PR 并已合并（#51），第 19 条随 M3d PR-B，第 20 条不做），合并后观察 CI 未经重试全绿，已连续约 7 次，满约 10 次由用户在 `main` 规则集把 `e2e` 设为必过；方案与实施记录见 [`docs/plans/e2e-smoke.md`](docs/plans/e2e-smoke.md)。
        6b. **段落加载态**（2026-11-18 用户同意，排在 Codex 第 2 条样式精确恢复之后）：段落进入视口约 600 毫秒仍未出译文时，原文段末显示小加载点，重试时以它代替空白；推翻 `m2-page-translation.md:350`「页内不放占位」，理由见 [`docs/reviews/2026-11-18-ux-triage.md`](docs/reviews/2026-11-18-ux-triage.md)；顺带用 e2e 验证插入译文时阅读位置稳定。**进度**：已合并（#47），方案与实施记录 `docs/plans/paragraph-loading.md`。
        6c. **已解决（#54）：`setMode` 未串行化**：60ms 淡出期间快速连切会停在错误模式（`render.ts:445`）。
        7. **v0.2.0 已发布**（2026-11-18，发版 PR #53，GitHub Release，发版工作流 `release.yml`，版本号、CHANGELOG、README 安装方式均已更新；以下为当时的规划记录）：稳定性检查之后**发 v0.2.0**：**先不上架应用商店**，只发 GitHub Release。同时加发版工作流：推送 `v*` 标签时，校验标签与 `package.json`、CHANGELOG 的版本一致，跑完整检查后执行 `npm run zip`，创建 Release 并附上 zip，说明取自 CHANGELOG 中对应的一段。`package.json` 版本号和 CHANGELOG 的「未发布」同步改成 0.2.0。上架商店需要的材料（128px 图标、隐私政策、商店介绍和截图）等用户决定上架时再准备；商店截图要求 1280×800，届时给截图脚本加视口参数即可。发版前再定：Release 说明的语言（CHANGELOG 目前是中文，建议说明先用中文，或中英两段）；`package.json` 的 `description` 仍是中文「网页翻译 Chrome 扩展」，建议改成英文 `Bilingual web reading for Chrome`，与 README 一致。
        8. 然后做 M3d（含 PR-B）。进度：M3d 已拆分（`docs/plans/m3d.md`），B1 已合并（#54），B2 已合并（#55），D 已合并（#56），C 已合并（#57），M3d 全部完成（E 已合并，#58），发版前界面小修已合并（#59），**v0.3.0 已发布**（发版 PR #60，GitHub Release，方案与实施记录 `docs/plans/release-v0.3.0.md`）；M3b 已开工：拆为 6 个 PR（拆分文档 `docs/plans/m3b.md`），PR1 无字母单元与分隔符已合并（#61），PR2 版面安全已合并（#62），PR3 常驻层瘦身已合并（#63），PR4 整页会话内按住 Ctrl 切换段落已合并（#64），PR5 不开整页也能按住 Ctrl 译段已合并（#66），PR6 设置项已合并（#67），**M3b 全部完成**（含从 M3d 移入的装饰符号剥离、版面安全；手动「不翻译此区域」已按方案移到 M3c）；**v0.4.0 已发布**（发版 PR #68，GitHub Release，方案与实施记录 `docs/plans/release-v0.4.0.md`）；下一步按路线图做 M3c 指令台与灵岛键盘。版本号保持 0.x，功能和接口稳定后再出 1.0。每完成一批，Agent 要主动评估离发版还差什么，接近时提醒用户。
      - **Codex 复核清单（已核实；第 1、2、4 条已由 PR-A 修复，第 3 条和第 6 条随 M3d 处理）**：用户请 Codex 审查核心实现，清单见 [`docs/reviews/2026-11-17-core-implementation-findings.md`](docs/reviews/2026-11-17-core-implementation-findings.md)。Opus 子代理在 `dd5d58b` 的隔离副本里逐条写了先红的复现测试，核实结论见 [`docs/reviews/2026-11-17-core-findings-verification.md`](docs/reviews/2026-11-17-core-findings-verification.md)：
        1. 延时重试期间会话暂停，那批段落永久漏译：属实，**P2**（Codex 定 P1）。只有 Service Worker 重启等基础设施错误才会进入请求级重试，并且要和引擎错误先后撞上才会触发；一旦触发，会悄无声息地丢掉视口内的译文。同源的两个疑点：已 `forget` 的段落被复活、同一批被重复请求。
        2. 旧启动流程失败会停掉新会话：逻辑属实，**P3**，几乎无法触发。
        3. 初次扫描期间新增的动态内容漏译：属实，**P2**。另外发现：新内容追加到还没扫描完的容器里时，会和容器的文字合并成一个行内 run，导致排版错乱。
        4. 划词配置的首次读取会覆盖更新后的设置：属实，**P3**。读取失败后还会一直沿用过期配置。
        5. Google 备用接口吞掉 429：这是有意为之，不是缺陷，作为观察项。
        6. 新发现：会话订阅配置晚于初次扫描，扫描期间修改的样式会丢失：**P3**，读代码发现，没有复现。
        - **排期**（用户同意「后边顺手修掉」）：音标 PR 合并、更新原型之后，开 **PR-A `fix/session-retry-and-start-race`**，修第 1、2、4 条，每条先补红的回归测试；第 3 条和第 6 条改的是 `begin` 里同一段代码，需要在真实浏览器里验收动态页面，所以**并入 M3d（PR-B）**。
      - **i18n 提前**（2026-11-17 建议，用户同意排期）：原计划放在 M4。改为在音标之后、M3d 之前，单独做一批「i18n 基础设施」。理由：界面文案已有几百条写死在代码里，M3b、M3c 还会新增大量文案；`chrome.i18n` 把文案放在 `_locales`，不进脚本包，不占体积预算。开工前需拍板：界面语言跟随浏览器，还是在扩展内提供切换。
      - **卡片「重试」不绕过缓存**：只在出错时出现，成功但内容坏的卡片没有入口，暂不做。
      - **「翻译服务返回了空结果」未能复现**（claude.dev，Google）：根因未知，推测与当时出口 IP 被 Google 限流降级有关；再遇到需要抓现场。
      - ~~PR #10、#11 合入~~：已在 M3a 提交后合入，M3a 以 PR #12 合并。
    - **已知待观察**：40 字以内的英文句子，Chrome 语言检测常报不可靠，卡片顶部显示「自动检测」，这是检测本身的限制。
- **界面方向已确认**：「隐中生岛」加琥珀主题色，完整规范见 [`docs/plans/ui-isle-direction.md`](docs/plans/ui-isle-direction.md)。原型在 https://claude.ai/artifact/GJTgsP7SFHmhP6M2SczwTp 。最高原则：人的感受第一、少打扰、近乎原生的沉浸阅读。
  - 默认在所有页面上都不留痕迹，由用户主动唤起。
  - 不常驻悬浮球。
  - 支持左、右、底部三种停靠位置。
  - 动效用单一形状加弹簧驱动。
  - 旧 UI 规范 `docs/reviews/2026-11-13-ui-ux-design.md` 中被取代的章节已在其文件头标注。
- **竞品痛点即我们的差异化**（2026-11-13 调研沉浸式翻译等）：
  - 免费额度不透明、订阅弹窗打扰；
  - 大页面卡顿；
  - 排版错乱、悬停结果消失；
  - 429 只能手动换引擎；
  - 每个页面默认显示浮球，需要逐站关闭。
  - 从 M2 起，每个批次的方案都要有一节「差异化」，说明针对上述哪一条。
  - 可参考的竞品机制：沉浸式翻译公开的站点规则 JSON（`.add` / `.remove` 增量语法与 `id` 继承）、视口预翻译、字幕遇到 429 时回退原字幕。
- **留给 M2 及以后的约定**（来自 M1 方案的审查和参考项目调研）：
  - SW 被回收后，在途请求会丢失，后台不做恢复。**由 M2 的内容脚本负责 Port 重连，并重发未完成的段**；已完成的段会命中缓存。
  - **M2 开工前先实测**：`{{n}}` 一类占位符经过 Google 翻译后的保留率，再据此确定占位符格式。占位符与原文发生冲突时，换用新的随机标记（nonce）。
  - 模型写坏占位符时，用正则容错修复后再还原。还原出的 HTML 走白名单过滤，并校验 `href` 协议，拒绝 `javascript:`。
  - 行内标签用编号标记保护，并校验出现次数、配对和嵌套。用 MutationObserver 检测框架重新挂载节点，并恢复译文。
  - 首屏按字符预算优先翻译，其余用 IntersectionObserver 懒加载，`rootMargin` 设为 1000px。
  - M3 的输入翻译要兼容 Lexical、ProseMirror、Draft.js、Slate、Quill 等富文本编辑器；M5 的字幕以当前时间 ±10 秒为滚动窗口预取。
  - **来自 M1 第 3b 步，留给 M2 的事项**：
  - 工具栏面板体积预算已从 80KB 调到 90KB（React 运行时是固定开销）。M2 往面板加功能时，如果超过 90KB，先评估更轻的运行时，不再直接调预算。
  - 工具栏图标改成单色字形加状态小点（已翻译用琥珀色，有失败用珊瑚色），和 `action.setIcon` 一起做；面板上「翻译此页」「这次先用 Google 翻译」「总是翻译此站」随 M2 接入。**M2a 已接入状态点和面板；图标已按「暗岛微光」重新设计（PR #5）。**
  - ~~manifest 没有设置 `minimum_chrome_version`~~：M2a 定为 117。
  - ~~兼容 OpenAI 接口的流式响应在后台累积时没有长度上限~~：M2a 加了 64000 字上限（OpenAI 兼容与 Gemini），超过按截断处理。
  - 同一地址上的多个自定义服务共享限流冷却（有意为之）；如果用户反馈同一聚合平台上多个账号互相拖累，再改成按地址加密钥区分。
- **来自 M1 架构审查，留到对应批次再做（现在做属于过度设计）**：
    - M2：视口优先由内容脚本控制提交顺序，调度器不加优先级。
    - M3：给 `scheduler.submit` 增加可选参数 `onDelta`，并在 `TranslateChunk` 中增加 delta 分支，用于划词流式。新增第三个调用方时，把 `service` 和 `admin` 里重复的「解析配置 → 适配器 → 提示词」抽成 `resolveJobContext()`。
    - M4：引入 `TranslateOptions`（temperature、style、glossary），统一计算 `paramsDigest`；`buildPrompt` 和 `ProviderContext` 都要接收这些参数。
    - 下次新增 provider 时：把 `resolveProviderSettings` 移出 registry，改为表驱动，并让 `SecretProviderId` 由 `Engine` 派生。

M1 和 M2（整页翻译）完成后即构成 MVP。

## 3. 假设验证表（原第 6 节）

| 假设 | 何时验证 | 不成立时的处理 |
| --- | --- | --- |
| 内容脚本的 `<all_urls>` 能让后台跨域 fetch | M1 | 扩大 `host_permissions` |
| Translator / LanguageDetector API 在 Service Worker 中**不可用** | M3 前 | 本地引擎放到内容脚本或 offscreen document 执行，后台语言检测只用 `chrome.i18n.detectLanguage` |
| Port 消息能刷新 SW 的 idle 计时 | M1 | 内容脚本断线后重连并重发未完成的段落 |
| 本地 Ollama 接受扩展后台发出的请求（来源为 `chrome-extension://`） | **已实测（2026-11-14）：默认拒绝，返回 403** | 已处理：本地 403 单独提示设置 `OLLAMA_ORIGINS`，README 有接入说明；设置后必须从菜单栏彻底退出 Ollama 再打开 |
| YouTube 的 `captionTracks` 能直接取到字幕 | M5 | 回退到 hook 网络请求，并给出失效诊断提示 |

## 4. 旧开发流程与 i18n 真机验收注意（原第 8 节）

1. **方案**：先用 `think` skill 制定技术方案。
2. **方案审查**：对方案做一次审查。审查没问题、且用户确认之后，才能开始实现。
3. **实现**：在新分支上开发（不直接在 main 上开发），同时编写测试用例。
4. **代码审查**：完成后用 `check` skill 审查。有问题就修，修完再 check，循环到**没有阻断性问题**为止。
5. **文档同步**：更新相关文档（`CHANGELOG.md`、本文的进度日志和状态、README、方案文档等），确保文档与代码改动一致。
6. **汇报**：向用户汇报结果。
7. **提交**：提交并推送分支，视情况开 PR。
8. **合并**：CI 通过后由**用户手动合并**。Agent 不自行合并，也不开启 auto-merge。
9. **收尾**：用户告知已合并后，切回 main 拉取最新代码，清理已合并的本地和远端分支，再视情况进入下一阶段。

> 注：CI 在 M0 中建立。M0 的 PR 开出时 CI 才首次运行，需确认它能通过。

> **i18n 真机验收注意**（2026-11-17）：Chrome 只在加载或重新加载扩展时读取 `_locales`，页面 JS 却每次都从磁盘读最新文件。因此，凡是改了 `src/locales` 的构建（i18n 第 2–6 批每批都会改），覆盖 `.output` 之后必须在 `chrome://extensions` 点一次「重新加载」，否则新代码会查不到新键。表现为扩展错误页出现 `[i18n] Message not found: "…"`，界面文案为空；`meta.locale` 缺失时 `uiLocale()` 回退为 `en`。用户在第 1 批合并后遇到过一次：报错堆栈里的 chunk（`popup-DHqEj0wc.js`）不属于当前产物，当前产物的 `_locales` 两个语言都有 `meta_locale`。用户重新加载扩展后报错消失，已确认原因。在 Chrome 商店更新或重新加载时会一并换掉文案目录，不影响最终用户。验收前先清空扩展错误页，避免把旧错误当成新问题。

## 5. 原「最后更新」流水账

> 最后更新：2026-11-20 · 阶段：**路线图前 3 项已完成**（PR-A #17、CI 增强 #18），仓库已开源（#23，MIT）；**i18n 第 1 批基础设施已合并**（#26）；只看译文的两处修复已合并（#27、#28），Google 丢标签时改用 HTML 模式重试、保住译文里的链接（#30）。插件已改名为 **译屿 / Islet Translate**（#41），GitHub 仓库改为 `jiangding01/islet-translate`，本地文件夹改为 `~/islet-translate`。**i18n 第 2 批已合并**（#33），运行时依赖审计支持按公告 ID 限期豁免（#34；唯一的 picomatch 条目已于 2026-11-19 随上游修复移除，#54）。**`fix/translation-only-pins` 已合并**（#35，含对外 DOM 约定 `docs/dom-contract.md` 与手工验收页 `tests/fixtures/translation-only-layout.html`）；灵岛拖动窗口时的残影修复已合并（#36）。**i18n 第 3 批拆成两个 PR**：3a 面板已合并（#37）；3b 设置页已合并（#38，含修复 3a 引入的「中文环境下扩展无法加载」）。**第 4 批按需模块已合并**（#39，基线清零，扩展界面全部支持中英文）；**第 5 批双语 README 已合并**（#40，含截图工具 `scripts/screenshots/`）；仓库改名后的引用与内部标识更新已合并（#42）；**第 6 批 zh_TW 已合并**（#43）；之后冒烟 e2e → v0.2.0。**冒烟 e2e PR1 已合并**（#44，方案与实施记录 `docs/plans/e2e-smoke.md`）；Codex 两轮评审已核实并排期（`docs/reviews/2026-11-18-codex-review-verification.md`）。**Codex 第 1、2、5、7 条、段落加载态、冒烟 e2e PR1/PR2 及第 15 条均已合并（#44 至 #51）**：P1 编辑区重扫保护（#45，`docs/plans/rescan-protected-areas.md`）、样式精确恢复（#46，`docs/plans/translation-only-style-restore.md`）、段落加载态（#47，`docs/plans/paragraph-loading.md`）、e2e PR2（#48，`docs/plans/e2e-smoke-pr2.md`）、面板「仍然翻译」（#49，`docs/plans/popup-translate-anyway.md`）、缓存清扫与如实报错（#50，`docs/plans/cache-honesty.md`）、扩展重载后不报错与失联即 halt（#51，`docs/plans/e2e-reload-extension.md`）。**v0.2.0 已发布**（GitHub Release，发版工作流 `.github/workflows/release.yml`，方案与实施记录 `docs/plans/release-v0.2.0.md`）。**e2e 已设为必过**（2026-11-20，用户授权加入 `main` 规则集，此前 CI 连续 13 次完成运行 e2e 全绿且无重试告警；现必过：check、dependency-review、analyze、e2e）；之后做 M3d（Codex 第 3、4、6 条等）。M3d 已开工（拆分与决定见 `docs/plans/m3d.md`），B1 固定引擎与 setMode 串行化已合并（#54），B2 先监听后扫已合并（#55），D 跳过界面示意区域已合并（#56），C 过长段落占位与计数已合并（#57）；M3d 全部完成（E SPA 路由与整页重扫冷却已合并，#58）；发版前界面小修已合并（#59）；**v0.3.0 已发布**（发版 PR #60，GitHub Release，方案与实施记录 `docs/plans/release-v0.3.0.md`）；下一步按路线图做 M3b 段落级交互（含从 M3d 移入的装饰符号剥离、版面安全与手动「不翻译此区域」）；**M3b 方案已批准（`docs/plans/m3b.md`，6 个 PR），PR1 无字母单元与分隔符已合并（#61），PR2 版面安全已合并（#62），PR3 常驻层瘦身已合并（#63），PR4 整页会话内按住 Ctrl 切换段落已合并（#64），PR5 不开整页也能按住 Ctrl 译段已合并（#66），PR6 设置项「按住翻译段落」已合并（#67）；M3b 全部完成；v0.4.0 已发布（发版 PR #68，GitHub Release，方案与实施记录 `docs/plans/release-v0.4.0.md`），下一步按路线图 M3c 指令台与灵岛键盘**。 TypeScript 已升到 6.0.3（#32，本地在最新 main 上验证 `npm run check` 通过后合并）。详见第 5 节「路线图与发版」。
