<!-- handoff: head=6259ce6 branch=feat/llm-batch-revoke updated=2026-11-25T12:00:00+08:00 by=claude-opus-5-5 -->
# HANDOFF：译屿 / Islet Translate

> 本文给接手的 Agent 或开发者用，按顺序读完即可开工。与其他文档冲突时，以本文和第 2 节「文档地位」表中的权威文档为准。本文只写现状，不写流水账：进度写进 `CHANGELOG.md` 和 [`docs/history.md`](docs/history.md)。

## 0. TL;DR
- 是什么：译屿（Islet Translate），Chrome MV3 网页翻译扩展，WXT 0.21 + React 19 + TypeScript strict + Vite 8 + CSS Modules；独立新扩展，不读取、不迁移旧扩展数据。
- 停在哪：**v0.5.0 已发布**（发版 PR #82，M3c 收尾）；M0–M3c、i18n、冒烟 e2e 全部完成；**M3c 已完成**：方案 `docs/plans/m3c.md` 已批准（6 个 PR），PR1「指令台本体」（#70）、PR2「设置入口与快捷键显示」（#71）、PR6「灵岛 ⌘ 入口与铰链位置」（#74）、PR3「快速翻译框」（#77）、PR4「翻译一个区域」（#78）、PR5「不翻译一个区域」（#79）已合入 `main`，M3c 六个 PR 全部完成（实施记录见方案「PR1 实施记录」至「PR5 实施记录」）。
- Gemini 架构审查已核实并裁决（`docs/reviews/2026-11-24-gemini-review-verification.md`，执行清单在第 6 节、用户决定在第 7 节）：唯一的 P2 真 bug「LLM 思维链（`<think>`）未剥离」已修（#75）；渲染三项小修（等帧空窗守卫、重扫不再重新分段、首屏不等防抖）在 #76 完成。
- 下一步：**请用户真机验收 AI 逐段显示（PR① #83、PR② #87），之后评估发 v0.6.0 或继续小批可选项**。PR②「长度对照拦截 + 撤回重译」（#87，方案 `docs/plans/llm-batch-revoke.md`）随本文提交：整批校验失败时页面撤下提前显示的段并单段重译，残余风险见 `docs/known-issues.md`。体积：palette-runtime 已用 17.80 / 18 KB，只剩约 0.2 KB，往指令台加东西前要先评估。M3c 六个 PR 的真机验收已全部通过（2026-11-24；PR1/PR2 的补丁为 #72，PR6 验收发现的「指令台开着时切换停靠位置错位」由 #80 修复）。未验证：Windows/Linux 上 Alt+Shift+K 与 accesskey 冲突。

## 1. 目标与范围
- 目标：做近乎原生、少打扰的沉浸式双语阅读（界面方向「隐中生岛」+ 琥珀主题，见 `docs/plans/ui-isle-direction.md`）；差异化针对竞品痛点：免费额度不透明与订阅弹窗打扰、大页面卡顿、排版错乱与悬停结果消失、429 只能手动换引擎、每页默认浮球。**从 M2 起每个批次的方案都要有「差异化」一节**。
- 完成标准：路线图 M0–M6 做完整全部翻译能力（M1 + M2 已构成 MVP），M7 可选打磨，M8 视情况再定账户。版本号保持 0.x，功能和接口稳定后再出 1.0；每完成一批，Agent 要主动评估离发版还差什么，接近时提醒用户。
- 明确不做：账户、登录、订阅/会员、短码、Coco 等依赖账户的服务端接口（只保留 `AuthState` 恒匿名、`getTier()` 全放行、provider 注册表 3 个扩展点）；网页正文的文章模式；不常驻悬浮球；不兼容其他翻译扩展的私有类名。

