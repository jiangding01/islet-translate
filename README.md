<div align="center">

<img src="public/icon/128.png" width="96" alt="Islet Translate">

<h1>Islet Translate</h1>

<p>Bilingual web reading for Chrome: translate whole pages, selections and single words, quietly.</p>

[![CI](https://github.com/jiangding01/islet-translate/actions/workflows/ci.yml/badge.svg)](https://github.com/jiangding01/islet-translate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-F5A524)](LICENSE)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-F5A524)
![TypeScript](https://img.shields.io/badge/TypeScript-6-F5A524?logo=typescript&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-F5A524?logo=react&logoColor=white)
![WXT](https://img.shields.io/badge/built%20with-WXT-F5A524)
![Version](https://img.shields.io/badge/version-0.1.0-F5A524)

**English** · [简体中文](README.zh-CN.md)

[Design](#-design-philosophy) · [Features](#-features) · [Install](#-install) · [Shortcuts](#%EF%B8%8F-shortcuts) · [Engines](#-engines) · [Development](#-development) · [Roadmap](#-roadmap) · [Docs](#-docs)

</div>

<br>

<table>
  <tr>
    <td width="50%"><img src="docs/assets/readme/en-page-isle.png" width="100%" alt="A Chinese article translated into English, with the control bar on the right edge"><br><sub>Bilingual page translation with the control bar on the right edge</sub></td>
    <td width="50%"><img src="docs/assets/readme/en-card.png" width="100%" alt="The selection card translating a Chinese sentence into English"><br><sub>Selection card: select text and read the translation right there</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/assets/readme/en-options-general.png" width="100%" alt="Settings, General page"><br><sub>Settings, General: languages, appearance and translation style</sub></td>
    <td width="50%"><img src="docs/assets/readme/en-options-services.png" width="100%" alt="Settings, Translation services page"><br><sub>Settings, Translation services: engines, keys and custom services</sub></td>
  </tr>
</table>

## 🌿 Design philosophy

- **People first.** As few interruptions as possible, so reading feels as natural as on the page itself.
- **No trace by default.** Nothing sits on a page until you ask for translation. There is no always-on floating ball, and nothing to switch off site by site.
- **Pages stay themselves.** Translations keep the page's own font, size and color, so the layout stays tidy.
- **Fast on big pages.** The paragraphs on screen are translated first, and the rest follows as you scroll.
- **Free to start, in your control.** Google Translate works with no setup. With your own keys you decide what is sent where, and when a service rate limits you, requests slow down on their own and you are told when to switch engines.
- **Restrained motion.** One shape that grows with spring motion, in an amber theme with light and dark variants.

## ✨ Features

Islet Translate is at version `0.1.0`. M0 (foundation), M1 (translation core), M2 (page translation and control bar) and M3a (selection translation and phonetics) are done, along with a localized interface.

| Feature | What it does | Preview |
| --- | --- | --- |
| Whole-page translation | Translations appear below the original text and keep the page's own font. The visible paragraphs are translated first, and the rest follows as you read down.<br>Switch between **Bilingual** and **Translation only**, retry paragraphs that were not translated, or choose **Show original** to restore the page.<br>Turn on **Always translate this site** to translate a site on every visit. Inline formatting such as links is kept.<br>A paragraph that waits more than about 0.6 seconds for its translation shows a small dot at its end. Text fields and `translate="no"` areas are never translated, including content added later.<br>A paragraph that is too long to translate (over 5000 characters) is marked in place, and the panel shows how many. | <img src="docs/assets/readme/en-page-isle.png" width="240" alt="A Chinese article translated into English"> |
| Control bar | While a page is being translated, a small bar docks to the edge of the page.<br>It switches the display mode, retries paragraphs that were not translated, and changes the engine for this page only; the ⌘ button at its end opens the command palette.<br>It can dock on the right, on the left or at the bottom. | <img src="docs/assets/readme/en-isle.png" width="240" alt="The control bar docked on the right"> |
| Translate one paragraph | You do not need to translate the whole page. Rest the pointer on a paragraph and hold Ctrl (⌃ on macOS) for about 0.6 seconds to translate just that paragraph. Hold again to restore it. In Settings you can switch the key to Alt (⌥ Option on macOS) or turn the gesture off.<br>The control bar stays hidden and the panel still offers **Translate this page**. Starting a whole-page translation later keeps the paragraphs you already translated.<br>During a whole-page translation the same gesture restores a translated paragraph and excludes it, or translates one that has not been reached yet. | <sub>Coming soon</sub> |
| Selection card and phonetics | Select foreign text and an amber dot appears at the end of the selection. Click it, or pause on it, and the card opens. The right-click menu and a keyboard shortcut work too.<br>AI engines stream the translation as it is written. The card can switch engine, collapse the original, copy the translation, read the text aloud, and be pinned and dragged.<br>A single English word shows **UK** and **US** phonetics from offline word lists (about 175,000 and 117,000 words). Click one to hear it in that accent. | <img src="docs/assets/readme/en-card.png" width="240" alt="The selection card"> |
| Command palette | Press `⌃⇧K` (`Alt+Shift+K` on Windows / Linux) on any page, even inside a text field, or click ⌘ on the control bar, to open a small command box (beside the control bar when it shows): translate the page, show the original, switch between Bilingual and Translation only, retry failed paragraphs, pick the engine for this page, or open Settings; the translate and show-original rows show the shortcut currently in effect. Type to filter, use ↑↓ and Enter, Esc to go back.<br>What you type there never triggers the page's own shortcuts, and closing it gives the focus and the selection back to the page. | <sub>Coming soon</sub> |
| Translation only | Hides the original and shows only the translation, while keeping the page layout. Switch back to Bilingual at any time to restore the page exactly. | <img src="docs/assets/readme/en-only.png" width="240" alt="A page in Translation only mode"> |
| Toolbar panel | Shows the current site and page language, and switches the target language and default engine.<br>Quiet hints for pages already in your language, browser pages, and pages that need a reload. On a page that already declares your language, **Translate anyway** and the target language stay available. | <sub>Coming soon</sub> |
| Settings: General | Target and source language, appearance, translation style with a live preview, how a page is shown when translation starts, control bar position, and the selection dot. | <img src="docs/assets/readme/en-options-general.png" width="240" alt="Settings, General page"> |
| Settings: Translation services | Default engine, keys and models, up to 10 custom OpenAI-compatible services (local models included), **Test connection**, and the translation cache. | <img src="docs/assets/readme/en-options-services.png" width="240" alt="Settings, Translation services page"> |
| Interface language | Follows the browser language: English, Simplified Chinese and Traditional Chinese, with English as the default. Chinese text uses the right Simplified or Traditional font forms. | <sub>Coming soon</sub> |
| Privacy and keys | API keys stay on your computer, and pages only ever see the last 4 characters of a key.<br>There are no accounts and no analytics or tracking code. Page text is sent only to the translation engine you choose.<br>Translations are cached on your computer, and entries older than 7 days are removed every day. | |

<!-- Preview images: add screenshots or GIFs to the Preview column and keep them in docs/assets/readme/. -->

## 🚀 Install

Islet Translate is not in a web store yet. There are three ways to install it.

**From a GitHub Release**

1. Open the [Releases](https://github.com/jiangding01/islet-translate/releases) page and download `Islet-Translate-v<version>-chrome.zip` (for example `Islet-Translate-v0.4.0-chrome.zip`) from the latest release.
2. Unzip it, open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**, then select the unzipped folder.
3. Optional: each release also has a `.sha256` file. Run `sha256sum -c Islet-Translate-v<version>-chrome.zip.sha256` next to the zip (on macOS, `shasum -a 256 -c`) to check the download.

**From a CI build**

1. Open a pull request on GitHub, go to **Checks**, open the CI run, and scroll to **Summary**.
2. Under **Artifacts**, download `islet-translate-chrome-<sha>`. Artifacts are kept for 7 days.
3. Unzip it, open `chrome://extensions`, turn on Developer mode, and choose **Load unpacked**.

**From source**

```sh
nvm use
npm ci
npm run build
```

Then load `.output/chrome-mv3` with **Load unpacked** in `chrome://extensions`.

After installing or reloading the extension, refresh pages that were already open. Chrome does not let extensions run on its internal pages, the Web Store or the built-in PDF viewer.

## ⌨️ Shortcuts

| Action | macOS | Windows / Linux |
| --- | --- | --- |
| Translate the page / show original | `⌃⇧A` | `Alt+A` |
| Translate the selection | `⌃⇧S` | `Alt+Shift+S` |
| Open the command palette | `⌃⇧K` | `Alt+Shift+K` |

Change them at `chrome://extensions/shortcuts`.

## 🔌 Engines

| Engine | Setup |
| --- | --- |
| Google Translate | Free, no setup. The default. |
| OpenAI | Your own API key |
| DeepSeek | Your own API key |
| Gemini | Your own API key and a model ID |
| Custom | Any OpenAI-compatible API, with presets for Ollama, LM Studio, OpenRouter and SiliconFlow |

When you add a custom service, the browser asks for access to its address. Add up to 10.

<details>
<summary>Use a local model with Ollama</summary>

1. In Settings, open **Translation services**, click **Add service**, and choose **Ollama (local)**. Enter the model name shown by `ollama list` (for example `qwen2.5:7b`), click **Add**, and choose Allow in the browser prompt.
2. Ollama rejects requests from browser extensions by default, so **Test connection** shows "The local service blocked the extension's request. For Ollama, set the OLLAMA_ORIGINS environment variable to chrome-extension://*, then quit Ollama completely and reopen it." Run this in a terminal, then quit Ollama from the menu bar and reopen it. Closing the window does not restart the background service.

   ```bash
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*"
   ```

   If you start Ollama with `ollama serve`, run `OLLAMA_ORIGINS="chrome-extension://*" ollama serve` instead. To confirm the service was just restarted, use `ps -o lstart,command -p $(pgrep -f "ollama serve")`.
3. Leave "Expose Ollama to the network" off. The extension talks to a local address, and turning it on only exposes the service to your network.
4. The first request after loading a model is slow and may time out. Test again once the model has loaded. Translation does not need a long context, so setting Context length to 8k to 16k in Ollama makes loading and responses noticeably faster. Models of 7B to 8B suit whole-page translation best.

</details>

## 🛠 Development

You need Node.js 22.12 or newer (`.nvmrc` pins 24), npm (`.npmrc` pins the official registry), and Chrome with Developer mode on.

```sh
nvm use
npm ci          # postinstall runs `wxt prepare`
npm run dev
```

Open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `.output/chrome-mv3-dev`. WXT rebuilds on every change. After changing the manifest or background code, reload the extension and refresh the page you are debugging.

### npm scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development build for Chrome, rebuilt on change |
| `npm run build` | Production build in `.output/chrome-mv3` |
| `npm run zip` | Packs the extension into a ZIP in `.output` |
| `npm run typecheck` | `wxt prepare` (generates types, including interface copy keys), then strict TypeScript |
| `npm run lint` | Read-only Biome check (format and lint), same as `biome ci .` |
| `npm run format` | Biome format with safe fixes applied |
| `npm test` | Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:e2e` | Smoke end-to-end tests in a real Chrome for Testing. Run `npm run build` first. Chrome is found via the `CHROME` environment variable, then the newest build in the Playwright cache (see `scripts/lib/find-chrome.mjs`). Not part of `npm run check` |
| `npm run check:build` | Checks the manifest, the entry files it references, and `_locales` against the `__MSG_*__` strings in the manifest |
| `npm run check:size` | Gzip size budget per entry (table below) |
| `npm run check:contrast` | Contrast of the color tokens: text at least 4.5:1, controls and focus rings at least 3:1, in light and dark |
| `npm run check:i18n` | Locale files have the same keys and placeholders. Source code may not contain hard-coded Chinese, so interface copy lives only in `src/locales/*.yml`. Opt out with an `i18n-ignore` comment. The baseline is at zero. |
| `npm run build:icons` | Regenerates the extension icons in `public/icon` and `docs/assets/icon` |
| `npm run check` | Runs everything: lint, typecheck, check:i18n, check:contrast, test, build, check:build, check:size |

### Size budget

`npm run check:size` enforces these gzip limits. The phonetic word lists have their own: 40 KB per shard and 2 MB per accent.

| Entry | Limit |
| --- | --- |
| content | 7.75 KB |
| page-runtime | 28 KB |
| selection-runtime | 19 KB |
| palette-runtime | 15 KB |
| background | 60 KB |
| popup | 90 KB |
| options | 150 KB |

### Continuous integration

<details>
<summary>What CI runs</summary>

`.github/workflows/ci.yml` runs on pull requests and on pushes to `main`:

- The same checks as `npm run check`.
- An audit of runtime dependencies with `scripts/check-audit.mjs`. A known high-severity issue blocks the build, unless the advisory is listed by ID with a reason and an expiry in `scripts/audit-allowlist.json`.
- A full dependency audit that only reports, because a fix often waits on upstream.
- Dependency review on pull requests, which blocks newly added or upgraded dependencies with high-severity issues.
- Verification of the registry signatures of installed packages.
- CodeQL with the `security-extended` query suite (`.github/workflows/codeql.yml`), on pull requests, pushes to `main` and weekly.
- Upload of the verified build as an artifact, kept for 7 days.
- An `e2e` job that runs the smoke end-to-end tests (`npm run test:e2e`) against that build in Chrome for Testing. It covers page translation, display modes, retries, caching, selection, the settings page, the action panel, the 403 engine error, the loading dot, extension reload, restarts and layout. A test that only passed on retry leaves a warning annotation on the run. Failed or retried tests upload `test-results/e2e/`. It does not block merging yet; it will be made required once it stays green without retries.

Dependabot (`.github/dependabot.yml`) checks npm and GitHub Actions weekly, and groups minor and patch updates into one pull request per group.

</details>

<details>
<summary>Local acceptance checklist</summary>

Run `npm run test:e2e` first. The items it covers automatically are listed in [`docs/plans/e2e-smoke.md`](docs/plans/e2e-smoke.md).

1. Load the extension and open **Translation services** in Settings. The default engine is Google. Click **Test connection** and check that a translation and its latency appear.
2. Enter your own key for OpenAI, DeepSeek or Gemini (Gemini also needs a model). **Test connection** should succeed, and a wrong key should report an invalid key.
3. Click **Add service**, choose a preset such as Ollama, enter a model, and add it. The browser asks for access. After you allow it, the new service appears under the custom group and is tested once. If you decline, it is marked as needing access and can be granted from its details.
4. Delete a custom service that is the default. The default engine returns to Google.
5. In **General**, change the target and source language with the dropdowns, using the keyboard (arrow keys, Enter, Esc, first letter), and switch Appearance to Dark.
6. On a regular page, open the toolbar panel and check that it shows the site and page language and lets you change the target language and default engine. On a page already in your language, on `chrome://extensions`, and on a page opened before the extension was installed, check that each shows its own hint; on the page already in your language, "Translate anyway" still starts a translation.
7. Clear the translation cache and check that the count goes to zero.
8. Stop the service worker at `chrome://serviceworker-internals`, then change a setting or test a connection. It should still work.
9. The full checklist for page translation, including motion checks at 4x CPU slowdown, is in section 10 of [`docs/plans/m2-page-translation.md`](docs/plans/m2-page-translation.md).
10. Layout of Translation only: run `python3 -m http.server 8765 --directory tests/fixtures`, open `http://localhost:8765/translation-only-layout.html` (content scripts run only on http and https pages, so the file cannot be opened directly), translate the page, switch to Translation only, drag the window width, and check each case against the gray note under it. Then switch back to Bilingual and check that the page is restored exactly.
11. Too-long paragraph notice: run `python3 -m http.server 8765 --directory tests/fixtures`, open `http://localhost:8765/too-long-paragraph.html`, translate the page, and check that the paragraphs over 5000 characters show the end-of-paragraph notice and the panel shows 6 in total.
12. Interface language: set Chrome's language to English and restart it, then reload the extension at `chrome://extensions`. The interface should be in English. Do the same with Traditional Chinese (Taiwan): the interface should read 譯嶼, and Chinese text should use Traditional font forms.

</details>

<details>
<summary>README screenshots</summary>

`scripts/screenshots/shoot.mjs` loads the build into a headless Chrome for Testing, opens a demo article, drives the extension and writes 2x images to `docs/assets/readme`. Each README shows its own interface language, translating from the other language: the English README translates a Chinese article into English, and the Chinese README the other way round.

```bash
npm run build
node scripts/screenshots/shoot.mjs --ui en --article zh --target en --word 每一次打断都有代价。
node scripts/screenshots/shoot.mjs --ui zh_CN --article en
```

It finds the newest Playwright Chrome for Testing, or takes a path from `CHROME`. The translations come from the live Google engine, so the text can change between runs. Look at every image before you commit it.

</details>

### Conventions

- Keys never go into source, logs or the repository.
- Interface copy lives only in `src/locales`, and `check:i18n` enforces it.
- New features cover the failure, cancel and cleanup paths.

## 📁 Project structure

```text
.
├── .github/
│   ├── workflows/               # CI (ci.yml) and CodeQL (codeql.yml)
│   ├── codeql/                  # CodeQL configuration
│   └── dependabot.yml           # Weekly dependency updates
├── docs/
│   ├── assets/                  # Icon SVG sources and README screenshots
│   ├── design/                  # Original design docs (feature reference)
│   ├── plans/                   # Technical plan for each batch
│   ├── reviews/                 # Final plan, UI/UX spec and review notes
│   └── dom-contract.md          # Markup the extension leaves in pages, for third-party tools
├── public/
│   ├── icon/                    # Extension icons
│   └── dict/                    # Phonetic shards (gb/, us/), sources and licenses
├── scripts/
│   ├── audit-allowlist.json     # Time-limited exceptions for the runtime dependency audit
│   ├── build-icons.mjs          # Generates the extension icons
│   ├── build-phonetics.mjs      # Builds phonetic shards from ECDICT and ipa-dict (run by hand)
│   ├── check-audit.mjs          # Runtime dependency audit that blocks high-severity advisories
│   ├── check-build.mjs          # Validates the manifest, entry files and locales in the build
│   ├── check-contrast.mjs       # Contrast check for color tokens
│   ├── check-i18n.mjs           # Locale consistency and no hard-coded Chinese in source
│   ├── check-size.mjs           # Gzip size budget per entry
│   ├── i18n-baseline.json       # Hard-coded copy not yet migrated (now empty)
│   ├── i18n-messages.mjs        # Reads locale files and mimics Chrome's getMessage (shared with tests)
│   └── screenshots/             # README screenshots: shoot.mjs and two demo articles (run by hand)
├── src/
│   ├── entrypoints/
│   │   ├── background.ts        # Service worker: the only config writer, translation service, handlers
│   │   ├── content.ts           # Content script (first-load bootstrap, about 7 KB)
│   │   ├── page-runtime.ts      # On-demand module: wires up a page translation session
│   │   ├── selection-runtime.ts # On-demand module: loaded on the first selection, wires up the card
│   │   ├── palette-runtime.ts   # On-demand module: loaded by the palette shortcut or the control bar's ⌘, wires up the palette
│   │   ├── popup/               # Toolbar panel
│   │   └── options/             # Settings page: General, Translation services, add dialog, tests
│   ├── content/                 # Page side
│   │   ├── anchor.ts            # Keeps the viewport anchored while translations are inserted
│   │   ├── auto-start.ts        # Starts translation on sites set to always translate
│   │   ├── bootstrap.ts         # First-load logic: messages and on-demand loading
│   │   ├── discover.ts          # Finds translatable blocks
│   │   ├── dom-rules.ts         # Which elements to skip or treat as blocks
│   │   ├── error-text.ts        # Maps error codes to messages on the page side
│   │   ├── i18n.ts              # Typed getMessage wrapper with plural selection
│   │   ├── loader.ts            # Loads the on-demand modules through a dynamic URL
│   │   ├── mutations.ts         # Watches dynamic content
│   │   ├── page-state.ts        # Readings of the session state shared by the control bar and the palette
│   │   ├── render.ts            # Inserts and restores translations, retry and too-long placeholders
│   │   ├── runtime-contract.ts  # Interface between the loader and the runtime modules
│   │   ├── segment.ts           # Splits blocks into segments and keeps inline formatting
│   │   ├── session.ts           # Translation session: viewport queue, retries, modes
│   │   ├── styles.ts            # Styles for inserted translations
│   │   ├── svg-icon.ts          # Engine icon drawing shared by the card and control bar
│   │   ├── text.ts              # Text helpers
│   │   ├── viewport.ts          # Viewport visibility and priority
│   │   ├── isle/                # Control bar: springs, geometry, hover intent, probing, shadow host
│   │   ├── palette/             # Command palette: command registry, keys, focus hand-back, placement, shadow host
│   │   └── selection/           # Selection: watching, text extraction, card, placement, requests, speech
│   ├── components/              # Shared UI: Select dropdown, ProviderIcon
│   ├── lib/
│   │   ├── action-icon.ts       # Status dot on the toolbar icon
│   │   ├── context-menu.ts      # Right-click menu entry
│   │   ├── endpoint.ts          # API URL normalizing and host permission checks
│   │   ├── engine-view.ts       # Engine list and readiness, shared by Settings and the panel
│   │   ├── error-messages.ts    # Error codes to message keys
│   │   ├── errors.ts            # AppError and Result
│   │   ├── host-permission.ts   # Optional host permission hook for pages
│   │   ├── languages.ts         # Supported languages and tag normalizing
│   │   ├── provider-icons.ts    # Path data for provider icons (lobe-icons, MIT)
│   │   ├── site-memory.ts       # Storage format for "Always translate this site"
│   │   ├── ui-locale.ts         # The interface's actual language and html lang
│   │   ├── config/              # Schema, lenient parsing, repository, client and useConfig
│   │   ├── messaging/           # Typed messages, handle/call, Port transport, sender checks
│   │   ├── phonetic/            # English phonetics: notation, sharded lookup, inflections
│   │   └── translate/           # Translation core (background only): providers, scheduler, cache, secrets
│   ├── locales/                 # en.yml (default), zh_CN.yml and zh_TW.yml, turned into _locales and types
│   └── styles/                  # Design tokens, base styles, theme switching
├── scripts/
│   └── lib/                     # Shared script helpers, such as find-chrome.mjs
├── tests/
│   ├── e2e/                     # Smoke end-to-end tests (real Chrome, mocked translation)
│   └── fixtures/                # Test pages: translation-only-layout.html and too-long-paragraph.html (manual), e2e-article.html and e2e-native.html (e2e)
├── .npmrc                       # Pins the official npm registry
├── .nvmrc                       # Node.js version (24)
├── biome.json                   # Biome config
├── package.json                 # Scripts and dependencies
├── tsconfig.json                # TypeScript config (extends the one WXT generates)
├── vitest.config.ts             # Vitest config
├── vitest.e2e.config.ts         # Vitest config for the end-to-end tests
├── vitest.setup.ts              # Test setup: fake browser and locale copy for getMessage
├── wxt.config.ts                # WXT and Manifest V3 config
├── CHANGELOG.md                 # Change log
├── DESIGN.md                    # Early design notes, now replaced by the UI/UX specification
├── HANDOFF.md                   # Current progress and decisions
├── README.md                    # This file
├── README.zh-CN.md              # Chinese README
├── SECURITY.md                  # Security policy
├── THIRD_PARTY_NOTICES.md       # Third-party licenses
└── LICENSE                      # MIT
```

Unit tests sit next to the source they cover and are named `*.test.ts`.

## 🗺 Roadmap

| Status | Milestone |
| --- | --- |
| ✅ Done | M0 foundation |
| ✅ Done | M1 translation core |
| ✅ Done | M2 page translation and control bar |
| ✅ Done | M3a selection translation and phonetics |
| ✅ Done | Interface languages (English, Simplified Chinese, Traditional Chinese) |
| ✅ Done | Bilingual README |
| ✅ Done | Rename to Islet Translate (译屿) |
| ✅ Done | Smoke end-to-end tests (PR 1, PR 2 and the extension-reload case all merged) |
| ✅ Done | v0.2.0 as a GitHub Release |
| ✅ Done | M3d dynamic pages and site rules |
| ✅ Done | v0.3.0 as a GitHub Release |
| ✅ Done | M3b paragraph-level interaction |
| ✅ Done | v0.4.0 as a GitHub Release |
| In progress | M3c command palette and keyboard control of the control bar (PR 1, the palette itself, PR 2, Settings entry and shortcut display, and PR 6, the control bar's ⌘ entry, done; next PR 3, the quick translate box, then PR 4 and PR 5) |
| Later | M3e Chrome's built-in local engine |
| Later | M4 expert styles, glossary, input translation, multi-engine comparison on the card |
| Later | M5 YouTube subtitles, article refinement, vocabulary list, bilingual export |
| Later | M6 TikTok and subtitle files |
| Later | M7 optional polish |
| Later | M8 accounts (undecided) |

## 📚 Docs

Design docs and the changelog are in Chinese.

| Document | Contents |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | Current progress, decisions and next steps. Read this first before contributing. |
| [Final technical plan](docs/reviews/2026-11-13-final-plan.md) | Authoritative architecture, choices and the M0 to M8 delivery batches |
| [UI/UX specification](docs/reviews/2026-11-13-ui-ux-design.md) | Authoritative visuals, interaction and performance budget |
| [CHANGELOG.md](CHANGELOG.md) | Change log |
| [docs/README.md](docs/README.md) | Design docs by feature |
| [M0 foundation](docs/plans/m0-foundation.md) | Quality gates, config, messaging, Port and design tokens |
| [M1 translation core](docs/plans/m1-translation-core.md) | Providers, scheduling, cache, keys, permissions and Settings |
| [Interface direction](docs/plans/ui-isle-direction.md) | The confirmed interface direction, motion rules and amber theme tokens |
| [M2 page translation](docs/plans/m2-page-translation.md) | Scanning, viewport queue, rendering and the acceptance checklist |
| [M2b lazy runtime and control bar](docs/plans/m2b-lazy-runtime-and-isle.md) | Lean first load, on-demand modules and the control bar |
| [M3a selection translation](docs/plans/m3a-selection.md) | Dot and card, streaming, selection consistency |
| [Provider icons](docs/plans/provider-icons.md) | Icon data, delivery and size |
| [English phonetics](docs/plans/phonetics-en.md) | Data sources, notation, sharding and the speech fix |
| [Interface languages](docs/plans/i18n.md) | Locale files, rules and the check script |
| [Page DOM contract](docs/dom-contract.md) | Markup left in pages for third-party tools such as page export. Changing it is a breaking change. |
| [Codex review verification](docs/reviews/2026-11-17-core-findings-verification.md) | Verified findings on the core implementation and the fix schedule |

## 🔒 Privacy and security

Keys are stored only on your computer and are never exported or synced. The translation cache also stays on your computer, and entries older than 7 days are removed every day. To report a security issue, do not open a public issue. Use **Report a vulnerability** on the repository's Security page. See [SECURITY.md](SECURITY.md).

## 📄 License

Islet Translate is released under the [MIT License](LICENSE).

It includes third-party resources, each under its own license. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The extension package also carries a `THIRD_PARTY_NOTICES.txt`.

- Provider icons: [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT)
- Settings gear in the panel: [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT)
- British phonetics: [ECDICT](https://github.com/skywind3000/ECDICT) (MIT)
- American phonetics: [ipa-dict](https://github.com/open-dict-data/ipa-dict) (MIT), based on [cmudict-ipa](https://github.com/lingz/cmudict-ipa) (MIT) and the [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (BSD-style license)
