/**
 * client.js 的纯函数测试。
 *
 * client.js 是浏览器包，用 `window.__ModuleLoader__.load({ id, factory })` 注册自己 ——
 * 这里把 window 换成假的，把 factory 抓出来直接调，于是不需要浏览器、不需要 React 渲染，
 * 也能验证「按桶算钱」这部分真正会算错的地方（单价映射、四舍五入、空数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

/** 极简 React 元素替身：只保留 type 与 props，够断言。 */
const element = (type, props) => ({ type, props })

let plugin = null
globalThis.window = {
	__ModuleLoader__: {
		load({ id, factory }) {
			const require = (name) => {
				if (name === 'react') {
					// 只有两个基础 hook 被用到；测试不真渲染，给空实现即可。
					return { useRef: (initial) => ({ current: initial }), useEffect: () => {} }
				}
				if (name === 'react/jsx-runtime') {
					return { jsx: element, jsxs: element, Fragment: 'Fragment' }
				}
				throw new Error(`client.js 请求了没预料到的模块：${name}`)
			}
			plugin = { id, exports: factory(require) }
		}
	}
}

await import(new URL('../client.js', import.meta.url).href)

const { costOf, formatMoney, breakdownText, latestModel, ACTIVE, PRICES, PEAK_FACTOR } = plugin.exports.__test

test('注册的插件 id 是 dsh-usage-cost', () => {
	assert.equal(plugin.id, 'dsh-usage-cost')
	assert.equal(typeof plugin.exports.apply, 'function')
})

test('四个计费桶按各自的单价折算（用 V3.2 价目表验算术）', () => {
	const cost = costOf(
		{
			uncachedInputTokens: 1e6,
			cacheReadTokens: 1e6,
			cacheWriteTokens: 1e6,
			outputTokens: 1e6
		},
		PRICES.v32
	)
	assert.equal(cost.inputCost, 2)
	assert.equal(cost.cacheReadCost, 0.2)
	assert.equal(cost.cacheWriteCost, 2)
	assert.equal(cost.outputCost, 3)
	assert.equal(Number(cost.total.toFixed(6)), 7.2)
	assert.equal(cost.tokens, 4e6)
})

test('命中缓存的输入按缓存价，不是按未命中价', () => {
	// 只给缓存命中 1M：旧价 0.5、新价 0.2，两者必须能被区分开才说明映射没串。
	const cached = costOf({ cacheReadTokens: 1e6 })
	assert.equal(Number(cached.total.toFixed(6)), ACTIVE.cacheRead)
	const missed = costOf({ uncachedInputTokens: 1e6 })
	assert.equal(Number(missed.total.toFixed(6)), ACTIVE.input)
	assert.notEqual(cached.total, missed.total)
})

test('空值、缺字段、负数、非数字都不算钱', () => {
	for (const usage of [undefined, null, {}, { uncachedInputTokens: -5 }, { outputTokens: 'abc' }]) {
		const cost = costOf(usage)
		assert.equal(cost.total, 0)
		assert.equal(cost.tokens, 0)
	}
})

test('金额格式：小额 4 位、大额 2 位、极小值不显示成 0', () => {
	assert.equal(formatMoney(0), '0')
	assert.equal(formatMoney(0.00001), '<0.0001')
	assert.equal(formatMoney(0.0834), '0.0834')
	assert.equal(formatMoney(1.2345), '1.23')
	assert.equal(formatMoney(1234.5), '1,234.50')
	assert.equal(formatMoney(Number.NaN), '0')
})

test('悬停明细逐档写清 token 数、单价与金额', () => {
	// 显式拿 v32 这张表来断言数字，避免以后调价把这条用例带崩（调价该测的是 costOf 的算术）。
	const cost = costOf({ uncachedInputTokens: 1234, cacheReadTokens: 5000, outputTokens: 678 }, PRICES.v32)
	const text = breakdownText(cost, PRICES.v32, 'deepseek/deepseek-chat')
	assert.match(text, /未命中缓存输入 1,234 × ¥2/)
	assert.match(text, /命中缓存输入 5,000 × ¥0\.2/)
	assert.match(text, /输出 678 × ¥3/)
	assert.match(text, /合计 ¥/)
	assert.match(text, /模型 deepseek\/deepseek-chat/)
})

