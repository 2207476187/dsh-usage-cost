/**
 * 计价内核（宿主侧）。
 *
 * 为什么宿主侧要单独来一份：面板上的「本会话花费」不能靠浏览器算 —— 客户端只物化最近若干轮，
 * 往上翻才会把更早的轮加载进来，于是浏览器算出来的「会话累计」会随着滚动变大。正确的数据源是
 * 宿主的 session projection（见 `src/index.mjs`），而 folding 发生在 Node 里，所以价目表和
 * 「某个时刻算高峰还是空闲」这套判断必须在这里也有一份。
 *
 * 浏览器那份在 `client.js` 顶部（同一套常量、同一个算法）。两份不能互相 import：client.js 是
 * 被打包成 `/plugins/…/client.js` 直接喂给浏览器的，拿不到 Node 模块。防止两边漂移的办法是
 * `test/cost.test.mjs` 里那条一致性断言 —— 它对同一批样本比较两边的结果。
 */

/** 计费单位：官方价目表按「每百万 token」给。 */
export const UNIT = 1e6

/**
 * 官方价目表（2026-11 修订，来源：api-docs.deepseek.com/zh-cn/quick_start/pricing）。
 * 这里填的是**空闲时段**价，高峰时段由 `PEAK_FACTOR` 翻倍得到。
 * 官方口径没有「缓存写入」这一档；写进缓存的那部分按未命中计价，所以 cacheWrite = input。
 */
export const PRICES = {
	flash: { tag: 'DeepSeek V4.1-Flash 官方价', input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
	v32: { tag: 'DeepSeek V3.2 官方价（2025-09-05 起）', input: 2, cacheRead: 0.2, cacheWrite: 2, output: 3 },
	legacy: { tag: 'DeepSeek 旧价（2025-09-05 之前）', input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }
}

/** 当前生效的价目表 —— 换价改这一行（client.js 里也要同步改）。 */
export const ACTIVE = PRICES.flash

/** 高峰 = 空闲 × 2（官方：空闲时段价格为高峰的一半）。 */
export const PEAK_FACTOR = 2

/** 北京时间相对 UTC 的偏移（分钟）。 */
export const BEIJING_OFFSET_MINUTES = 8 * 60

/** 高峰时段（北京时间，当天第几分钟起、至）：周一至周五 9:00–12:00、14:00–18:00。 */
export const PEAK_WINDOWS = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60]
]

/** 中国法定节假日（`YYYY-MM-DD`，北京时间）。节假日全天按空闲计价。 */
export const CN_HOLIDAYS = new Set([
	'2026-01-01',
	'2026-01-02',
	'2026-01-03',
	'2026-02-15',
	'2026-02-16',
	'2026-02-17',
	'2026-02-18',
	'2026-02-19',
	'2026-02-20',
	'2026-02-21',
	'2026-04-04',
	'2026-04-05',
	'2026-04-06',
	'2026-05-01',
	'2026-05-02',
	'2026-05-03',
	'2026-05-04',
	'2026-05-05',
	'2026-06-19',
	'2026-06-20',
	'2026-06-21',
	'2026-09-25',
	'2026-09-26',
	'2026-09-27',
	'2026-10-01',
	'2026-10-02',
	'2026-10-03',
	'2026-10-04',
	'2026-10-05',
	'2026-10-06',
	'2026-10-07'
])

/**
 * 把时间戳换成北京时间的日历字段（不依赖本机时区）。
 * @param {number} when 毫秒时间戳。
 * @returns {{date: string, weekday: number, minute: number}} 日期、星期（0=周日）、当天第几分钟。
 */
export function beijingParts(when) {
	const shifted = new Date(when + BEIJING_OFFSET_MINUTES * 60_000)
	const year = shifted.getUTCFullYear()
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
	const day = String(shifted.getUTCDate()).padStart(2, '0')
	return {
		date: `${year}-${month}-${day}`,
		weekday: shifted.getUTCDay(),
		minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
	}
}

/**
 * 某个时刻是否落在高峰时段。
 * @param {number} when 毫秒时间戳；非法或缺失按高峰处理（宁可估高）。
 * @returns {boolean} true 表示高峰。
 */
export function isPeakAt(when) {
	if (typeof when !== 'number' || !Number.isFinite(when) || when <= 0) return true
	const { date, weekday, minute } = beijingParts(when)
	if (CN_HOLIDAYS.has(date)) return false
	if (weekday === 0 || weekday === 6) return false
	return PEAK_WINDOWS.some(([from, to]) => minute >= from && minute < to)
}

/**
 * 取某个时刻生效的价目表。
 * @param {number} when 毫秒时间戳。
 * @param {typeof ACTIVE} [base] 基准价（默认 `ACTIVE`，填的是空闲价）。
 * @returns {object} 带 `peak` / `tag` 的价目表。
 */
export function priceAt(when, base = ACTIVE) {
	const peak = isPeakAt(when)
	if (!peak) return { ...base, peak: false, tag: `${base.tag}·空闲时段（半价）` }
	return {
		...base,
		peak: true,
		input: base.input * PEAK_FACTOR,
		cacheRead: base.cacheRead * PEAK_FACTOR,
		cacheWrite: base.cacheWrite * PEAK_FACTOR,
		output: base.output * PEAK_FACTOR,
		tag: `${base.tag}·高峰时段`
	}
}

/**
 * 一个非负数，非法值当 0。
 * @param {unknown} value 待检查的值。
 * @returns {number} 非负有限数。
 */
export function count(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 把 provider 上报的 usage 归一成四个计费桶（与 `tokenUsage` 投影同口径）。
 * @param {unknown} usage `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }`。
 * @returns {{uncachedInputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number}} 四个桶。
 */
export function bucketsFrom(usage) {
	const source = usage === null || typeof usage !== 'object' ? {} : usage
	return {
		uncachedInputTokens: count(source.inputTokens),
		outputTokens: count(source.outputTokens),
		cacheReadTokens: count(source.cacheReadTokens),
		cacheWriteTokens: count(source.cacheWriteTokens)
	}
}

/**
 * 按四个计费桶算钱。
 * @param {unknown} usage 四个桶（字段名同 `bucketsFrom` 的输出）。
 * @param {{input: number, cacheRead: number, cacheWrite: number, output: number}} [price] 价目表。
 * @returns {{uncached: number, cacheRead: number, cacheWrite: number, output: number, inputCost: number, cacheReadCost: number, cacheWriteCost: number, outputCost: number, total: number, tokens: number}} 明细。
 */
export function costOf(usage, price = ACTIVE) {
	const source = usage === null || typeof usage !== 'object' ? {} : usage
	const uncached = count(source.uncachedInputTokens)
	const cacheRead = count(source.cacheReadTokens)
	const cacheWrite = count(source.cacheWriteTokens)
	const output = count(source.outputTokens)
	const inputCost = (uncached / UNIT) * price.input
	const cacheReadCost = (cacheRead / UNIT) * price.cacheRead
	const cacheWriteCost = (cacheWrite / UNIT) * price.cacheWrite
	const outputCost = (output / UNIT) * price.output
	return {
		uncached,
		cacheRead,
		cacheWrite,
		output,
		inputCost,
		cacheReadCost,
		cacheWriteCost,
		outputCost,
		total: inputCost + cacheReadCost + cacheWriteCost + outputCost,
		tokens: uncached + cacheRead + cacheWrite + output
	}
}
