# 已知限制与后续项

> 从 `HANDOFF.md` 搬出、仍然有效的已知限制、观察项与后续规划项，原文搬运（已标删除线的条目保留原样作说明）。已完成批次的完整记录见 [`history.md`](history.md)。解决一项后，请在此处划掉并注明 PR 号。

## 1. 按住修饰键翻译段落（M3b PR4 / PR5 / PR6）

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

## 2. M3d 后续项（#57、#58 记录）

      - **后续项（#57 记录）**：
        1. 「按句切分」：过长段落按句切分后照常翻译，参考 FluentRead `Intl.Segmenter` 加 480 字符回退；行内标记跨句的段落保留占位，届时可改为可点的「分句翻译」，新文案需用户确认。
        2. 渲染层一帧空窗的既有问题：`fail()` 与 `insert()` 等帧后不检查单元是否已被遗忘，可能留下孤儿失败占位或孤儿、重复译文（`render.ts` 的 fail 写入段与 insert 约 501-560 行），可参照 #57 的 `skipping` 守卫修。
        3. 若真机觉得段末占位太弱，升级路径是占位自身左侧 2px muted 竖条（不碰原文）。
      - **后续项（#58 记录）**：
        1. 冷却计时用 `Date.now`（`mutations.ts`），系统时钟回拨时整页重扫会等到时钟追回，可改 `performance.now`。
        2. `onDirty` 里 `void rescan` 没有串行保护，大页面整页重扫超过 1s 时可能叠跑（PR-E 让 1s 档更常见）。
        3. page-runtime 预算已按 M3b 方案提到 27 KB（PR3 起，`scripts/check-size.mjs`），PR4 后实测 25.65 KB，PR5、PR6 后实测 26.00 KB，余约 1.0 KB，需盯紧。

## 3. 渲染与分段的既有取舍

- M2a 分段取舍（原第 5 节 M2a）：
    - 已知取舍（与 FluentRead 相同）：弹性容器里「直接写的文字 + 链接」会被分成两段翻译，行内片段的译文还会成为容器的一个新项，在 `justify-content: space-between` 的容器里可能被推到中间。FluentRead 靠把原文包进一个合成 span 来避免，我们不移动网页节点，暂不做；真机验收时留意。

- M2b 已知限制：
    - **已知限制**：WXT 内容脚本包装层仍会在 `document` 上派发带扩展 ID 的 CustomEvent，已知 ID 的网页可以借它确认扩展存在；`postMessage` 广播已关闭。带 `CSP: sandbox` 头的本地页面实测能正常加载按需模块并翻译，没有回归。

- 「仅看译文」遗留（#35 之后）：视口单位与媒体查询不跟随，接受为已知限制；em 边框/圆角归零等真实反馈再修（详见 `docs/reviews/2026-11-17-translation-only-followups.md`）。
- 产品名被直译（「Sonnet」译成「十四行诗」），属专有名词保护，留给 M4 术语库。

## 4. 观察项

        5. Google 备用接口吞掉 429：这是有意为之，不是缺陷，作为观察项。
      - **卡片「重试」不绕过缓存**：只在出错时出现，成功但内容坏的卡片没有入口，暂不做。
      - **「翻译服务返回了空结果」未能复现**（claude.dev，Google）：根因未知，推测与当时出口 IP 被 Google 限流降级有关；再遇到需要抓现场。
    - **已知待观察**：40 字以内的英文句子，Chrome 语言检测常报不可靠，卡片顶部显示「自动检测」，这是检测本身的限制。
  - 同一地址上的多个自定义服务共享限流冷却（有意为之）；如果用户反馈同一聚合平台上多个账号互相拖累，再改成按地址加密钥区分。

## 5. 后续规划项

  - **审查留下的结构建议（不阻塞）**：内容脚本的装配可抽成 `src/content/runtime.ts`，供 M3 划词共用 Port 与配置；`PageState` 与 `PageStatus` 可合并成一份；设置页预览引用了 `src/content/styles.ts`，样式常量可移到 `src/lib`；`site-memory.ts` 可拆读写两侧，给内容脚本减重。
      - **另一项 M3 后的改进**：AI 引擎的整页翻译改为逐段出现。模型还在生成一批时，后台边收边解析，某一段完整了就立即渲染；首屏第一批切小。用户已同意排在 M3a、音标之后。
      - **引擎供应商图标**（2026-11-17 用户确认效果图和方案）：已实现，见 `docs/plans/provider-icons.md`。设置页「添加服务」对话框里的预设单选项还没有图标，需要时再补。
          - Dependabot：TypeScript 7 已设为忽略（`@dependabot ignore this major version`）。以后单独升级时，需要修改 `src/entrypoints/options/providers.ts:37` 的 Uint8Array 类型。
  - M3 的输入翻译要兼容 Lexical、ProseMirror、Draft.js、Slate、Quill 等富文本编辑器；M5 的字幕以当前时间 ±10 秒为滚动窗口预取。

来自 M1 架构审查，留到对应批次再做（现在做属于过度设计）：
    - M2：视口优先由内容脚本控制提交顺序，调度器不加优先级。
    - M3：给 `scheduler.submit` 增加可选参数 `onDelta`，并在 `TranslateChunk` 中增加 delta 分支，用于划词流式。新增第三个调用方时，把 `service` 和 `admin` 里重复的「解析配置 → 适配器 → 提示词」抽成 `resolveJobContext()`。
    - M4：引入 `TranslateOptions`（temperature、style、glossary），统一计算 `paramsDigest`；`buildPrompt` 和 `ProviderContext` 都要接收这些参数。
    - 下次新增 provider 时：把 `resolveProviderSettings` 移出 registry，改为表驱动，并让 `SecretProviderId` 由 `Engine` 派生。

## 6. 仍待验证的假设

| --- | --- | --- |
| 内容脚本的 `<all_urls>` 能让后台跨域 fetch | M1 | 扩大 `host_permissions` |
| Translator / LanguageDetector API 在 Service Worker 中**不可用** | M3 前 | 本地引擎放到内容脚本或 offscreen document 执行，后台语言检测只用 `chrome.i18n.detectLanguage` |
| YouTube 的 `captionTracks` 能直接取到字幕 | M5 | 回退到 hook 网络请求，并给出失效诊断提示 |

（Translator / LanguageDetector 在 Service Worker 中的可用性：M3e 前验证；YouTube captionTracks：M5 验证。）