## 2. 当前状态
- 分支 / HEAD：`main`（已合入 M3c 全部 PR #70–#79、验收补丁 #80、设置页入口 #81、发版 #82、小批 PR① #83；v0.5.0 已发布）；本文随小批 PR② 修改。
- 未提交改动：无。
- 验证状态：截至小批 PR② `npm run check` 通过，单测 2343 个（89 个文件），e2e 81 通过 2 跳过；CI 必过：**check、dependency-review、analyze、e2e**（`main protection` 规则集：禁强推、禁删除、必须走 PR；需要强推时先临时停用规则集）。
- 体积预算（gzip，`npm run check:size`，已用 / 预算，KB）：content 7.65 / 7.75（余 0.10，**改引导层或常驻监听前必须先评估**）、page-runtime 27.14 / 28（余约 0.86）、selection-runtime 18.20 / 19、palette-runtime 17.80 / 18（用户 2026-11-24 批准由 15 提到 18 KB，随 PR4 生效；余约 0.2）、background 59.40 / 60（PR① +1.07、PR② +0.48；余约 0.6，M3e 新增 provider 前大概率要单独报批）、popup 83.28 / 90、options 89.67 / 150；音标分片英 1.41 MB、美 0.80 MB（各 2 MB，单片 40 KB）。
- 已发布版本：v0.2.0（#53）、v0.3.0（#60）、v0.4.0（#68）、v0.5.0（#82），仅 GitHub Release，暂不上架应用商店；打 `v*` 标签由 `.github/workflows/release.yml` 发布，**打 tag 前先问用户**。
- 路线图：**M3c 已完成并随 v0.5.0 发布（方案 `docs/plans/m3c.md`）→ 体验债小批（不新开里程碑编号）→ M3e Chrome 内置本地引擎 → M4（术语库、`TranslateOptions`、专有名词保护）→ M5（字幕、生词本与词典态）→ M6 → M7 → M8**。小批（用户 2026-11-24 同意，见核实文档第 6、7 节）：必做「LLM 批量逐段提交 + 增量解析」（M3e 硬前置，先用 think 写方案过审，两条硬约束：顺序前缀规则、缓存延后写）；可选 Shadow DOM 测量 spike、浮层协调器重构（PR5 合并后）、边扫边注册。批次细节与验收见 `docs/reviews/2026-11-13-final-plan.md`。M3d 已完成（用户决定的拆分见 `docs/plans/m3d.md`），M3b 已完成并含从 M3d 移入的装饰符号剥离、版面安全，手动「不翻译此区域」已移到 M3c。

## 3. 已定决策
- 优先级：先做完整翻译能力（M0–M6），可选打磨放 M7，账户放 M8 —— 用户 2026-11-13 拍板。
- 文章精翻必做，基于用户自配 AI 供应商（BYOK），范围仅限字幕；分块句数与 token 双上限（约 50 句 / 约 800 token），块并发 2，失败块降级逐句 —— 不依赖账户。
- 默认引擎 Google 非官方端点（零配置），设置里一键切 BYOK；默认引擎失败时**不自动**降级本地引擎，只在错误提示里给一键切换 —— 避免静默改变翻译来源。
- 内容脚本用 `<all_urls>` 静态注入，但常驻首屏脚本极小，其余是按需模块 `page-runtime.js`、`selection-runtime.js`、`palette-runtime.js`（动态 URL 的 WAR，最低 Chrome 130）—— 后台注入需要全部网站权限，被否决（见 `docs/plans/m2b-lazy-runtime-and-isle.md` 附录 A）。
- 按需模块硬约束：单文件、零 import；跨包只共享类型和无副作用常量；灵岛等 UI 里禁止出现任何扩展地址（图片、CSS `url()`、字体），否则网页能截获动态地址。
- 默认快捷键不用 Option 组合，改用 `Ctrl+Shift+字母`（macOS 为 manifest 中的 `MacCtrl+Shift+…`）—— macOS 上 `⌥X` 会输出字符，影响德语、北欧语言输入。
- 内容脚本防串写：维护当前有效 reqId 集合或本地 epoch，只接受当前会话的结果。
- lint/format 用 Biome 2；字幕阅读面板用页内 Shadow DOM，不用 `chrome.sidePanel`；生词本放 M5，与术语库共用存储与导出；截图分享只做简化版放 M7。
- 词典态推迟到 M5；朗读用 `speechSynthesis`；M3 顺序 M3a → M3d → M3b → M3c → M3e（用户 2026-11-16 拍板）。
- 界面语言跟随浏览器，支持 en / zh_CN / zh_TW（zh_HK 与繁体 README 不做）；名称「译屿 / Islet Translate」（查重已做），仓库 `jiangding01/islet-translate`，IndexedDB 库名等内部标识已随改名更新。
- 范围外的新增功能、配置项、开关或用户可见文案，先问用户要不要加；新增配置字段在 `schema.ts`、`defaults.ts` 追加并给默认值，只有破坏性变更才升 `schemaVersion` 并写迁移。
- 对外 DOM 约定见 `docs/dom-contract.md`（`et-tr`、`lang`、`data-et-*`），改动须在 CHANGELOG 标「DOM 约定变更」。
- 「仅看译文」、翻译占位符、标签保护等实现细节以各 `docs/plans/*.md` 为准，这里不重复。

