# dsh-usage-cost · 用量计费

在每条回复底部那排操作图标里，紧挨着自带的「用量 13.1M tok」加一枚：

```
花费 ¥0.0834
```

它算的是**这一轮**的 token（和旁边那个徽标同一份数据，轮节点的 `data.tokenUsage`），
所以数字永远对得上；一轮里有多个模型时按各自单价分开算。

鼠标悬停能看到每一档的明细：

```
本轮 token 花费（DeepSeek V3.2（2025-09-05 起），每百万 token 单价）
未命中缓存输入 1,234,567 × ¥2 = ¥2.4691
命中缓存输入 5,000,000 × ¥0.2 = ¥1.0000
写入缓存输入 0 × ¥2 = ¥0
输出 200,000 × ¥3 = ¥0.6000
合计 ¥4.0691（共 6,434,567 tokens）
模型 deepseek/deepseek-chat
```

另外在输入框下方那排药丸里也挂了一枚**会话累计**（同样四个计费桶，取会话级投影
`tokenUsage`）。两处都挂在插槽上：`conversation.chat.assistant-actions`（每轮）与
`conversation.composer.dock`（会话）。

## 数据从哪来

三种来源，覆盖范围不同，别混用：

| 用在哪 | 数据源 | 覆盖范围 |
|---|---|---|
| 每条回复右下角的 `¥0.xx` | 轮节点的 `data.tokenUsage` | **那一轮** |
| 底部状态栏的「花费」 | 本插件注册的宿主投影 `usageCost` | **整个会话** |
| 底部状态栏的退路 | 客户端按已加载轮次求和 | 仅已加载的轮（会随滚动变大，只在投影未就绪时用） |

**为什么必须由宿主折叠**：客户端只物化最近若干轮，`snapshot.nodes` 是「当前已加载窗口」。早先版本
用它在浏览器里加总，结果往上翻聊天、把更早的轮加载出来之后，会话累计会一点点变大 ——「本会话花费」
显然不能随滚动变化。现在 `src/index.mjs` 通过 `ctx.sessionProjections.register(...)` 注册投影
`usageCost`：在宿主里把**整个会话**的事件流折叠一次（逐事件累加、按 `(turn, step)` 替换、
`llm/retry-started` 关掉替换槽 —— 语义与 `tokenUsage` 投影一致），客户端用
`useProjection('usageCost')` 读合计。

四个计费桶（三份数据的字段一致）：

| 字段 | 含义 |
|---|---|
| `uncachedInputTokens` | 未命中缓存的输入 |
| `cacheReadTokens` | 命中缓存读到的输入 |
| `cacheWriteTokens` | 写入缓存的输入 |
| `outputTokens` | 输出 |

这四个桶正好对应官方价目表的分档，所以金额是纯乘法。token 数不重复记账：轮节点的 `tokenUsage` 和
宿主投影都已经是「真实收过费的量」，插件只做乘法。

**它不含模型名**：模型只在每轮节点的 `tokenUsage.routes` 里。所以单价由下面的常量价目表决定，
模型名只用于悬停提示（中途换过模型时，那里显示的是最近一次的模型）。

## 单价从哪来（2026-11-06 修订）

官方价目（来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>，单位：元 / 百万 token）：

| 档位 | 空闲时段 | 高峰时段 |
|---|---|---|
| 输入（缓存命中） | 0.02 | 0.04 |
| 输入（缓存未命中） | 1 | 2 |
| 输出 | 4 | 8 |

**空闲时段价格是高峰时段的一半**，所以代码里只存空闲价，高峰乘 2：

```js
const PRICES = {
  flash:  { tag: 'DeepSeek V4.1-Flash 官方价', input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
  v32:    { tag: 'DeepSeek V3.2 官方价（2025-09-05 起）', input: 2, cacheRead: 0.2, cacheWrite: 2, output: 3 },
  legacy: { tag: 'DeepSeek 旧价（2025-09-05 之前）',      input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }
}
const ACTIVE = PRICES.flash   // ← 换价改这一行
const PEAK_FACTOR = 2         // 高峰 = 空闲 × 2
```

官方没有「缓存写入」这一档：写进缓存的那部分本来就按未命中计价，所以 `cacheWrite = input`。

> 曾经走过一次弯路：第一版抄了 V3.2 的价（缓存命中 ¥0.2/M），显示比真实扣费高约 7 倍；
> 后来又想按账本反推出一套「校准价」，其实反推出来的正是**空闲时段**价（因为我们几乎都在夜里跑）。
> 现在直接写官方价，账本只用来验证。

改价需要重启 DSH —— 客户端 bundle 在启动时组合，不会热更。

## 金额格式的取舍

- 小于 1 元保留 4 位小数：这个量级下 2 位小数会被四舍五入吃光（0.0043 会显示成 0.00）。
- 小于 0.0001 元显示 `<0.0001`，而不是 `0.0000`，避免看起来像没花钱。
- 投影还没数据时渲染 `花费 ¥—`，而不是什么都不画：这样能一眼分清「插件没加载」和「还没用量」。

## 装法（本机）

