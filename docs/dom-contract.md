# 页面 DOM 约定（对外）

整页翻译往网页里插入译文时留下的标记。网页导出工具（如把网页转成 Markdown 的扩展 Inkmark）读取的是页面 DOM 的克隆，拿不到 CSS 效果，只能靠这些标记还原页面上的显示。

**下表是对外约定**：第三方工具依赖这些标记，改名、改结构或改语义都属于不兼容变更，必须在 `CHANGELOG.md` 里单独标出「DOM 约定变更」。代码里设置这些标记的位置（`src/content/render.ts`、`src/content/styles.ts`）都有注释指向本文。锁定测试在 `src/content/render.test.ts` 的「DOM contract」一组。

`et` 是历史前缀，来自旧名 Easy Translate，长期稳定，不随产品名变化（2026-11-19 决定保留）。

## 约定的标记

| 标记 | 语义 |
|---|---|
| `et-tr` 元素 | 一段译文，插在所属原文旁边（块单元插在原文元素的末尾，行内片段插在片段最后一个节点之后）。子树就是译文内容，可能含从原文克隆来的行内元素（`<a>`、`<strong>`、`<code>` 等） |
| `et-tr` 没有 `data-et-inline` | 块级显示：译文另起一行，在所属原文下方 |
| `et-tr[data-et-inline]` | 不另起段落。有两种来源：行内片段（夹在其他内容中间的一段文字），译文紧跟在原文后面；flex 或 grid 容器里的单元，译文是容器里单独的一项。导出时按「空格 + 译文」处理即可 |
| `[data-et-only]`（加在原文元素上） | 只看译文：这个元素的**直接子节点**中，除 `et-tr` 以外的都不显示，包括直接文本节点和其他元素 |
| `et-tr[data-et-state]` | 非译文内容，属于插件界面，导出时整个删除。目前有 `data-et-state="error"`（翻译失败占位，文字随界面语言变化，如「未译出 · 重试」）、`data-et-state="loading"`（加载点，无文字，`aria-hidden`）与 `data-et-state="skipped"`（过长未翻译的段末提示，文字随界面语言变化，无按钮） |
| `et-tr` 上的 `lang` | 译文 `et-tr` 的 `lang` 是目标语言（目标语言代码，如 `zh-CN`）；带 `data-et-state` 的占位是插件界面，其 `lang` 为界面语言 |
| `et-isle`、`et-selection`、`et-palette` 元素，以及带 `data-et` 属性的元素 | 插件界面（灵岛、划词卡片、指令台），内容在 closed shadow DOM 里，克隆后是空元素，导出时可整个删除。`et-palette` 通常是 `<html>` 的直接子元素，网页有模态对话框（`showModal`）打开时会挂在该对话框里 |

**补充说明**：

- `data-et-only` 只加在块单元上，按元素逐个判断，不要推断整页处于什么模式。只看译文模式下，下面这些仍然是双语，原文元素上不会有 `data-et-only`：行内片段、flex 或 grid 容器里的单元、翻译失败的段落、过长未翻译的段落。
- **只有没有 `data-et-state` 的 `et-tr` 才是译文**。以后新增任何往 `et-tr` 里写非译文内容的状态（提示等；加载中已是 `loading`），都必须带上 `data-et-state="<状态名>"`。
- 失败占位的文字会随界面语言变化（i18n），不要按文字识别，只认 `data-et-state`。
- `et-tr` 带 `translate="no"`，避免浏览器自带翻译或其他翻译扩展再翻一遍。

## 不在约定里（可能随时改变，不要依赖）

- `data-et-s`（译文样式：`faded`、`underline`、`highlight` 等）、`data-et-host`（宿主是否深色）、`data-et-unclamp`（解除行数截断）。
- 只看译文时写到原文元素上的内联 `style`（把 margin、padding、宽高等钉成像素或百分比），以及 `et-tr` 上的 CSS 变量（`--et-fs`、`--et-lh`、`--et-ls`、`--et-ws`）和 `dir="auto"`。
- 注入的样式表内容、动画。
