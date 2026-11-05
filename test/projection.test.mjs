/**
 * 宿主投影 `usageCost` 与「两份价目表一致」的测试。
 *
 * 为什么单独一个文件：`cost.test.mjs` 只加载浏览器包（假 `window`），这里要同时加载 Node 侧的
 * `src/index.mjs`（带 zod）和 `src/pricing.mjs`，然后拿两边算同一批样本对答案。两份计价代码
 * 不能互相 import（浏览器包拿不到 Node 模块），所以只能靠这条一致性断言看守漂移。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import * as pricing from '../src/pricing.mjs'
import hostPlugin, { __test as host } from '../src/index.mjs'

/** 极简 React 元素替身。 */
const element = (type, props) => ({ type, props })

let client = null
globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			const require = (name) => {
				if (name === 'react') return { useRef: (initial) => ({ current: initial }), useEffect: () => {} }
				if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'Fragment' }
				throw new Error(`client.js 请求了没预料到的模块：${name}`)
			}
			client = { id, exports: factory(require) }
		}
	}
}

await import(new URL('../client.js', import.meta.url).href)

/**
 * 北京时间 → 毫秒时间戳。
 * @param {string} iso `2026-11-04T10:00` 这样的北京时间。
 * @returns {number} 毫秒时间戳。
 */
function beijing(iso) {
	const [date, clock] = iso.split('T')
	const [year, month, day] = date.split('-').map(Number)
	const [hour, minute] = clock.split(':').map(Number)
	return Date.UTC(year, month - 1, day, hour - 8, minute)
}

/** 一条「结算」事件。 */
const settlement = (turn, step, usage, at) => ({
	type: 'assistant/message',
	time: beijing(at),
	data: { turn, step, usage }
})

test('工作日的 9–12、14–18 是高峰，其余与周末、节假日是空闲', () => {
	// 2026-11-04 是周三。
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T09:00')), true)
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T08:59')), false)
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T12:00')), false)
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T14:00')), true)
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T17:59')), true)
	assert.equal(pricing.isPeakAt(beijing('2026-11-04T18:00')), false)
	assert.equal(pricing.isPeakAt(beijing('2026-11-07T10:00')), false, '周六全天空闲')
	assert.equal(pricing.isPeakAt(beijing('2026-10-01T10:00')), false, '国庆全天空闲')
	assert.equal(pricing.isPeakAt(0), true, '时间缺失按高峰估')
	assert.equal(pricing.isPeakAt(Number.NaN), true, '非法时间按高峰估')
})

test('高峰价 = 空闲价 × 2，且 tag 写明时段', () => {
	const idle = pricing.priceAt(beijing('2026-11-06T03:00'))
	const peak = pricing.priceAt(beijing('2026-11-04T10:00'))
	assert.equal(idle.peak, false)
	assert.equal(peak.peak, true)
	assert.equal(peak.input, idle.input * pricing.PEAK_FACTOR)
	assert.equal(peak.output, idle.output * pricing.PEAK_FACTOR)
	assert.match(peak.tag, /高峰/)
	assert.match(idle.tag, /空闲/)
})