## 4. 待办
1. 体验债小批（核实文档第 6 节执行清单 #5–#8）：必做项 PR①「AI 批量逐段提交」已完成（#83；规则：顺序前缀才提前提交，只缓存经过整批校验的结果）；PR②「长度对照拦截 + 撤回重译」已完成（#87；整批校验失败时发撤回帧，页面撤下并重排，被撤回的段单段成批且永不撤回；不改提示词）；可选 `chore/shadow-dom-survey`（两个常用站待用户指定）、`refactor/overlay-coordinator`、`perf/scan-streaming-register`（带大页面 e2e 与「每段只发一次」断言）。
2. 之后按路线图做 M3e 本地引擎；开工前先实测 Translator / LanguageDetector API 在 Service Worker 中是否可用。
3. 仍有效的已知限制与后续项（按住 Ctrl 手势、冷却计时、流式思维链缺口、观察项等）见 [`docs/known-issues.md`](docs/known-issues.md)，动到相关代码前先读。

## 5. 坑与注意事项
- **改体积敏感代码前先看第 2 节余量**：content 只剩 0.10 KB，page-runtime 约 1.05 KB、palette-runtime 约 0.2 KB（预算 18 KB），超了先瘦身，经用户同意才调预算。popup 已调到 90 KB，往里加依赖前先评估。
- **验证 manifest 权限与授权流程只能用生产构建**（`npm run build`）：WXT 开发构建会给 manifest 加 `http(s)://*/*`，Chrome 会提示可选权限多余。
- **改了 `src/locales` 后必须在 `chrome://extensions` 点「重新加载」**：Chrome 只在加载或重载扩展时读 `_locales`，页面 JS 却每次读最新文件，否则出现 `[i18n] Message not found`；验收前清空扩展错误页。i18n 中文硬编码按哈希基线只减不增（`scripts/i18n-baseline.json`，`npm run check:i18n`），规则见 `docs/plans/i18n.md` 第 4 节。
- 本地 Ollama 默认拒绝扩展来源（403）：需设置 `OLLAMA_ORIGINS`，并从菜单栏彻底退出 Ollama 再打开（已实测，README 有说明）。
- Port 的调用方切换会话前必须先 `cancelAll()`；写操作保持幂等（`call()` 把所有发送失败归为「后台不可达」，可能实际已写入）。SW 被回收后在途请求丢失，由内容脚本重连并重发。
- 同一地址上的多个自定义服务共享限流冷却（有意为之）；Google 备用接口吞 429 是有意为之。
- 防探测：`check:build` 只对 WAR 里的按需模块断言不读 `runtime.id`、不含 `getURL` 和扩展地址；常驻内容脚本另有 `alive()`（读 `browser.runtime?.id` 判断失联）的既有用法，不受这条断言约束。常驻脚本不得含 `getMessage`（check:build 断言）；按需模块失联靠 `i18n.getUILanguage` 判断并 halt。
- 依赖：TypeScript 已升到 6.0.3，Dependabot 已忽略 TS 7，将来单独升时要改 `src/entrypoints/options/providers.ts:37` 的 Uint8Array 类型。依赖审计硬拦截由 `scripts/check-audit.mjs` 执行，`scripts/audit-allowlist.json` 按公告 ID 限期豁免（当前为空）。
- 分段边界只看计算样式（`src/content/dom-rules.ts` 的 `isInlineElement`）；脱离文档流元素按标签判断；flex/grid 子元素各自成单元。
- 新增 provider 时把 `resolveProviderSettings` 移出 registry 改为表驱动（其余 M1 架构审查遗留见 known-issues 第 5 节）。
- 子代理汇报要核实：验收先看 `git status` / `git diff`，曾有子代理谎报已加用例；检查命令里不要夹带改工作区的 git 命令（如 `git stash`）。
- 与其他翻译扩展同时开启（如 coco-translate）会重复翻译，不做兼容；用户可把「按住翻译段落」键改成 Alt 或关闭。

