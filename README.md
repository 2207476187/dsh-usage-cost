# dsh-usage-cost

给 DeepSeek Harness 的「Token 用量」加上**钱**。

- 每条回复底部的操作行里，「用量 5.1M tok」后面直接跟本次轮次的金额：`¥0.03`；
- 输入框下方那排药丸里显示**整个会话**的花费：`花费 ¥15.23`。

金额按 DeepSeek 官方峰谷口径计算（空闲价为高峰价的一半，高峰 = 工作日 9:00–12:00、14:00–18:00 北京时间，不含法定节假日）。

## 为什么需要它

Harness 内置的 `UsagePill` 只显示 token 数。要换算成钱，有两个坑：

1. **token 数分四个计费桶**：未命中缓存的输入、命中缓存、写缓存、输出，单价不同（缓存命中便宜 50 倍）；
2. **会话级合计不能由浏览器算**：客户端只物化最近若干轮，往上翻聊天会加载更多轮，浏览器加出来的「会话花费」会随滚动变大。

第 2 点是这个插件必须分两半的原因：宿主半边在事件流上折叠出整会话的账，浏览器半边只负责显示。

## 两个半边

| 文件 | 跑在哪 | 干什么 |
|---|---|---|
| `src/index.mjs` | 宿主（Node） | 注册 session projection `usageCost`，逐事件按当时时段计价、按 `(turn, step)` 替换式累加 |
| `src/pricing.mjs` | 宿主 | 价目表、峰谷判断、金额计算（纯函数） |
| `client.js` | 浏览器 | 两个插槽组件：消息行的本轮金额、composer dock 的会话金额 |
| `test/*.test.mjs` | — | 26 条断言，含「两份价目表必须一致」的对账 |

浏览器包与宿主模块没法互相 `import`，所以价目表在两处各存一份，由 `test/projection.test.mjs` 里的一致性用例看守（含节假日集合对账）。

## 装法

```bash
dsh plugin --profile desktop add "github:2207476187/dsh-usage-cost#main"
```

手工装（本机验证过的一种）：

1. 源码放 `${DSH_HOME}\profiles\desktop\plugins\dsh-usage-cost\`；
2. profile 的 `package.json` 里加依赖 `"dsh-usage-cost": "file:plugins/dsh-usage-cost"`，并把 `dsh-usage-cost` 加进 `dsh.profile.bundles`；
3. `node_modules` 下建一个 junction 指过去（或 `pnpm install`）；
4. 重启 DSH。

插件靠自己的 `cordis.patch.yml` 插入（`insert: [{ id: dsh-usage-cost, name: 'dsh-usage-cost' }]`，裸包名——相对路径会相对 profile 解析，指不到 `src`）。

## 数据来源（三级）

1. **宿主投影 `usageCost`**（首选）：整个会话的历史事件流折叠，与加载窗口无关；
2. 客户端按已加载轮次求和（退路，金额会随滚动变大，只在投影未就绪时用）；
3. `tokenUsage` 投影 × 当前时段单价（最后退路）。

## 价目表

```js
PRICES.flash = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }  // 元/百万 token，空闲价
PEAK_FACTOR = 2                                                          // 高峰 = 空闲 × 2
```

改价只需要改 `src/pricing.mjs` 与 `client.js` 两处（并同步 `PRICES` 的 `tag`），一致性用例会自动守住。

## 排障

宿主半边默认只往 `.activity.log` 写两行（`apply` 与 `register-ok usageCost`）。要确认「会话是否被完整折叠」，启动前设 `DSH_USAGE_COST_DEBUG=1`，`fold` 会每 200 条结算打一行。

## 已知边界

- 一条回复里若既有高峰又有空闲的结算（跨时段重试），按每次结算各自的时间取价，不会四舍五入成整轮的平均价；
- `reasoning` 等不产生 `assistant/message` 的调用不计费；
- 金额是**估算**，与账号余额差可能有个位数百分比差异（同一次请求里工具调用、重试策略会影响实际扣费）。

## 许可

MIT
