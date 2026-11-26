# M4-A 思考与额外请求参数

> 状态：方案第 2 稿，2026-11-26 用户批准（含第 7 节新文案与「需要你决定的事」第 1、3 条；第 1 稿经 Opus 对抗式审查，结论「需修改后批」，6 条必须修改已改，见文末「审查记录」）。依据：`docs/plans/m4.md`「A 思考与额外参数」与共同规则 1–3；DeepSeek 先例 #88（`providers.deepseek.thinking`、`extraBody`）。官方文档核实于 2026-11-26（链接见「参数依据」）。

## 目标
1. OpenAI、Gemini 内置引擎翻译时默认用**最低思考**（更快、更省 token），设置里与 DeepSeek 一样有「思考模式」开关（默认关）。默认 OpenAI 模型 `gpt-5-mini` 在覆盖范围内。
2. 自定义服务与内置 OpenAI 可以填「额外请求参数（JSON）」，合并进请求体，用来给我们不认识的模型或网关传参数。
3. 默认状态下所有现有缓存继续有效（m4.md 共同规则 1）。

## 参数依据（官方文档，2026-11-26 核实）
**OpenAI**：Chat Completions 顶层 `reasoning_effort`；取值随模型而定（[推理指南](https://developers.openai.com/api/docs/guides/reasoning)；各模型页 `developers.openai.com/api/docs/models/<id>`；GPT-5 系列见 [GPT-5 模型页](https://developers.openai.com/api/docs/models/gpt-5) 与 [GPT-5 开发者发布说明](https://openai.com/index/introducing-gpt-5-for-developers/)）。

| 模型 | 官方档位 | 「关」时下发 | 界面分类 |
|---|---|---|---|
| gpt-5.1、gpt-5.2、gpt-5.5、gpt-6-luna、gpt-6.1-terra | 含 `none` | `"none"` | 可关 |
| gpt-5、gpt-5-mini、gpt-5-nano | `minimal` 起 | `"minimal"` | 只能降到最低 |
| gpt-6.1-sol、gpt-6.2-astra、gpt-6.2-sol（官方写明不支持 `none`，传了会 400） | `low` 起 | `"low"` | 只能降到最低 |
| o3（Deprecated）、gpt-4.1、gpt-4o 等非推理模型、其他未列出 | — | 不下发 | 不显示开关 |

**Gemini**：`generationConfig.thinkingConfig`；2.5 用 `thinkingBudget`，3 及以后用 `thinkingLevel`，混用会报错（[Vertex 思考文档](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking)、[Gemini API reference](https://aistudio.google.com/api-reference/generate-content)）。

| 模型 | 官方能力 | 「关」时下发 | 界面分类 |
|---|---|---|---|
| gemini-2.5-flash、gemini-2.5-flash-lite | 可关 | `{"thinkingBudget": 0}` | 可关 |
| gemini-2.5-pro | 不能关，最小 128 | `{"thinkingBudget": 128}` | 只能降到最低 |
| gemini-3-flash、gemini-3.1-flash-lite、gemini-3.5-flash、gemini-3.5-flash-lite、gemini-3.6-flash | 最低 `MINIMAL` | `{"thinkingLevel": "MINIMAL"}` | 只能降到最低 |
| gemini-3-pro-preview、gemini-3.1-pro、gemini-3.7-flash、gemini-3.8-flash、gemini-4 系列 | 最低 `LOW` | `{"thinkingLevel": "LOW"}` | 只能降到最低 |
| gemini-2.0 及更早、别名（如 `gemini-flash-latest`）、其他未列出 | — | 不下发 | 不显示开关 |

- 我们只读正文、不设 `includeThoughts`，默认不会收到思考内容。
- 「开」= 不下发任何思考字段，用模型自己的默认档（2.5 Pro 为动态思考）；「关」= 下发上表的最低档。
- `MINIMAL`、`LOW` 的大小写以真机请求为准（实施时用测试连接核实）。

**DeepSeek**：保持 #88 的行为不变：对任何 DeepSeek 模型都下发 `{"thinking": {"type": "disabled"}}`，开关始终显示。在规则表里写成「整个引擎通用」的一条，不按模型匹配。

## 方案
### 1. 规则表（`src/lib/config/thinking-rules.ts`，新文件，共享、不依赖 zod）
- 放在 `src/lib/config/` 而不是后台目录，因为设置页也要靠它决定开关显不显示、用哪种说明（仿 `engine-fields.ts`）。后台与 options 各自打包一份，不进内容脚本。
- 一张数据表：引擎 × 模型 → `{ kind: 'off' | 'minimum', body }`；DeepSeek 一条整引擎通用。
- **模型匹配**：先去掉首尾空白和 `models/` 前缀，再做「精确 id，或 id + 限定后缀」匹配。后缀只认：`-YYYY-MM-DD`、`-preview`、`-preview-MM-YYYY`、`-preview-MM-DD`、`-00N`。这样 `gpt-5.1-mini`、`gpt-5.1-chat-latest`、`gemini-2.5-flash-image`、`*-tts` 都不会被当成表里的模型；别名不命中，可以接受。
- **只对官方端点下发**：OpenAI 要求 `baseURL` 规范化后等于 `https://api.openai.com/v1`；Gemini、DeepSeek 端点固定。判断在 `settingsFor` 里做，测试连接也调它，两边自然一致。

### 2. 配置（只追加字段，旧配置靠 `mergeDefaults` 补默认值，不升 `schemaVersion`）
- `providers.openai.thinking: boolean`、`providers.gemini.thinking: boolean`，默认 `false`。
- `providers.openai.extraBody: string`（默认 `''`）；`customProviders[id].extraBody?: string`。存用户输入的原文（保留格式），上限 2000 字符。
- 要同步改的落点：`CustomProvider` 类型、`customProviderSchema`、`CUSTOM_PROVIDER_LIMITS`、`repository.ts` 的 `CUSTOM_FIELDS` 白名单（不加的话更新自定义服务时额外参数会被静默丢掉）、`engine-fields.ts`（给 openai、gemini 返回 thinking 与 extraBody）、`paths` 测试。
- 内容脚本用的 `client.ts` 不加校验：`isCustomProvider` 只查 name、baseURL、model，多出的字段原样保留；内容脚本也不读这些字段。

### 3. 非法 JSON 的处理（一处拦住，不让它存进去）
- **写入时拒绝**：后台写配置（含自定义服务的增改）时校验 `extraBody`：空白或 `{}` 视为空；必须解析为 JSON 对象，否则拒绝写入并返回错误，设置页显示错误。
- **设置页草稿**：失焦时校验，非法时显示错误、不保存，测试连接按钮置为不可用。
- **运行时兜底**：后台读到非法值（只可能是被手改的数据）时忽略，不下发、不进缓存键。
- **测试连接**：`ProviderTestDraft` 与 `parseDraft` 增加 `extraBody` 与长度校验；草稿非法时返回新错误码（文案在后台的错误文案表里加一条）。

### 4. 请求
- `settingsFor` 产出 `ProviderSettings.extraBody`：思考字段在前，用户参数在后（用户可以覆盖思考字段，例如给某模型传更高档）；适配器最后写 `model`、`stream`、`messages`，不可覆盖。
- Gemini 复用 `extraBody`：内容为 `{ generationConfig: { thinkingConfig: … } }`，在适配器里于 `systemInstruction`、`contents` 之前展开；Gemini 不开放用户参数，所以 `thinkingBudget` 与 `thinkingLevel` 不会混用。
- 测试连接带上当前思考开关与额外参数草稿。

### 5. 缓存（共同规则 1）
- `ProviderSettings` 新增 `cacheParams?: Record<string, unknown>`，只放**确实改变了请求体**的非默认项：
  - 思考：只有规则表命中、且开关为「开」（于是不下发最低档字段）时，才放 `{ thinking: true }`。用户开着思考又换成表里没有的模型或代理地址时，请求体与默认相同，不进键。DeepSeek 开思考同理放 `{ thinking: true }`。
  - 额外参数：放**解析后的对象**（不放原文，格式变化不影响键）；空、`{}`、非法值都不放。
- `service.ts` 的 `paramsDigest`：`cacheParams` 为空时是 `''`（现有键不变），否则是 `stableStringify(cacheParams)` 的 sha256。全仓只有 `service.ts` 一处调用 `makeCacheKey`，划词、快速翻译、整页翻译都走它；测试连接不写缓存。
- 副作用（写进 CHANGELOG）：#88 之后**已打开** DeepSeek 思考的用户，缓存键会变一次，相当于重新翻译一遍；默认关思考的用户不受影响。

### 6. 设置页
- `ThinkingRow`：去掉写死的 `providers.deepseek.thinking`，改为传入配置路径与分类（`off` / `minimum`）。显示条件改为「规则表对**已保存**的模型和地址给出了结果」（不再用 `fields?.thinking !== undefined`，否则加字段后开关会无条件出现）。模型失焦即保存，开关随之出现或消失。
- 分类为 `minimum` 时，在原说明后**追加**一句「该模型无法完全关闭思考，关闭时使用最低档。」，保留原来「更慢、更费 token」的提示。
- 「额外请求参数（JSON）」：放在内置 OpenAI 与每个自定义服务的**详情**里（「添加服务」对话框不放）；多行等宽文本框；`testedWith` 加上额外参数草稿，改动后旧的测试结果清掉。

### 7. 新增文案（需你确认，三语同步）
- 「额外请求参数（JSON）」
- 说明：「会合并进每次翻译请求，用于给模型或网关传额外参数，例如 {"reasoning_effort": "low"}。不能覆盖 model、stream、messages。不要在这里填写密钥。」（示例用 `reasoning_effort`；Ollama 的 `{"think": false}` 在其 OpenAI 兼容接口上是否生效未核实，不作示例。）
- 错误：「需要是一个 JSON 对象，例如 {"key": "value"}。」
- 思考补充说明：「该模型无法完全关闭思考，关闭时使用最低档。」
- 复用 #88 的「思考模式」「开」「关」与原说明。

## 不做
- 「添加服务」对话框里的额外参数；Gemini、DeepSeek 的额外参数。
- 宽前缀猜测未知模型；o3 的思考参数；别名模型。
- 更换默认 OpenAI 模型（`gpt-5-mini` 已 Deprecated，但仍可用且在规则表内；换不换、换成什么另行决定，不放本批）。

## 需要你决定的事
1. **额外请求参数开放范围**：自定义服务 + 内置 OpenAI（OpenAI 地址可改成代理，代理上官方思考规则不下发，可靠它自己传）。DeepSeek、Gemini 不开放。
2. 第 7 节 4 条新文案。
3. 默认 OpenAI 模型是否另开一个小改动更换（本批不做）。

## 测试
- 规则表：每一行模型（含各种后缀）映射正确；`gpt-5.1-mini`、`gemini-2.5-flash-image`、别名不命中；OpenAI 非官方端点不下发；DeepSeek 任意模型都下发（与 #88 一致）。
- 请求体：openai-compat 合并顺序（用户参数可覆盖思考字段，不能覆盖 model、stream、messages）；gemini 的 `generationConfig.thinkingConfig` 在「开」时不出现。
- 配置：旧配置补默认值；写入时非法 `extraBody` 被拒绝；`CUSTOM_FIELDS` 更新时额外参数不丢；运行时非法值被忽略且不进键。
- 缓存：默认状态 `paramsDigest === ''`，用例对比改动前的键；开思考（规则命中）与填额外参数后键改变；开思考但模型不在表里时键不变；额外参数格式不同、内容相同时键相同。
- 测试连接：带思考与额外参数；非法草稿返回新错误码。
- 设置页：开关只在规则命中时显示、随已保存的模型变化；`minimum` 追加说明；额外参数校验、保存与 `testedWith`。
- 全部跑 `npm run check` 与 `npm run test:e2e`。

## 真机验收（需要你的 OpenAI / Gemini 密钥，没有的跳过对应项）
- OpenAI 默认模型 `gpt-5-mini` 与 Gemini 2.5 Flash 或 3.x Flash：关思考时首段译文明显更快，开思考时变慢；测试连接都成功（同时核实 `MINIMAL`/`LOW` 大小写）。
- 自定义服务填一条额外参数后，测试连接与翻译正常；填非法 JSON 时被拦下。

## 体积
background 现 59.49 / 60 KB；规则表、合并与校验预计 +0.5–0.8 KB，**按 M4 已批预算把 background 改为 66 KB**（随本批生效）。规则表同时进 options（余量充足）；content 不变。

## 最脆弱的假设
本方案假设模型 id 与官方档位短期内稳定。官方模型更新很快，规则表会过时：新模型不在表里时只是「不下发、不显示开关」，不会出错；若官方改了某个已收录模型的档位，最坏是该模型请求 400，测试连接能立刻暴露。缓解：只收官方写明的档位；表放单独文件，每次发版前核对一次。

## 回滚
revert 即可；新增配置字段被宽松 schema 忽略，缓存键默认不变。

## 审查记录（第 1 稿，Opus 对抗式审查，2026-11-26）
| 发现 | 处理 |
|---|---|
| 规则表放在后台目录，设置页用不到 | 采纳：移到 `src/lib/config/thinking-rules.ts` |
| 缓存：开关为「开」但规则不命中时仍进键，造成无谓分叉；额外参数按原文进键 | 采纳：只在确实改变请求体时进键；额外参数按解析结果，空、`{}`、非法都不进键 |
| DeepSeek 并入按模型匹配的表会改变 #88 行为 | 采纳：写成整引擎通用的一条 |
| `gpt-5-mini` 不在覆盖范围，与 m4.md 冲突 | 采纳：查到官方 GPT-5 系列支持 `minimal`，补上 mini、nano |
| 漏列落点（`CUSTOM_FIELDS`、schema 上限、测试连接草稿、`engineFields` 显示条件、`ThinkingRow` 写死路径、`testedWith`、错误码） | 采纳：写进第 2、3、6 节 |
| 非法 JSON 处理前后矛盾 | 采纳：写入时拒绝，运行时兜底忽略，草稿非法时禁用测试连接 |
| 匹配规则要写明后缀；Gemini 复用 `extraBody` 更省；`minimum` 说明追加而非替换；开关按已保存配置显示；Ollama 示例未核实 | 采纳 |

## 实施记录（2026-11-26，#92）
### 范围
按第 2 稿第 1–7 节实现：OpenAI、Gemini 最低思考与「思考模式」开关；内置 OpenAI 与自定义服务的「额外请求参数（JSON）」；缓存键只在请求体确实变化时改变。提示词、`PROMPT_VERSION`、Port 协议、内容脚本的行为都没改。

### 代码要点
- 规则表 `src/lib/config/thinking-rules.ts`（新，不依赖 zod，后台与设置页共用）：`thinkingRule(engine, model, baseURL)` 返回 `{ kind, body }` 或 `undefined`。模型先去首尾空白与 `models/` 前缀，再做「精确 id 或 id + 限定后缀」匹配（`-YYYY-MM-DD`、`-preview`、`-preview-MM-YYYY`、`-preview-MM-DD`、`-00N`）。OpenAI 只在地址规范化并经 `new URL()` 解析后 `href === 'https://api.openai.com/v1'` 时命中（主机名大小写、默认端口不影响，见「审查修复」第 4 条）；DeepSeek 整引擎一条 `{ thinking: { type: 'disabled' } }`，与 #88 相同。每次返回新对象，调用方改动不会污染表。
- 额外参数 `src/lib/config/extra-body.ts`（新）：`parseExtraBody` 空白与 `{}` 返回 `undefined`，非 JSON 对象或顶层含 `__proto__`/`constructor`/`prototype` 返回 `null`；`isExtraBodyValid` 供写入、测试连接与设置页共用。
- 配置：`providers.openai.thinking/extraBody`、`providers.gemini.thinking`（默认 `false`、`''`），`CustomProvider.extraBody?`；`customProviderSchema` 与 `CUSTOM_PROVIDER_LIMITS.extraBody = 2000`；`CUSTOM_FIELDS` 加 `extraBody`；`engineFields` 给 openai、gemini 返回 `thinking`，给 openai 与自定义服务返回 `extraBody`；`fieldChange` 支持 `extraBody`。schema 只限长度（若在 schema 里校验 JSON，存储里一条坏值会让修复逻辑删掉整个自定义服务），JSON 校验放在 `repository.patch`：`providers.openai.extraBody` 与自定义服务的增、改都会拦下，错误码 `config/invalid-extra-body`，什么都不写。
- 请求：`settingsFor` 先放规则表的最低档字段（开关为关且规则命中时），再 `Object.assign` 用户参数（只对 openai 与自定义服务解析，非法值忽略），产出 `extraBody` 与 `cacheParams`；openai-compat 与 gemini 适配器把 `extraBody` 展开在最前，`model/stream/messages`、`systemInstruction/contents` 写在后面不可覆盖。测试连接走同一个 `settingsFor`。
- 缓存：`ProviderSettings.cacheParams` 只在开关为开且规则命中（`{ thinking: true }`）或有解析后的额外参数（`{ extraBody: 对象 }`）时出现；`service.ts` 的 `paramsDigest` 在 `cacheParams` 缺省时为 `''`，否则为 `sha256(stableStringify(cacheParams))`。
- 测试连接：`ProviderTestDraft.extraBody?`；`parseDraft` 校验类型与 2000 字上限（否则 `validation/invalid-payload`），内容不是 JSON 对象时返回 `config/invalid-extra-body`；后台错误文案表加 `errors.config.invalidExtraBody`。
- 设置页：`ThinkingRow` 改为传入 `path` 与 `kind`；显示条件为 `thinkingRule(engine, 已保存的模型, 已保存的地址)` 有结果；`minimum` 时说明用 `options.engine.thinkingHintMinimum`（`$1` 为原说明，后接新句子，英文以空格分隔）。「额外请求参数（JSON）」为多行等宽文本框，只在内置 OpenAI 与自定义服务详情里出现；失焦校验，非法时显示错误、不保存；草稿非法时测试按钮不可用（提示条显示同一句错误）；保存原文（空白存为 `''`）；`testedWith` 加上额外参数草稿。
- 文案（三语）：`options.engine.extraBody`、`options.engine.extraBodyHint`、`options.engine.thinkingHintMinimum`、`errors.config.invalidExtraBody`（设置页内联错误、测试按钮提示与后台错误共用这一条）。
- 体积预算：`scripts/check-size.mjs` background 60 → 66 KB（2026-11-26 用户批准，`docs/plans/m4.md`，随 M4-A 生效）。

### 测试增量
- 新增 `thinking-rules.test.ts`、`extra-body.test.ts`、`engine-item.test.ts`（设置页整行渲染：开关显示条件、写入路径、额外参数校验 / 保存 / 测试草稿 / 旧结果清除）；扩充 registry、openai-compat、gemini、service（缓存键）、admin（测试连接）、repository、parse、client、engine-fields、paths、error-messages、`thinking.test.ts`。
- 缓存键回归：`service.test.ts` 用改动前代码（main 1712d02）同一配置与请求实测的 5 个缓存键字面量（OpenAI 批量 / 流式、DeepSeek、Gemini 2.5 Flash、自定义服务）做逐字对比。
- 实现前：先写的用例共 122 条失败（56 条断言失败；`thinking-rules.test.ts`、`extra-body.test.ts` 两个新文件因模块不存在整体失败，共 63 条；`thinking.test.ts` 的 3 条新用例在旧组件上失败）。openai-compat「额外字段在前」一条在旧代码上即通过，用来锁住已有顺序。

### 变异检查（`npx vitest run src`，逐条改坏后跑、再还原）
| # | 改坏的守卫 | 失败用例数 |
|---|---|---|
| 1 | 去掉 OpenAI 官方端点判断 | 4 |
| 2 | 后缀限定改成宽前缀（`startsWith` 即命中） | 13 |
| 3 | 开思考但规则不命中也进键（单独改成 `if (fields.thinking)` 无条件进键） | 3 |
| 4 | 额外参数按原文进键 | 2 |
| 5 | openai-compat 把 `extraBody` 展开在最后（用户参数能覆盖 `model`） | 2 |
| 6 | `CUSTOM_FIELDS` 不加 `extraBody` | 2 |
| 7 | 默认状态也算 `paramsDigest`（`cacheParams ?? {}`） | 2 |
| 8 | 写入 `providers.openai.extraBody` 时不校验 | 1 |
| 9 | Gemini 的 `extraBody` 展开在 `contents` 之后 | 1 |
| 10 | 用户参数放在思考字段之前（思考字段反压用户参数） | 2 |
| 11 | 测试连接不校验额外参数草稿 | 1 |
| 12 | 设置页开关改回按 `fields.thinking !== undefined` 显示 | 3 |
| 13 | Gemini 也解析用户额外参数 | 2 |

每条都有用例失败，还原后全部通过。

### 体积实测（gzip，含审查修复）
| 入口 | 改动前 | 改动后 | 预算 |
|---|---|---|---|
| content | 7.66 KB（7843 B） | 7.65 KB（7836 B） | 7.75 KB |
| background | 59.49 KB | 60.35 KB | 66 KB |
| options | 89.88 KB | 90.94 KB | 150 KB |
| popup | 83.34 KB | 83.39 KB | 90 KB |

content 的默认配置要多带 3 个字段（约 +12 B），为不让 content 变大，`client.ts` 的 `normalizeConfig` 做了两处等价精简：去掉与 `...merged` 重复的 `providers` 赋值（只保留类型断言），`isTheme` 改用已有的 `oneOf`。行为不变（`client.test.ts` 全部通过）。

### 验证（审查修复后重跑）
- 完整 `npm run check`：退出码 0；单元测试 94 个文件、2456 条全部通过（含审查修复后的用例）；lint 只有一条既有的 CSS 告警（`options.module.css` 的 `.sample` 选择器顺序，与本批无关）；体积检查通过。
- `npm run test:e2e`：退出码 0；14 个文件，81 条通过、2 条跳过（都在 `load.e2e.test.ts`，本批未改动该文件）。
- 真机验收（OpenAI / Gemini 密钥、`MINIMAL`/`LOW` 大小写）未做，留给用户。

### 与方案的偏差
- 「gemini-4 系列」按「只认精确 id + 限定后缀」的规则无法用一个前缀表示，按 Google AI Studio 模型页（2026-11-26）列出的 4 个 id 收录：`gemini-4-hydrogen`、`gemini-4-carbon`、`gemini-4-neon`、`gemini-4-argon`（Vertex 思考文档写明 Gemini 4 最低 `LOW`、不支持 `MINIMAL`）；`gemini-4-carbon-cyber` 一类变体不命中。
- `MINIMAL`、`LOW` 的大小写按文档大写下发，真机核实留到「真机验收」。
- 额外参数里的 `model`、`stream`、`messages` 等键照常进入 `cacheParams`（请求里会被覆盖），只会让这类写法多存一份缓存，不影响正确性。
- `client.ts` 的两处等价精简（见「体积实测」）不在方案里，为满足「content 不变大」而做。

## 审查修复（check 第 1 轮，Opus，无阻断、无重要）
先写测试，实现前 6 条失败，修复后全部通过；新增守卫各做一次变异检查（改坏后有用例失败，还原后通过）。
1. **[低] 失焦校验失败后，改其他字段会悄悄丢掉草稿，错误提示却还挂着**（`EngineItem.tsx` 同步草稿的 effect）。选的修法是「草稿处于错误状态时不覆盖它」，没有选「覆盖时清掉错误」：出错的草稿是用户还没改完的输入，错误提示指的正是它，被已保存的值悄悄替换等于丢掉输入。保留草稿后，错误、`aria-invalid` 与测试按钮不可用三者始终一致；改对后失焦即保存、错误消失。同一写法的 baseURL（`baseError`）一并修复。用例：`engine-item.test.ts`「keeps an invalid draft and its error when another field is saved meanwhile」。变异：改回无条件覆盖，1 条失败。
2. **[低] 错误提示没有程序化关联**。额外参数与 baseURL 的错误提示加了 id：额外参数文本框出错时 `aria-describedby` 为「错误 + 说明」，baseURL 输入框出错时指向错误。用例「ties the error to the field it is about」。变异：错误不进 `aria-describedby`，2 条失败。
3. **[低] `{"__proto__":{"x":1}}` 不会发出去，却进了缓存键**。按审查倾向，在 `parseExtraBody` 里把顶层的 `__proto__`、`constructor`、`prototype` 键当作非法（写入、测试连接、设置页都显示「需要是一个 JSON 对象」，运行时忽略、不进键）。嵌套在值里的这些键是普通数据，`JSON.stringify` 会原样发出，缓存键与请求一致，不拦。用例：`extra-body.test.ts`、`registry.test.ts`、`repository.test.ts`。变异：不拒绝保留键，3 条失败。
4. **[建议] 主机名大写或带 `:443` 时不算官方端点**。`thinking-rules.ts` 改为 `new URL(normalizeBaseURL(baseURL)).href === 'https://api.openai.com/v1'`：主机名转小写、默认端口去掉，仍要求 https、无用户信息、无查询串；解析失败不算官方。用例：`https://API.openai.com/v1`、`https://api.openai.com:443/v1` 命中；`http://api.openai.com/v1`、`:8443`、带用户信息、带查询串、非 URL 不命中。变异：改回字符串比较，1 条失败。
- 模型名保持区分大小写（OpenAI 的模型 id 本身区分大小写），不做转换。