## 6. 文件与文档地图
| 文档 | 地位 | 用法 |
| --- | --- | --- |
| `HANDOFF.md`（本文） | 最高优先：现状、已拍板决策、下一步 | 开工前必读 |
| `docs/reviews/2026-11-13-final-plan.md` | 权威技术方案：架构、选型、目录、核心接口、M0–M8 与验收、风险 | 实施依据 |
| `docs/reviews/2026-11-13-ui-ux-design.md` | 权威 UI/UX 规范（被取代的章节已在文件头标注）；方向补充见 `docs/plans/ui-isle-direction.md`，原型 https://claude.ai/artifact/GJTgsP7SFHmhP6M2SczwTp | 所有 UI 的依据 |
| `docs/plans/*.md` | 各批次方案与实施记录（每个 PR 一份，含已知限制） | 动某模块前读对应方案 |
| `docs/design/00–15`、`reference/*.json` | 旧方案，降级为功能参考；架构、协议、配置写法冲突时不采用 | 实现某功能时查行为细节 |
| `docs/reviews/*.md` | 评审与核实记录（Codex、FluentRead 调研、UX 分诊等） | 需要取舍理由时读 |
| `docs/reviews/2026-11-24-gemini-review-verification.md` | Gemini 架构审查的核实、裁决、执行清单与用户决定（小批、Preact、Shadow DOM 门槛） | 排 v0.5.0 后的工作、动 LLM 批量或扫描渲染前读 |
| `docs/history.md` / `docs/known-issues.md` | 历史归档（进度日志、各批次记录）/ 仍有效的已知限制与后续项 | 查历史、查遗留 |
| `docs/dom-contract.md` | 对外 DOM 约定 | 改渲染结构前读 |
| `README.md` / `README.zh-CN.md` | 英文（默认）/ 中文 README | 功能或结构变化后两份同步；截图用 `scripts/screenshots/shoot.mjs` 重拍 |
| `CHANGELOG.md` | 功能迭代记录 | 每个用户可感知的改动在「未发布」下追加 |
| `DESIGN.md` | 已过时的骨架期规范 | 不要依据它 |

目录要点：`src/lib/translate/`（provider、调度器、缓存、密钥、服务、Port `et-translate`）、`src/content/`（常驻引导 `bootstrap.ts`、整页会话、渲染、灵岛 `isle/`、划词 `selection/`、按住手势 `hold/`）、`src/entrypoints/`（background、content、popup、options）、`src/lib/phonetic/` 与 `public/dict/`（音标）、`src/locales/`（en、zh_CN、zh_TW）、`scripts/`（check-size、check-i18n、check-contrast、check-audit、check-build、build-icons、screenshots）、`tests/e2e`（零依赖 CDP 驱动 + Vitest，方案 `docs/plans/e2e-smoke.md`）。

## 7. 验证方式与协作约定
```bash
npm run check          # 提交前必须完整跑一遍：lint、typecheck、单测、i18n、对比度、build 与体积；不要拆开挑着跑
npm run test:e2e       # Chrome for Testing 冒烟 e2e（也在 CI 里，必过）
npm run dev | build | lint | format | typecheck | test | zip
```
- 全程用**简体中文**；React + TS，不用 class，优先具名 import；写代码前先描述方案等批准（改动很小且意图明确、或用户说「直接改」除外）；大批量阅读与实现交给子代理，主会话只做澄清、拆解、分发、验收。
- 提交约定（用户 2026-11-18 起长期授权）：文档已更新、check 审查通过后，**可直接提交、推送并开 PR**；**合并始终由用户手动完成**，Agent 不合并、不开 auto-merge；打 tag、发版前先问用户。commit message 用简体中文多行（做了什么 / 如何验证 / 出问题如何回滚）。
- 进度记录：写进 `CHANGELOG.md` 和 `docs/history.md`；本文只改写状态，不追加流水。
- 开发流程（每个批次都按此循环）：① `think` skill 写方案，参考 `docs/plans/` 既有方案与本地 FluentRead → ② 方案审查（审查通过、用户确认后才实现）→ ③ 在 `feat/` 或 `fix/` 分支实现并写测试（先红后绿；线上 Bug 补回归用例）→ ④ `check` skill 审查，有问题修复后再审，直到无阻断问题（最多 3 轮）→ ⑤ 同步文档，**写成终态**（不写「待合并」，开 PR 后补 PR 号；发版除外）→ ⑥ 汇报 → ⑦ 提交、推送、开 PR → ⑧ CI 通过后用户合并 → ⑨ 用户说已合并后切回 `main` 拉取，清理已合并分支与 worktree。
- 修同一问题两次仍不好：加日志看真实数据；三次仍不好：停下写摘要，建议开新会话。

## 8. 溯源
- 会话记录：`/Users/jiangding/.claude/projects/-Users-jiangding-islet-translate/4b88f789-47e8-47e4-9f8a-59c885237db9.jsonl`（2026-11-23 精简本文并起草 M3c 方案的会话；现状以本文和 git 为准）。
- 桌面端会话：不适用。
- 详细历史：[`docs/history.md`](docs/history.md)（原进度日志与各批次记录）、[`docs/known-issues.md`](docs/known-issues.md)、`CHANGELOG.md`、`git log`；各 PR 的方案与实施记录见 `docs/plans/`，评审记录见 `docs/reviews/`。
