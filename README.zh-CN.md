<div align="center">

<img src="public/icon/128.png" width="96" alt="译屿">

<h1>译屿</h1>

<p>Chrome 上的双语网页阅读：整页、划词、单词，安静地翻译。</p>

[![CI](https://github.com/jiangding01/islet-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangding01/islet-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-F5A524)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-F5A524)
![TypeScript](https://img.shields.io/badge/TypeScript-6-F5A524?logo=typescript&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-F5A524?logo=react&logoColor=white)
![WXT](https://img.shields.io/badge/built%20with-WXT-F5A524)
![Version](https://img.shields.io/badge/version-0.1.0-F5A524)

[English](README.md) · **简体中文**

[设计理念](#-设计理念) · [功能](#-功能) · [安装](#-安装) · [快捷键](#%EF%B8%8F-快捷键) · [引擎](#-引擎) · [开发](#-开发) · [路线图](#-路线图) · [文档](#-文档)

</div>

<br>

<table>
  <tr>
    <td width="50%"><img src="docs/assets/readme/zh-page-isle.png" width="100%" alt="双语整页翻译，右侧是控制条"><br><sub>双语整页翻译，右侧边缘是控制条</sub></td>
    <td width="50%"><img src="docs/assets/readme/zh-card.png" width="100%" alt="划词卡片，单词带英美音标"><br><sub>划词卡片，单个英文单词显示 UK / US 音标</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/readme/zh-options-general.png" width="100%" alt="设置页，通用"><br><sub>设置页「通用」：语言、外观与译文样式</sub></td>
    <td width="50%"><img src="docs/assets/readme/zh-options-services.png" width="100%" alt="设置页，翻译服务"><br><sub>设置页「翻译服务」：引擎、密钥与自定义服务</sub></td>
  </tr>
</table>

## 🌿 设计理念

- **人的感受第一。** 少打扰，近乎原生的沉浸式阅读。
- **默认不留痕迹。** 你不唤起翻译，页面上就什么都没有；不常驻悬浮球，也不用逐个网站去关。
- **网页还是网页本来的样子。** 译文沿用网页自己的字体、字号和颜色，版面不乱。
- **大页面也不卡。** 先翻眼前的段落，往下读时继续翻。
- **免费起步，自己掌控。** Google 翻译零配置可用；自带密钥时，内容发往哪里由你决定；遇到限流会自动放慢请求，持续限流时提示你换引擎。
- **动效克制。** 只有一个会生长的形状，由弹簧驱动；琥珀主题，亮暗两套。

## ✨ 功能

译屿当前版本为 `0.1.0`，已完成 M0 地基、M1 翻译核心、M2 整页翻译与控制条、M3a 划词翻译与音标，以及界面多语言。

| 功能 | 说明 | 示例 |
| --- | --- | --- |
| 整页双语翻译 | 译文出现在原文下方，沿用网页自己的字体。先翻眼前的段落，往下读时继续。<br>可以切换「双语 / 仅译文」，重试没译出的段落，或点「显示原文」还原网页。<br>打开「总是翻译此站」后，每次访问该站都自动翻译。链接等行内格式在译文里保留。<br>用 AI 引擎时，模型每写完一段就先显示这一段；如果一批译文校验出错位，已显示的段会自动撤下重译。段落等待译文超过约 0.6 秒时，段末会显示一个小圆点。文本输入框和 `translate="no"` 区域不会被翻译，之后动态新增的内容也一样。<br>过长（超过 5000 字符）无法翻译的段落会在原处标出，面板显示段数。 | <img src="docs/assets/readme/zh-page-isle.png" width="240" alt="英文文章译成中文"> |
| 控制条（灵岛） | 翻译时，一个小条贴在网页边缘。<br>可以切换显示方式、重试没译出的段落，并只为本页更换引擎；末尾的 ⌘ 按钮打开指令台。<br>可停靠在右侧、左侧或底部。 | <img src="docs/assets/readme/zh-isle.png" width="240" alt="停靠在右侧的控制条"> |
| 单段翻译 | 不必翻译整页：指针停在段落上，按住 Ctrl（macOS 为 ⌃）约 0.6 秒，只翻译这一段，再按住还原；可在设置中改为 Alt（macOS 为 ⌥ Option）或关闭。<br>此时灵岛不出现，面板仍显示「翻译此页」；之后再开整页翻译，已译的段会沿用。<br>整页翻译进行中，同样的手势可以还原已译的段并不再翻译它，或立即翻译还没轮到的段。 | <sub>示例图待补充</sub> |
| 划词卡片与音标 | 选中外文，选区末尾出现琥珀小点；点击或停留片刻，翻译卡片就长出来。右键菜单和快捷键同样可用。<br>AI 引擎的译文边生成边显示。卡片可以换引擎、折叠原文、复制译文、朗读原文，也可以固定并拖动。<br>选中单个英文单词时显示 **UK** / **US** 音标，来自离线词表（约 17.5 万 / 11.7 万词），点击按对应口音朗读。 | <img src="docs/assets/readme/zh-card.png" width="240" alt="划词卡片，单词带英美音标"> |
| 指令台 | 在任何网页上按 `⌃⇧K`（Windows / Linux 为 `Alt+Shift+K`），焦点在输入框里也行，或点灵岛上的 ⌘ 按钮，弹出一个指令输入框（灵岛在页面上时贴着它展开）：翻译此页、显示原文、切换双语 / 只看译文、重试失败的段落、为本页选择翻译服务、打开设置；翻译此页 / 显示原文的行尾显示当前生效的快捷键。输入即过滤，↑↓ 选择、Enter 执行、Esc 返回。<br>输入其他文字后按 Enter 即可就地翻译：译文流式显示在列表上方，输入已经是目标语言时反过来翻译：译成英文，目标语言本身是英文时译成浏览器界面语言；按 ↓ 再按 Enter 复制译文，以 `/` 开头则只搜索指令。<br>「选择要翻译的区域」只翻译框住的一块（↑ 扩大、↓ 缩小、Enter 确认、Esc 取消）；整页翻译时「选择不翻译的区域」把侧栏、评论区等排除在外。<br>在指令台里打的字不会触发网页自己的快捷键；关闭后焦点和选区原样还给网页。 | <sub>示例图待补充</sub> |
| 仅译文 | 隐藏原文，只显示译文，同时保持网页版面。随时切回双语，页面会原样恢复。 | <img src="docs/assets/readme/zh-only.png" width="240" alt="仅译文模式下的网页"> |
| 工具栏面板 | 显示当前网站和页面语言，切换目标语言和默认引擎。<br>母语页面、浏览器页面、需要刷新的页面各有安静的提示。页面已声明为你的语言时，仍保留「仍然翻译」和目标语言选择。 | <sub>示例图待补充</sub> |
| 设置页 · 通用 | 目标语言、源语言、外观、带预览的译文样式、打开时显示、灵岛位置和划词小点。 | <img src="docs/assets/readme/zh-options-general.png" width="240" alt="设置页通用页"> |
| 设置页 · 翻译服务 | 默认引擎、密钥与模型、最多 10 个自定义 OpenAI 兼容服务（含本地模型）、测试连接，以及翻译缓存。 | <img src="docs/assets/readme/zh-options-services.png" width="240" alt="设置页翻译服务页"> |
| 设置页 · 翻译风格 | 用 AI 引擎翻译时可选的风格：通用、技术文档、学术论文、口语化、文学意译，也可以添加最多 10 个自己写的风格（名称 + 风格说明）。全局一个默认风格，选「通用」时提示词与以前相同、已有缓存继续可用；换风格后同一段落按新风格重新翻译。Google 翻译不受影响。 | <sub>示例图待补充</sub> |
| 界面语言 | 跟随浏览器语言：English、简体中文和繁体中文，默认英文。中文按简体或繁体分别用对应的字形显示。 | <sub>示例图待补充</sub> |
| 隐私与密钥 | 密钥只保存在本机，页面只能看到末 4 位。<br>没有账户，也没有统计或追踪代码。网页文字只会发给你选择的翻译引擎。<br>译文缓存保存在本机，超过 7 天的条目每天清理。 | |

<!-- 示例图：后续可在「示例」列补充截图或 GIF，放在 docs/assets/readme/ -->

## 🚀 安装

译屿尚未上架商店，有三种安装方式。

**从 GitHub Release 下载**

1. 打开 [Releases](https://github.com/jiangding01/islet-translate/releases) 页面，在最新版本里下载 `Islet-Translate-v<版本号>-chrome.zip`（例如 `Islet-Translate-v0.6.0-chrome.zip`）。
2. 解压后打开 `chrome://extensions`，启用「开发者模式」，点击「加载已解压的扩展程序」，选择解压出的文件夹。
3. 可选：每个版本还附带一个 `.sha256` 文件。在 zip 所在目录运行 `sha256sum -c Islet-Translate-v<版本号>-chrome.zip.sha256`（macOS 用 `shasum -a 256 -c`）即可校验下载。

**从 CI 构建产物安装**

1. 在 GitHub 打开一个 PR，进入 **Checks**，点开这次 CI 运行，来到 **Summary** 页。
2. 在 **Artifacts** 里下载 `islet-translate-chrome-<提交号>`，产物保留 7 天。
3. 解压后打开 `chrome://extensions`，启用「开发者模式」，点击「加载已解压的扩展程序」。

**从源码构建**

```sh
nvm use
npm ci
npm run build
```

然后在 `chrome://extensions` 里「加载已解压的扩展程序」，选择 `.output/chrome-mv3`。

安装或重新加载扩展后，请刷新已有的网页。Chrome 不允许扩展在浏览器内部页面、网上应用店和内置 PDF 阅读器中运行。

## ⌨️ 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 翻译此页 / 显示原文 | `⌃⇧A` | `Alt+A` |
| 翻译选中文字 | `⌃⇧S` | `Alt+Shift+S` |
| 打开指令台 | `⌃⇧K` | `Alt+Shift+K` |

可以在 `chrome://extensions/shortcuts` 修改。

## 🔌 引擎

| 引擎 | 配置 |
| --- | --- |
| Google 翻译 | 免费，零配置，默认引擎 |
| OpenAI | 自带 API 密钥 |
| DeepSeek | 自带 API 密钥；翻译默认关闭思考模式（更快、更省），可在设置里打开 |
| Gemini | 自带 API 密钥，并填写模型 |
| 自定义 | 任意 OpenAI 兼容接口，预设 Ollama、LM Studio、OpenRouter、硅基流动 |

添加自定义服务时，浏览器会请求访问该地址。最多可添加 10 个。

<details>
<summary>用 Ollama 接入本地模型</summary>

1. 在设置页「翻译服务」点「添加服务」，选「Ollama（本地）」，在「模型」里填 `ollama list` 显示的模型名（例如 `qwen2.5:7b`），点「添加」，并在浏览器的授权提示里选「允许」。
2. Ollama 默认拒绝来自浏览器扩展的请求，测试连接会提示「本地服务拒绝了扩展的请求。如果是 Ollama，需要把环境变量 OLLAMA_ORIGINS 设为 chrome-extension://*，再彻底退出并重新打开 Ollama。」在终端运行下面的命令，然后**从菜单栏彻底退出 Ollama 再重新打开**（只关窗口不会重启后台服务）：

   ```bash
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ```

   用 `ollama serve` 启动的，改成 `OLLAMA_ORIGINS="chrome-extension://*" ollama serve`。可用 `ps -o lstart,command -p $(pgrep -f "ollama serve")` 确认服务确实是刚启动的。
3. 不需要打开 Ollama 设置里的「Expose Ollama to the network」：扩展访问的是本机地址，打开它只会把服务暴露给局域网。
4. 模型第一次加载较慢，可能超时，等加载完再测一次即可。翻译用不到很长的上下文，把 Ollama 设置里的 Context length 调到 8k 到 16k 能明显加快加载和响应；整页翻译更适合 7B 到 8B 的模型。

</details>

## 🛠 开发

需要 Node.js 22.12 或更新版本（`.nvmrc` 指定 24）、npm（`.npmrc` 固定使用官方源），以及启用了开发者模式的 Chrome。

```sh
nvm use
npm ci          # postinstall 会执行 `wxt prepare`
npm run dev
```

打开 `chrome://extensions`，启用「开发者模式」，点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3-dev`。WXT 会监听源码并更新开发产物。修改 manifest 或后台逻辑后，在扩展管理页重新加载扩展，并刷新用于调试的网页。

### npm 脚本

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Chrome 扩展开发构建，随改随更新 |
| `npm run build` | 在 `.output/chrome-mv3` 生成生产产物 |
| `npm run zip` | 在 `.output` 中生成扩展 ZIP 包 |
| `npm run typecheck` | 先 `wxt prepare` 生成类型（含界面文案键），再执行 TypeScript 严格检查 |
| `npm run lint` | Biome 只读检查（格式与 lint），即 `biome ci .` |
| `npm run format` | Biome 自动格式化并应用安全修复 |
| `npm test` | 运行 Vitest 单元测试 |
| `npm run test:watch` | Vitest 监听模式 |
| `npm run test:e2e` | 在真实的 Chrome for Testing 中跑冒烟 e2e。需要先 `npm run build`；浏览器按 `CHROME` 环境变量、再按 Playwright 缓存里最新的版本查找（见 `scripts/lib/find-chrome.mjs`）。不属于 `npm run check` |
| `npm run check:build` | 校验 manifest 及其引用的入口资源，以及 `_locales` 与 manifest 中的 `__MSG_*__` 文案 |
| `npm run check:size` | 按入口检查 gzip 体积预算（见下表） |
| `npm run check:contrast` | 校验颜色 token 的对比度：文字 ≥ 4.5:1，控件与焦点环 ≥ 3:1，亮暗各一套 |
| `npm run check:i18n` | 各语言文件的键与占位符一致；源码不允许出现中文硬编码，界面文案只写在 `src/locales/*.yml`，豁免用 `i18n-ignore` 注释。基线已清零 |
| `npm run build:icons` | 重新生成 `public/icon` 与 `docs/assets/icon` 中的扩展图标 |
| `npm run check` | 依次执行 lint、typecheck、check:i18n、check:contrast、test、build、check:build、check:size |

### 体积预算

`npm run check:size` 按入口检查 gzip 体积。音标词表另有预算：每片 40 KB，每种口音合计 2 MB。

| 入口 | 上限 |
| --- | --- |
| content | 7.75 KB |
| page-runtime | 28 KB |
| selection-runtime | 19 KB |
| palette-runtime | 18 KB |
| background | 60 KB |
| popup | 90 KB |
| options | 150 KB |

### 持续集成

<details>
<summary>CI 做了什么</summary>

`.github/workflows/ci.yml` 在 PR 和推送到 `main` 时运行：

- 与 `npm run check` 相同的一套检查。
- 用 `scripts/check-audit.mjs` 审计运行时依赖：有高危漏洞时拦截；若公告在 `scripts/audit-allowlist.json` 中按 ID 登记，并写明理由和到期日，则可限期豁免。
- 全量依赖审计只报告不拦截，因为修复往往要等上游。
- PR 的依赖审查（dependency review）：新增或升级的依赖有高危漏洞时拦截。
- 校验已安装依赖包的仓库签名。
- CodeQL 安全扫描，使用 `security-extended` 规则集（`.github/workflows/codeql.yml`），在 PR、推送到 `main` 时运行，每周也会运行一次。
- 把通过检查的构建产物作为 artifact 上传，保留 7 天。
- `e2e` job：用 Chrome for Testing 对这份构建产物跑冒烟 e2e（`npm run test:e2e`）。用例覆盖整页翻译、显示模式、重试、缓存、划词、设置页、面板、403 引擎错误、加载圆点、扩展重载、重启与布局。靠重试才通过的用例会在运行页留下警告注解；失败或重试过的用例上传 `test-results/e2e/`。暂不阻断合并，等不靠重试稳定全绿后再设为必过。

依赖更新由 Dependabot（`.github/dependabot.yml`）每周检查 npm 和 GitHub Actions，小版本与补丁更新分组提 PR。

</details>

<details>
<summary>本地验收清单</summary>

先跑 `npm run test:e2e`，自动化覆盖的项目见 [`docs/plans/e2e-smoke.md`](docs/plans/e2e-smoke.md)。

1. 加载扩展，打开设置页的「翻译服务」，默认引擎为 Google，点「测试连接」应显示译文和延迟。
2. 为 OpenAI、DeepSeek 或 Gemini 填写自己的密钥（Gemini 还要填写模型），测试连接成功；填错密钥时提示「密钥无效」类错误。
3. 点「添加服务」，选一个预设（例如 Ollama），填写模型后添加：浏览器弹出授权请求；允许后新服务出现在「自定义」分组并自动测试一次；拒绝时标为「待授权」，可在详情里重新授权。
4. 删除一个设为默认的自定义服务，默认引擎自动改回 Google。
5. 在「通用」页用下拉切换目标语言和源语言，用键盘（方向键、回车、Esc、首字母）操作下拉；切换外观为深色。
6. 在普通网页打开工具栏面板，确认显示网站和页面语言，能切换目标语言和默认引擎；在中文页面、`chrome://extensions` 和安装前已打开的网页上，分别显示对应提示；中文页面上的「仍然翻译」仍可开始翻译。
7. 清空翻译缓存后，条数归零。
8. 在 `chrome://serviceworker-internals` 停止 Service Worker 后再修改设置或测试连接，确认仍能正常工作。
9. 整页翻译的完整验收清单（含 4 倍 CPU 降速下的动效检查）见 [`docs/plans/m2-page-translation.md`](docs/plans/m2-page-translation.md) 第 10 节。
10. 「仅译文」的版面：运行 `python3 -m http.server 8765 --directory tests/fixtures`，打开 `http://localhost:8765/translation-only-layout.html`（内容脚本只在 http/https 页面运行，不能直接打开文件），翻译整页、切到仅译文、拖动窗口宽度，按每个用例下方的灰色说明核对，再切回双语确认原样恢复。
11. 超长段落提示：运行 `python3 -m http.server 8765 --directory tests/fixtures`，打开 `http://localhost:8765/too-long-paragraph.html`，翻译整页，确认超过 5000 字符的段落段末显示提示，面板显示的总数为 6。
12. 界面语言：把 Chrome 语言改为英文并重启，再到 `chrome://extensions` 重新加载扩展，界面应为英文。再改为繁体中文（台湾）重复一次，界面应显示「譯嶼」，中文使用繁体字形。

</details>

<details>
<summary>README 截图</summary>

`scripts/screenshots/shoot.mjs` 把构建产物加载进无头 Chrome for Testing，打开演示文章并驱动扩展，输出 2 倍图到 `docs/assets/readme`。两份 README 各用自己的界面语言，并从另一种语言翻译过来：英文 README 是中文文章译成英文，中文 README 反过来。

```bash
npm run build
node scripts/screenshots/shoot.mjs --ui en --article zh --target en --word 每一次打断都有代价。
node scripts/screenshots/shoot.mjs --ui zh_CN --article en
```

浏览器默认用最新的 Playwright Chrome for Testing，也可以用 `CHROME` 指定路径。译文来自在线的 Google 引擎，每次结果可能不同，提交前逐张看一遍。

</details>

### 开发约定

- 密钥不进源码与日志，也不进版本库。
- 界面文案只写在 `src/locales`，由 `check:i18n` 把关。
- 新功能要覆盖失败、取消与清理路径。

## 📁 项目结构

```text
.
├── .github/
│   ├── workflows/               # CI（ci.yml）与 CodeQL（codeql.yml）
│   ├── codeql/                  # CodeQL 配置
│   └── dependabot.yml           # 每周依赖更新
├── docs/
│   ├── assets/                  # 图标 SVG 源文件与 README 截图
│   ├── design/                  # 早期设计文档（功能参考）
│   ├── plans/                   # 各批次技术方案
│   ├── reviews/                 # 最终方案、UI/UX 规范与评审记录
│   └── dom-contract.md          # 扩展留在网页里的标记，供第三方工具读取
├── public/
│   ├── icon/                    # 扩展图标
│   └── dict/                    # 音标分片（gb/、us/）、来源与许可文件
├── scripts/
│   ├── audit-allowlist.json     # 运行时依赖审计的限期豁免清单
│   ├── build-icons.mjs          # 生成扩展图标
│   ├── build-phonetics.mjs      # 从 ECDICT 与 ipa-dict 生成音标分片（手动运行）
│   ├── check-audit.mjs          # 运行时依赖审计，拦截高危公告
│   ├── check-build.mjs          # 校验构建产物中的 manifest、入口资源与语言文件
│   ├── check-contrast.mjs       # 颜色 token 对比度校验
│   ├── check-i18n.mjs           # 语言文件一致性，以及源码不得有中文硬编码
│   ├── check-size.mjs           # 按入口检查 gzip 体积预算
│   ├── i18n-baseline.json       # 尚未迁移的硬编码文案基线（现已清零）
│   ├── i18n-messages.mjs        # 读取语言文件并模拟 Chrome 的 getMessage（与单测共用）
│   └── screenshots/             # README 截图：shoot.mjs 与两篇演示文章（手动运行）
├── src/
│   ├── entrypoints/
│   │   ├── background.ts        # 后台 Service Worker：配置唯一写入点、翻译服务、消息 handler
│   │   ├── content.ts           # 内容脚本（首屏引导，约 7KB）
│   │   ├── page-runtime.ts      # 按需模块：装配整页翻译会话
│   │   ├── selection-runtime.ts # 按需模块：首次划词时加载，装配划词卡片
│   │   ├── palette-runtime.ts   # 按需模块：按指令台快捷键或灵岛 ⌘ 时加载，装配指令台
│   │   ├── popup/               # 工具栏面板
│   │   └── options/             # 设置页：通用、翻译服务、添加服务对话框、连接测试
│   ├── content/                 # 网页侧
│   │   ├── anchor.ts            # 插入译文时保持阅读位置不动
│   │   ├── auto-start.ts        # 在「总是翻译」的站点自动开始翻译
│   │   ├── bootstrap.ts         # 首屏引导：收消息、按需加载
│   │   ├── discover.ts          # 发现可翻译的块
│   │   ├── dom-rules.ts         # 哪些元素跳过、哪些视为块
│   │   ├── error-text.ts        # 网页侧把错误码转成文案
│   │   ├── i18n.ts              # 类型化的 getMessage 封装，含复数选择
│   │   ├── loader.ts            # 通过动态 URL 加载按需模块
│   │   ├── mutations.ts         # 监听动态内容
│   │   ├── page-state.ts        # 控制条与指令台共用的会话状态判断
│   │   ├── render.ts            # 插入与还原译文、失败重试与过长占位
│   │   ├── runtime-contract.ts  # 加载器与按需模块之间的接口
│   │   ├── segment.ts           # 把块切成段并保留行内格式
│   │   ├── session.ts           # 翻译会话：视口队列、重试、显示方式
│   │   ├── styles.ts            # 译文样式
│   │   ├── svg-icon.ts          # 卡片与控制条共用的引擎图标绘制
│   │   ├── text.ts              # 文本工具
│   │   ├── viewport.ts          # 视口可见性与优先级
│   │   ├── isle/                # 控制条（灵岛）：弹簧、外形几何、悬停意图、探测、Shadow DOM 宿主
│   │   ├── palette/             # 指令台：指令注册表、按键、焦点交还、定位、Shadow DOM 宿主
│   │   └── selection/           # 划词：选区观察、文字提取、卡片、定位、请求、朗读
│   ├── components/              # 共享界面组件：Select 下拉、ProviderIcon
│   ├── lib/
│   │   ├── action-icon.ts       # 工具栏图标的状态小点
│   │   ├── context-menu.ts      # 右键菜单入口
│   │   ├── endpoint.ts          # 接口地址规整与主机权限判断
│   │   ├── engine-view.ts       # 引擎列表与就绪判断（设置页和面板共用）
│   │   ├── error-messages.ts    # 错误码到文案键
│   │   ├── errors.ts            # AppError 与 Result
│   │   ├── host-permission.ts   # 页面侧的可选主机权限 hook
│   │   ├── languages.ts         # 支持的语言与语言标签归一化
│   │   ├── provider-icons.ts    # 供应商图标的路径数据（lobe-icons，MIT）
│   │   ├── site-memory.ts       # 「总是翻译此站」的存储格式
│   │   ├── ui-locale.ts         # 界面文案的实际语言与 <html lang>
│   │   ├── config/              # schema、宽松解析、仓库、客户端与 useConfig
│   │   ├── messaging/           # 类型化消息、handle/call、Port 传输层、发送方校验
│   │   ├── phonetic/            # 英文音标：写法转换、分片查找、变形推导
│   │   └── translate/           # 翻译核心（只在后台使用）：provider、调度器、缓存、密钥
│   ├── locales/                 # en.yml（默认）、zh_CN.yml 与 zh_TW.yml，构建时生成 _locales 与类型
│   └── styles/                  # 设计 token、基础样式、主题切换
├── scripts/
│   └── lib/                     # 脚本共用工具，如 find-chrome.mjs
├── tests/
│   ├── e2e/                     # 冒烟 e2e（真实 Chrome，翻译请求用 mock）
│   └── fixtures/                # 测试页：translation-only-layout.html 与 too-long-paragraph.html（手动）、e2e-article.html 与 e2e-native.html（e2e）
├── .npmrc                       # 固定使用 npm 官方源
├── .nvmrc                       # Node.js 版本（24）
├── biome.json                   # Biome 配置
├── package.json                 # 脚本与依赖
├── tsconfig.json                # TypeScript 配置（继承 WXT 生成的配置）
├── vitest.config.ts             # Vitest 配置
├── vitest.e2e.config.ts         # e2e 的 Vitest 配置
├── vitest.setup.ts              # 测试初始化：模拟浏览器，并为 getMessage 加载语言文件
├── wxt.config.ts                # WXT 与 Manifest V3 配置
├── CHANGELOG.md                 # 更新日志
├── DESIGN.md                    # 早期设计稿，已由 UI/UX 设计规范取代
├── HANDOFF.md                   # 当前进度与已拍板决策
├── README.md                    # 英文 README
├── README.zh-CN.md              # 本文件
├── SECURITY.md                  # 安全策略
├── THIRD_PARTY_NOTICES.md       # 第三方许可
└── LICENSE                      # MIT
```

单元测试与源码同目录放置，命名为 `*.test.ts`。

## 🗺 路线图

| 状态 | 里程碑 |
| --- | --- |
| ✅ 已完成 | M0 地基 |
| ✅ 已完成 | M1 翻译核心 |
| ✅ 已完成 | M2 整页翻译与控制条 |
| ✅ 已完成 | M3a 划词翻译与音标 |
| ✅ 已完成 | 界面多语言（en / zh_CN / zh_TW） |
| ✅ 已完成 | 双语 README |
| ✅ 已完成 | 改名「译屿 / Islet Translate」 |
| ✅ 已完成 | 冒烟 e2e（PR1、PR2 与扩展重载用例均已合并） |
| ✅ 已完成 | v0.2.0（GitHub Release） |
| ✅ 已完成 | M3d 动态页与站点规则 |
| ✅ 已完成 | v0.3.0（GitHub Release） |
| ✅ 已完成 | M3b 段落级交互 |
| ✅ 已完成 | v0.4.0（GitHub Release） |
| ✅ 已完成 | M3c 指令台与控制条键盘操作 |
| ✅ 已完成 | v0.5.0（GitHub Release） |
| ✅ 已完成 | 体验债小批：AI 批量翻译逐段显示与撤回重译 |
| ✅ 已完成 | v0.6.0（GitHub Release） |
| ✅ 已完成 | M4-B 翻译风格（5 个预设与自定义风格） |
| 下一步 | M4 其余子批次：术语库、输入翻译、卡片多引擎对比 |
| 之后 | M3e Chrome 内置本地引擎（延后到 M4 之后） |
| 之后 | M5 YouTube 字幕、文章精翻、生词本、双语导出 |
| 之后 | M6 TikTok 与字幕文件 |
| 之后 | M7 可选打磨 |
| 之后 | M8 账户（待定） |

## 📚 文档

| 文档 | 内容 |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | 当前进度、已拍板决策和下一步，**接手开发先读这里** |
| [最终技术方案](docs/reviews/2026-11-13-final-plan.md) | 权威架构、选型和 M0 至 M8 交付批次 |
| [UI/UX 设计规范](docs/reviews/2026-11-13-ui-ux-design.md) | 权威视觉、交互和性能预算 |
| [CHANGELOG.md](CHANGELOG.md) | 更新日志 |
| [docs/README.md](docs/README.md) | 按功能查阅设计文档 |
| [M0 地基方案](docs/plans/m0-foundation.md) | 质量门禁、配置、消息、Port 与设计 token |
| [M1 翻译核心方案](docs/plans/m1-translation-core.md) | provider、调度、缓存、密钥、权限与设置页 |
| [界面方向：隐中生岛](docs/plans/ui-isle-direction.md) | 已确认的界面方向、动效规范与琥珀主题 token |
| [M2 整页翻译方案](docs/plans/m2-page-translation.md) | 扫描分段、视口队列、渲染与验收清单 |
| [M2b 按需加载与灵岛](docs/plans/m2b-lazy-runtime-and-isle.md) | 首屏瘦身、按需模块与灵岛 |
| [M3a 划词翻译方案](docs/plans/m3a-selection.md) | 小点与卡片、流式、选区一致性 |
| [引擎供应商图标](docs/plans/provider-icons.md) | 图标数据、下发方式与体积 |
| [英文单词音标](docs/plans/phonetics-en.md) | 数据来源、写法转换、分片、朗读卡死修复 |
| [界面多语言](docs/plans/i18n.md) | 语言文件、规则与校验脚本 |
| [页面 DOM 约定（对外）](docs/dom-contract.md) | 译文插进网页后留下的标记，供网页导出等第三方工具读取；修改属于不兼容变更 |
| [Codex 复核核实](docs/reviews/2026-11-17-core-findings-verification.md) | 核心实现问题的核实结论与修复排期 |

## 🔒 隐私与安全

密钥只保存在本机，不导出也不同步。译文缓存同样只在本机，超过 7 天的条目每天清理。发现安全问题时，请不要公开提 issue，在仓库 Security 页点「Report a vulnerability」私下报告，详见 [SECURITY.md](SECURITY.md)。

## 📄 许可

译屿以 [MIT 许可证](LICENSE) 开源。

扩展中包含以下第三方资源，各自沿用原许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，扩展包里另有一份 `THIRD_PARTY_NOTICES.txt`：

- 供应商图标：[lobe-icons](https://github.com/lobehub/lobe-icons)（MIT）
- 面板设置齿轮：[Tabler Icons](https://github.com/tabler/tabler-icons)（MIT）
- 英音音标：[ECDICT](https://github.com/skywind3000/ECDICT)（MIT）
- 美音音标：[ipa-dict](https://github.com/open-dict-data/ipa-dict)（MIT），基于 [cmudict-ipa](https://github.com/lingz/cmudict-ipa)（MIT）和 [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict)（BSD 类许可）