test('模型名取自最近一轮的 routes，没有就返回空串', () => {
	const snapshot = {
		nodes: new Map([
			['a', { kind: 'turn-tail', data: { tokenUsage: { routes: [{ provider: 'deepseek', model: 'old' }] } } }],
			['b', { kind: 'tool-call', data: {} }],
			['c', { kind: 'turn-tail', data: { tokenUsage: { routes: [{ provider: 'deepseek', model: 'deepseek-chat' }] } } }]
		])
	}
	assert.equal(latestModel(snapshot), 'deepseek/deepseek-chat')
	assert.equal(latestModel({ nodes: new Map() }), '')
	assert.equal(latestModel(undefined), '')
})

test('apply 把药丸登记进「消息操作行」与 composer dock，且不顶掉宿主条目', () => {
	const effects = []
	const registered = []
	const slots = []
	const ctx = {
		effect(run) {
			effects.push(run())
		},
		slots: {
			inject(name, body) {
				slots.push(name)
				body()
			},
			register(options, component) {
				registered.push({ options, component })
			}
		}
	}
	globalThis.document = {
		createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
		head: { appendChild() {} }
	}
	plugin.exports.apply(ctx)

	// 主位是消息操作行（紧跟在「用量」徽标后），副位是输入框下方那排药丸。
	assert.deepEqual(slots, ['conversation.chat.assistant-actions', 'conversation.composer.dock'])
	assert.equal(registered.length, 2)
	assert.equal(registered[0].options.name, 'conversation.chat.assistant-actions')
	assert.equal(registered[0].options.id, 'usage-cost')
	assert.equal(registered[1].options.id, 'usage-cost')
	assert.equal(registered[1].options.order, 2)
	// 样式注入必须登记了清理函数，否则插件卸载后 <style> 会留在页面上。
	assert.equal(typeof effects[0], 'function')

	const pill = registered[1].component
	const props = (usage) => ({ useProjection: () => usage, useChat: () => '' })
	// 投影还没就绪时也占位：排障时要能区分「没加载」与「还没数据」。
	const empty = pill(props(undefined))
	assert.equal(empty.props['data-composer-stat'], 'usage-cost')
	assert.match(JSON.stringify(empty), /花费 ¥—/)
	// 零用量照常渲染，金额是 0 而不是空白。
	assert.match(JSON.stringify(pill(props({}))), /花费 ¥0"/)
	// 有量时给出药丸与明细提示（金额跟着当前价目表走，不写死数字）。
	const view = pill(props({ uncachedInputTokens: 1e6 }))
	assert.equal(view.props['data-composer-stat'], 'usage-cost')
	assert.match(view.props.title, /合计 ¥/)
	// 没有轮节点时按「当前时段」估：凌晨跑是谷段价、白天跑是峰段价，两个都得接受。
	const peakMoney = ACTIVE.input * PEAK_FACTOR
	const idleMoney = ACTIVE.input
	assert.match(
		view.props.title,
		new RegExp(`未命中缓存输入 1,000,000 × ¥(?:${peakMoney}|${idleMoney}) = ¥`)
	)
	assert.match(JSON.stringify(view), new RegExp(`花费 ¥(?:${peakMoney}|${idleMoney})`))
})

test('消息操作行的花费只算这一轮，拿不到这一轮的用量就不渲染', () => {
	const { turnUsageOf } = plugin.exports.__test
	const snapshot = {
		nodes: new Map(
			[
				[
					'a',
					{
						kind: 'turn-tail',
						data: {
							closing: { finalNode: { seq: 1, messageId: 'm1' } },
							tokenUsage: {
								uncachedInputTokens: 1e6,
								outputTokens: 1e6,
								routes: [{ provider: 'deepseek', model: 'deepseek-chat' }]
							}
						}
					}
				]
			]
		)
	}
	assert.equal(turnUsageOf(snapshot, 'm1').model, 'deepseek/deepseek-chat')
	assert.equal(turnUsageOf(snapshot, 'm2'), undefined)
	// 这一轮没有任何用量记录（例如被中断）时也不渲染，避免出现空的「花费 —」。
	assert.equal(
		turnUsageOf(
			{ nodes: new Map([['a', { kind: 'turn-tail', data: { closing: { finalNode: { messageId: 'm3' } } } }]]) },
			'm3'
		),
		undefined
	)
})

test('ctx 里没有 slots 时不留白屏，而是走可见的失败提示', () => {
	globalThis.document = {
		createElement: () => ({ dataset: {}, textContent: '', style: {}, remove() {} }),
		head: { appendChild() {} },
		body: { appendChild: (node) => assert.match(node.textContent, /ctx\.slots 不可用/) }
	}
	// 不抛错即可：这条路径的全部目的就是「坏掉也要留下来过的痕迹」。
	plugin.exports.apply({ effect() {}, slots: undefined })
})

/** 极简 DOM 节点：只实现搬节点用到的那些关系。 */
function fakeNode(name, textContent = '') {
	return {
		name,
		textContent,
		children: [],
		parentElement: null,
		get firstElementChild() {
			return this.children[0] ?? null
		},
		get lastElementChild() {
			return this.children.at(-1) ?? null
		},
		get previousElementSibling() {
			const parent = this.parentElement
			if (parent === null) return null
			const index = parent.children.indexOf(this)
			return index > 0 ? parent.children[index - 1] : null
		},
		appendChild(child) {
			child.parentElement = this
			this.children.push(child)
			return child
		},
		insertBefore(child, reference) {
			child.parentElement = this
			const index = reference === null ? this.children.length : this.children.indexOf(reference)
			this.children.splice(index, 0, child)
			return child
		},
		contains(node) {
			if (node === this) return true
			return this.children.some((child) => child.contains(node))
		}
	}
}

test('「花费」被搬到「用量」徽标右边，且重复执行不会乱序', () => {
	const { placeNextToUsageBadge } = plugin.exports.__test
	// 行结构：…图标 | 花费(我, 插槽给的 extraActions 位置) | endInfo[用量, 时间]
	const badge = fakeNode('usage', '用量 5.1M tok')
	const clock = fakeNode('time', '00:33')
	const endInfo = fakeNode('endInfo', '用量 5.1M tok 00:33')
	endInfo.appendChild(badge)
	endInfo.appendChild(clock)
	const row = fakeNode('row')
	row.appendChild(fakeNode('copy'))
	row.appendChild(fakeNode('like'))
	const mine = fakeNode('cost', '花费 ¥0.03')
	row.appendChild(mine)
	row.appendChild(endInfo)

	placeNextToUsageBadge(mine)
	// 现在不是排在徽标旁边，而是成为徽标内部的第二段文字。
	assert.deepEqual(
		badge.children.map((child) => child.name),
		['cost']
	)
	assert.deepEqual(
		endInfo.children.map((child) => child.name),
		['usage', 'time']
	)
	// 幂等：宿主重渲染后再跑一次，位置不变、也不会重复插入。
	placeNextToUsageBadge(mine)
	assert.deepEqual(
		badge.children.map((child) => child.name),
		['cost']
	)
	// 没有父节点时静默返回，不抛错。
	placeNextToUsageBadge(fakeNode('orphan'))
	placeNextToUsageBadge(null)
})

test('「用量 + 时间」比我更晚渲染时，先不搬，等它出现再搬', () => {
	const { placeNextToUsageBadge } = plugin.exports.__test
	const row = fakeNode('row')
	row.appendChild(fakeNode('copy'))
	const mine = fakeNode('cost', '花费 ¥0.03')
	row.appendChild(mine)

	// 第一次调用时 endInfo 还没渲染：什么都不该发生，也不该抛错。
	placeNextToUsageBadge(mine)
	assert.equal(row.children.length, 2)

	const badge = fakeNode('usage', '用量 5.1M tok')
	const clock = fakeNode('time', '00:33')
	const endInfo = fakeNode('endInfo', '用量 5.1M tok 00:33')
	endInfo.appendChild(badge)
	endInfo.appendChild(clock)
	row.appendChild(endInfo)

	// 宿主补上之后（真实环境由 MutationObserver 触发），再搬一次就到位。
	placeNextToUsageBadge(mine)
	assert.deepEqual(
		badge.children.map((child) => child.name),
		['cost']
	)
})

test('高峰判断：工作日 9:00-12:00 / 14:00-18:00 才算高峰，周末与节假日全天空闲', () => {
	const { isPeakAt } = plugin.exports.__test
	const at = (iso) => Date.parse(iso)
	// 2026-11-06 是周五
	assert.equal(isPeakAt(at('2026-11-06T08:59:00+08:00')), false)
	assert.equal(isPeakAt(at('2026-11-06T09:00:00+08:00')), true)
	assert.equal(isPeakAt(at('2026-11-06T11:59:00+08:00')), true)
	assert.equal(isPeakAt(at('2026-11-06T12:00:00+08:00')), false)
	assert.equal(isPeakAt(at('2026-11-06T14:00:00+08:00')), true)
	assert.equal(isPeakAt(at('2026-11-06T17:59:00+08:00')), true)
	assert.equal(isPeakAt(at('2026-11-06T18:00:00+08:00')), false)
	assert.equal(isPeakAt(at('2026-11-06T03:00:00+08:00')), false)
	// 周末：2026-11-07 周六、11-08 周日
	assert.equal(isPeakAt(at('2026-11-07T10:00:00+08:00')), false)
	assert.equal(isPeakAt(at('2026-11-08T15:00:00+08:00')), false)
	// 节假日：2026-10-01 国庆（周四）
	assert.equal(isPeakAt(at('2026-10-01T10:00:00+08:00')), false)
	// 时间缺失/非法按高峰（宁可估高）
	assert.equal(isPeakAt(0), true)
	assert.equal(isPeakAt(Number.NaN), true)
	assert.equal(isPeakAt(undefined), true)
})

test('取价：高峰 = 空闲价 × 2，tag 写明是哪一段', () => {
	const { priceAt, ACTIVE, PEAK_FACTOR } = plugin.exports.__test
	const peak = priceAt(Date.parse('2026-11-06T14:00:00+08:00'))
	const idle = priceAt(Date.parse('2026-11-06T03:00:00+08:00'))
	assert.equal(peak.peak, true)
	assert.equal(Number(peak.cacheRead.toFixed(6)), Number((ACTIVE.cacheRead * PEAK_FACTOR).toFixed(6)))
	assert.match(peak.tag, /高峰/)
	assert.equal(idle.peak, false)
	assert.equal(idle.cacheRead, ACTIVE.cacheRead)
	assert.match(idle.tag, /空闲/)
})

test('会话累计按每轮各自的时段结算：高峰 + 空闲', () => {
	const { sessionCostOf, costOf, ACTIVE, PEAK_FACTOR } = plugin.exports.__test
	const usage = { uncachedInputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
	const snapshot = {
		nodes: new Map([
			['a', { kind: 'turn-tail', time: Date.parse('2026-11-06T14:00:00+08:00'), data: { tokenUsage: usage } }],
			['b', { kind: 'turn-tail', time: Date.parse('2026-11-06T03:00:00+08:00'), data: { tokenUsage: usage } }]
		])
	}
	const summary = sessionCostOf(snapshot)
	assert.equal(summary.turns, 2)
	assert.equal(summary.tokens, 2e6)
	assert.equal(summary.idleTokens, 1e6)
	const single = costOf(usage, ACTIVE).total
	const expected = single * (1 + PEAK_FACTOR)
	assert.equal(Number(summary.total.toFixed(6)), Number(expected.toFixed(6)))
	assert.equal(sessionCostOf({ nodes: new Map() }), undefined)
})

test('父容器自己也含「用量 … tok」时，仍然搬进更深的徽标（否则永远停在图标行）', () => {
	const { placeNextToUsageBadge } = plugin.exports.__test
	// 真实布局：图标行把「用量 + 时间」包在里面，于是**父节点本身**的文字也含「用量 … tok」。
	// 旧实现先判「父节点是不是徽标」，一判为真就早退，节点永远停在图标行外面。
	const badge = fakeNode('usage', '用量 5.1M tok')
	const clock = fakeNode('time', '00:33')
	const endInfo = fakeNode('endInfo', '用量 5.1M tok 00:33')
	endInfo.appendChild(badge)
	endInfo.appendChild(clock)
	const actions = fakeNode('actions', '用量 5.1M tok 00:33')
	actions.appendChild(fakeNode('copy'))
	const mine = fakeNode('cost', '¥0.03')
	actions.appendChild(mine)
	actions.appendChild(endInfo)
	const row = fakeNode('row')
	row.appendChild(actions)

	placeNextToUsageBadge(mine)
	assert.deepEqual(
		badge.children.map((child) => child.name),
		['cost'],
		'应该进到最深的徽标里，而不是停在 actions 上'
	)
	assert.equal(mine.parentElement, badge, '直接父节点必须是那枚徽标')
})