1. 源码放 `${DSH_HOME}\profiles\desktop\plugins\dsh-usage-cost\`。
2. profile 的 `package.json` 里登记：
   - `dependencies`: `"dsh-usage-cost": "file:plugins/dsh-usage-cost"`
   - `dsh.profile.bundles`: 加一项 `"dsh-usage-cost"`
3. 建链接：`New-Item -ItemType Junction -Path node_modules\dsh-usage-cost -Target plugins\dsh-usage-cost`
4. 重启 DSH。本包自带 `cordis.patch.yml`，组合包会按裸包名 `dsh-usage-cost` 把自己插进去，
   所以**不要**再往 profile 的 `cordis.patch.yml` 里写一条 insert（挂两遍）。
5. 验证：设置里的插件列表出现「用量计费」；输入框下方多出「花费 ¥…」。

## 测试

```bash
node test/cost.test.mjs        # 浏览器包：算钱、格式、搬迁位置（15 条）
node test/projection.test.mjs  # 宿主投影 + 两份价目表一致性（9 条）
```

`client.js` 是浏览器包，测试用假的 `window.__ModuleLoader__` 把 factory 抓出来直接调，
不需要浏览器也不需要 React 渲染。覆盖：四桶单价映射、命中缓存与未命中不能串价、空数据不算钱、
金额格式、悬停明细文案、模型名提取、插槽登记（id/order/清理函数）、峰谷时段边界（08:59/09:00/12:00/
14:00/17:59/18:00、周六、国庆）、高峰翻倍、逐轮按各自时段结算、`¥` 嵌进徽标且幂等。

`projection.test.mjs` 额外做两件事：把宿主 `fold` 的替换/去重/重试语义各测一遍；再用同一批样本
（4 个时间点 × 3 组用量）比对 `client.js` 与 `src/pricing.mjs` 的结果 —— 两份计价代码不能互相
import（浏览器包拿不到 Node 模块），只能靠这条断言看守漂移。

## 位置：嵌进「用量」那一项里面

插槽只有 `conversation.chat.assistant-actions`，产物落在图标排的 `extraActions` 位（复制图标之前），
拿不到「用量 13.1M tok」内部的插槽。所以挂载后自己搬：

1. 从自己所在的节点向上最多四层，找「文字里同时有**用量**和 **tok**」的最深元素（就是那枚徽标）；
2. `badge.appendChild(el)` —— 变成徽标里的第二段文字，而不是旁边的另一枚；
3. `MutationObserver({ childList: true, subtree: true })` 盯着，宿主重渲染把它删了就再塞一次；
   判断「我已经在里面」时用 `textContent` 减去自己那段，避免自我污染导致反复搬运。

样式 `.duc_inline`：`margin-left:10px`（和「用量 13.1M tok」拉开距离）、字号与颜色**完全继承徽标**、
无背景无边框，也不写「花费」二字 —— 看上去就是 `用量 6.8M tok ¥0.23` 一整项。

## 峰谷时段：官方口径

- **高峰**：北京时间**周一至周五**的 **9:00–12:00**、**14:00–18:00**（不含中国法定节假日）。
- **空闲**：其余全部时间 —— 含**周末**、**法定节假日**全天、以及工作日的夜里。

所以凌晨跑便宜、工作日下午跑贵，而「周末白天」反而算空闲。代码里：

```js
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]   // 当天第几分钟起、至
const CN_HOLIDAYS = new Set(['2026-10-01', ...])                // 只列法定节假日，调休上班日不算
```

- `beijingParts(when)`：把时间戳换成北京时间的日期/星期/分钟数，**不依赖本机时区**。
- `isPeakAt(when)`：周末或节假日 → 空闲；工作日落在窗口内 → 高峰；**时间缺失或非法一律按高峰**（宁可估高）。
- `priceAt(when)`：高峰把四档单价整体乘 `PEAK_FACTOR`，并把 `tag` 标成 `…·高峰时段` / `…·空闲时段（半价）`。
- 消息行用**这一轮自己的时间戳**取价；会话累计由宿主投影 `usageCost` 逐事件按各自时段的价结算后折叠（退路才是浏览器按已加载轮次求和）。

对账（`probes/verify-peak-pricing.mjs`，本会话 1387 个样本 / 407.6M token，其中 96.9% 落在空闲时段）：

| 日期 | 本插件 | 真实账本 |
|---|---|---|
| 11-03 | ¥1.84 | ¥2.28 |
| 11-04 | ¥7.66 | ¥11.29 |
| 11-05 | ¥0.96 | ¥0.96 |
| 11-06 | ¥3.24 | ¥3.10 |

11-05 几乎完全一致（那天只有本会话在花钱）；11-03/11-04 偏低是因为账本是**账号级**的，别的会话也在扣。
同一份用量若全按高峰算会是 ¥26.68，比实际高一倍。

## 已知边界

- 只统计**本会话**，不含子代理的独立会话（它们的 usage 记在自己的会话里）。
- 计费口径以宿主上报的 usage 为准；如果网关/中转不返回 usage，这里会一直显示 0。
- 缓存写入在 DeepSeek 官方价里不单独收费，这里按未命中价计。

## 排障开关

宿主半边默认只写两行日志到 `.activity.log`：`apply …` 与 `register-ok usageCost`。

要复现「会话是不是被完整折叠」，启动 DSH 前设 `DSH_USAGE_COST_DEBUG=1`，
`fold` 会每 200 条结算打一行（turns / tokens / cost）。平时不开，避免刷屏。
