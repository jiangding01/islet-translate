# 发版 v0.5.0 方案

> 状态：发版 PR #82；`v0.5.0` 标签在 PR 合并、main CI 全绿后，经用户确认再推送（第 2 步）。依据：发版节奏（主题批次收尾后发 0.x，M3c 收尾后发 v0.5.0，2026-11-24 用户说「开始发版」）；做法沿用 `docs/plans/release-v0.4.0.md`（发版工作流 `.github/workflows/release.yml` 已就绪，本次不改）。

## 现状（2026-11-24，main `95818e5`）
- `package.json` / `package-lock.json` 版本 `0.4.0`；已有 `v0.4.0` 标签与 GitHub Release。
- CHANGELOG `[未发布]` 含：
  - M3c 全部：PR1 #70、PR2 #71、补丁 #72、PR6 #74、PR3 #77、PR4 #78、PR5 #79；
  - Gemini 审查后的修复：思维链剥离 #75、渲染三项小修 #76；
  - 真机验收后的两个补丁：停靠切换 #80、设置页按入口开页 #81。
- 真机验收：M3c 六个 PR 已于 2026-11-24 全部通过，#80 修复了验收中发现的问题。未验证：Windows / Linux 上 `Alt+Shift+K` 与 accesskey 冲突。
- 版本号取 **0.5.0**。理由：新增用户可见功能（指令台、快速翻译、区域翻译与排除）和一个快捷键（manifest `commands` 新增 `open-palette`）；配置没有新增字段，也没有破坏性改动；仍保持 0.x。

## 第 1 步：发版 PR（分支 `chore/release-v0.5.0`）
1. **版本号**：`npm version 0.5.0 --no-git-tag-version`，只改 `package.json` 与 `package-lock.json` 的版本字段。
2. **CHANGELOG**：
   - `[未发布]` 改名为 `[0.5.0] - 2026-11-24`，其上新增空的 `[未发布]`；
   - `[0.5.0]` 最上方加「本版要点」，内容需用户确认；
   - 底部链接改为 `[未发布]: …/compare/v0.5.0...HEAD`，新增 `[0.5.0]: …/compare/v0.4.0...v0.5.0`。
3. **README 双语**：
   - 安装示例文件名改为 `Islet-Translate-v0.5.0-chrome.zip`；
   - 指令台一行补上区域翻译与排除（PR4、PR5 当时漏补）；
   - 体积表 palette-runtime 15 → 18 KB；
   - 路线图把 M3c 与 v0.5.0 标为已完成，下一步写体验债小批。
4. **HANDOFF**：写成发版后的终态（v0.5.0 已发布，下一步体验债小批）。
5. **本方案**补实施记录。

## 第 2 步：合并后打标签发版（每一步都需用户确认）
1. 确认 `main` 上发版 PR 合并提交的 CI 全绿。
2. **经用户确认后**：`git tag -a v0.5.0 -m "v0.5.0"`，`git push origin v0.5.0`。
3. 发版工作流跑完后读回 Release，核对三项：
   - 下载 zip，`manifest.json` 版本为 0.5.0；
   - SHA-256 与校验文件一致；
   - 发布说明即 `[0.5.0]` 一节。
4. 建议用户用下载的 zip 在 Chrome 里加载一次，按 `⌃⇧K` 打开指令台，并整页翻译一个页面。

## 不做
- 改发版工作流；上架应用商店。

## 验证
- `npm run check`；`npm run zip` 后，检查 zip 内 `manifest.json` 版本为 0.5.0。
- 本地用 bash 跑一遍工作流里的三项校验：
  - 标签与版本一致；
  - CHANGELOG 有 `## [0.5.0]`；
  - 能截取出发布说明。
- 用 check skill 的发版模式审查版本号与 CHANGELOG 是否一致。

## 风险与回滚
- 推送标签和创建 Release 都是公开操作。有误时可以删除 Release 与标签，修好后重发；删除前先问用户。发版 PR 可以 revert。

## 实施记录（2026-11-24）
- 版本号：`npm version 0.5.0 --no-git-tag-version`，`package.json` 与 `package-lock.json` 共改 3 处版本字段。
- CHANGELOG：`[未发布]` 归入 `[0.5.0] - 2026-11-24`，加 6 条本版要点，底部比较链接已更新。
- README 双语：
  - 安装示例改为 v0.5.0；
  - 指令台一行补上区域翻译与排除；
  - 体积表 palette-runtime 改为 18 KB；
  - 路线图把 M3c 与 v0.5.0 标为已完成。
- HANDOFF 按终态更新，下一步为体验债小批。
