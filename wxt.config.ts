import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  manifestVersion: 3,
  webExt: { disabled: true },
  // Release asset name, e.g. Islet-Translate-v0.2.0-chrome.zip (the default is the package name).
  zip: { artifactTemplate: 'Islet-Translate-v{{version}}-{{browser}}.zip' },
  manifest: {
    // UI copy lives in src/locales/*.yml; @wxt-dev/i18n turns it into _locales. Chrome picks
    // the browser's language and falls back to en (docs/plans/i18n.md).
    default_locale: 'en',
    name: '__MSG_manifest_name__',
    short_name: '__MSG_manifest_shortName__',
    description: '__MSG_manifest_description__',
    permissions: ['storage', 'activeTab', 'contextMenus'],
    host_permissions: [
      'https://translate.googleapis.com/*',
      'https://api.openai.com/*',
      'https://api.deepseek.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    // Popover (114) and @starting-style (117) in the UI; 130 for dynamic-URL web
    // accessible resources (`use_dynamic_url`) that serve the on-demand page runtime.
    minimum_chrome_version: '130',
    // page-runtime.js, selection-runtime.js and palette-runtime.js are imported by the content
    // script only.
    // The dynamic URL keeps pages from fetching them by extension ID
    // (see docs/plans/m2b-lazy-runtime-and-isle.md).
    web_accessible_resources: [
      {
        resources: ['page-runtime.js'],
        matches: ['http://*/*', 'https://*/*'],
        use_dynamic_url: true,
      },
      {
        resources: ['selection-runtime.js'],
        matches: ['http://*/*', 'https://*/*'],
        use_dynamic_url: true,
      },
      {
        resources: ['palette-runtime.js'],
        matches: ['http://*/*', 'https://*/*'],
        use_dynamic_url: true,
      },
    ],
    // popup/index.html has no <title> on purpose: WXT would copy it over this one.
    action: { default_title: '__MSG_manifest_actionTitle__' },
    commands: {
      // Not Ctrl+Shift+A on Windows/Linux: Chrome's tab search owns it and the
      // declaration would silently fail. See docs/plans/m2-page-translation.md 5.1.
      'translate-page': {
        suggested_key: { default: 'Alt+A', mac: 'MacCtrl+Shift+A' },
        description: '__MSG_manifest_commands_translatePage__',
      },
      // Not Alt+S: it collides with Outlook on the web (send) and MediaWiki's save access key
      // in Chrome. See docs/plans/m3a-selection.md 4.6.
      'translate-selection': {
        suggested_key: { default: 'Alt+Shift+S', mac: 'MacCtrl+Shift+S' },
        description: '__MSG_manifest_commands_translateSelection__',
      },
      // Not Alt+K: on Windows and Linux Chrome fires access keys with Alt, and MediaWiki's `k`
      // is "Related changes". See docs/plans/m3c.md, section "快捷键".
      'open-palette': {
        suggested_key: { default: 'Alt+Shift+K', mac: 'MacCtrl+Shift+K' },
        description: '__MSG_manifest_commands_openPalette__',
      },
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