test('投影把整会话折叠成一个合计：一峰一谷各一轮', () => {
	const usage = { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
	let state = host.zeroState()
	state = host.fold(state, settlement(1, 1, usage, '2026-11-06T03:00'))
	state = host.fold(state, settlement(2, 1, usage, '2026-11-04T10:00'))
	const view = host.definition.wire.view(host.definition.stateSchema.parse(state))

	// 空闲 1M 未命中 = ¥1；高峰 1M 未命中 = ¥2。
	assert.equal(Number(view.cost.toFixed(6)), 3)
	assert.equal(view.tokens, 2e6)
	assert.equal(view.turns, 2)
	assert.equal(view.idleTokens, 1e6)
	assert.equal(view.peakTokens, 1e6)
	host.definition.wire.viewSchema.parse(view)
})

test('同一 (turn, step) 重复上报新数字：替换而不是累加', () => {
	let state = host.zeroState()
	state = host.fold(state, settlement(1, 1, { inputTokens: 1e6, outputTokens: 0 }, '2026-11-06T03:00'))
	state = host.fold(state, settlement(1, 1, { inputTokens: 2e6, outputTokens: 0 }, '2026-11-06T03:00'))
	const view = host.definition.wire.view(state)
	assert.equal(Number(view.cost.toFixed(6)), 2, '第二次 2M 覆盖第一次 1M')
	assert.equal(view.tokens, 2e6)
	assert.equal(view.turns, 1)
})

test('同一 (turn, step) 上报完全相同的数字：状态原样返回', () => {
	const event = settlement(1, 1, { inputTokens: 1e6, outputTokens: 5 }, '2026-11-06T03:00')
	let state = host.fold(host.zeroState(), event)
	const before = state
	state = host.fold(state, event)
	assert.equal(state, before, '一模一样的一次上报不该产生新状态对象')
})

test('重试后同一 (turn, step) 再结算：算两次', () => {
	let state = host.zeroState()
	state = host.fold(state, settlement(1, 1, { inputTokens: 1e6, outputTokens: 0 }, '2026-11-06T03:00'))
	state = host.fold(state, { type: 'llm/retry-started', data: { turn: 1, step: 1 } })
	state = host.fold(state, settlement(1, 1, { inputTokens: 1e6, outputTokens: 0 }, '2026-11-06T03:00'))
	const view = host.definition.wire.view(state)
	assert.equal(Number(view.cost.toFixed(6)), 2)
	assert.equal(view.tokens, 2e6)
})

test('非结算事件不改变状态', () => {
	const state = host.zeroState()
	assert.equal(host.fold(state, { type: 'user/message', data: {} }), state)
	assert.equal(host.fold(state, { type: 'assistant/message', data: { turn: 1, step: 1 } }), state)
})

test('client.js 与 src/pricing.mjs 的计价结果完全一致', () => {
	const samples = [
		{ uncachedInputTokens: 1234567, cacheReadTokens: 8901234, cacheWriteTokens: 0, outputTokens: 45678 },
		{ uncachedInputTokens: 0, cacheReadTokens: 1e6, cacheWriteTokens: 0, outputTokens: 0 },
		{ uncachedInputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 }
	]
	const times = ['2026-11-04T10:00', '2026-11-06T03:00', '2026-11-07T10:00', '2026-10-01T15:00']
	for (const iso of times) {
		const at = beijing(iso)
		assert.equal(
			client.exports.__test.isPeakAt(at),
			pricing.isPeakAt(at),
			`${iso} 的峰谷判断两边必须一致`
		)
		const clientPrice = client.exports.__test.priceAt(at)
		const hostPrice = pricing.priceAt(at)
		assert.deepEqual(
			{ input: clientPrice.input, cacheRead: clientPrice.cacheRead, cacheWrite: clientPrice.cacheWrite, output: clientPrice.output },
			{ input: hostPrice.input, cacheRead: hostPrice.cacheRead, cacheWrite: hostPrice.cacheWrite, output: hostPrice.output },
			`${iso} 的价目两边必须一致`
		)
		for (const usage of samples) {
			const a = client.exports.__test.costOf(usage, clientPrice)
			const b = pricing.costOf(usage, hostPrice)
			assert.equal(a.total, b.total, `${iso} 的金额两边必须一致`)
			assert.equal(a.tokens, b.tokens)
		}
	}
	assert.equal(client.exports.__test.ACTIVE.tag, pricing.ACTIVE.tag, '两边 active 价目表必须是同一档')
})

test('宿主插件导出了投影定义，键名与版本稳定', () => {
	assert.equal(hostPlugin.name, 'dsh-usage-cost')
	assert.equal(host.KEY, 'usageCost')
	assert.equal(host.STATE_VERSION, 1)
	assert.equal(host.definition.key, host.KEY)
	assert.equal(host.definition.stateVersion, host.STATE_VERSION)
})

test('client.js 与 src/pricing.mjs 的法定节假日表完全一致', () => {
	const clientHolidays = [...client.exports.__test.CN_HOLIDAYS].sort()
	const hostHolidays = [...pricing.CN_HOLIDAYS].sort()
	assert.deepEqual(clientHolidays, hostHolidays, '两份节假日表必须一致，否则同一天两边的峰谷判断会不同')
})
