/**
 * dsh-usage-cost 的宿主半边。
 *
 * 它做两件事：
 * 1. 确认自己被加载（写一行 `.activity.log`）——浏览器的客户端包是**从宿主 Loader 的条目里扫出来的**，
 *    只有「已作为插件加载、且 package.json 声明了 `dsh.client`」的包才会被组合成 `/plugins/…/client.js`。
 * 2. 注册一个 session projection `usageCost`：在宿主里按事件流折叠出整个会话的花费。
 *
 * 为什么花费必须由宿主折叠、而不是浏览器自己加：客户端只物化最近若干轮消息，浏览器能看见的
 * `turn-tail` 节点是「当前已加载窗口」，往上翻会加载更多 —— 于是浏览器算出来的会话累计会随滚动
 * 慢慢变大。宿主投影是全会话事件流的一次折叠，与加载窗口无关。
 *
 * 计价口径（官方峰谷价）在 `./pricing.mjs` 里，与 `client.js` 顶部那份保持一致，由
 * `test/cost.test.mjs` 的一致性断言看守。
 */
import { appendFileSync } from 'node:fs'
import { z } from 'zod'

import { bucketsFrom, costOf, isPeakAt, priceAt } from './pricing.mjs'

/** 投影键：客户端 `useProjection('usageCost')` 读的就是它。 */
const KEY = 'usageCost'

/** 状态版本：同一 key 重复注册必须一致，改状态形状时才递增。 */
const STATE_VERSION = 1

/** 折叠进度日志开关（`DSH_USAGE_COST_DEBUG=1` 时打开，平时不写）。 */
const DEBUG = process.env.DSH_USAGE_COST_DEBUG === '1'

const bucketsSchema = z
	.object({
		uncachedInputTokens: z.number().int().nonnegative(),
		outputTokens: z.number().int().nonnegative(),
		cacheReadTokens: z.number().int().nonnegative(),
		cacheWriteTokens: z.number().int().nonnegative()
	})
	.strict()

/** 客户端能看到的视图：只有合计，没有中间状态。 */
const viewSchema = z
	.object({
		cost: z.number().nonnegative(),
		tokens: z.number().int().nonnegative(),
		idleTokens: z.number().int().nonnegative(),
		peakTokens: z.number().int().nonnegative(),
		turns: z.number().int().nonnegative()
	})
	.strict()

const lastSchema = z
	.object({
		turn: z.number().int(),
		step: z.number().int(),
		buckets: bucketsSchema,
		cost: z.number().nonnegative(),
		tokens: z.number().int().nonnegative(),
		idle: z.number().int().nonnegative(),
		peak: z.number().int().nonnegative()
	})
	.strict()

const stateSchema = z
	.object({
		cost: z.number().nonnegative(),
		tokens: z.number().int().nonnegative(),
		idleTokens: z.number().int().nonnegative(),
		peakTokens: z.number().int().nonnegative(),
		turns: z.number().int().nonnegative(),
		lastTurn: z.number().int(),
		last: lastSchema.nullable()
	})
	.strict()

/**
 * 从一条事件里取 provider 上报的 usage。
 *
 * 与 `tokenUsage` 投影同口径：`assistant/message` 可能直接带 `data.usage`，否则取流里最后一个
 * usage chunk（真实结算走的是流，`data.usage` 只是便捷字段）。
 * @param {any} event 会话事件。
 * @returns {any} provider usage，取不到返回 undefined。
 */
function usageOf(event) {
	const data = event?.data
	// 与内置 `tokenUsage` 投影逐字对齐：`data.usage` 只在 `assistant/message` 上采信，
	// `assistant/attempt` 一律看流里最后一段 usage。两边口径一致，「用量 5.1M tok」和
	// 「花费 ¥0.10」才不会各算各的。
	if (event?.type === 'assistant/message' && data?.usage !== undefined && data?.usage !== null) {
		return data.usage
	}
	const stream = data?.stream
	if (!Array.isArray(stream)) return undefined
	for (let index = stream.length - 1; index >= 0; index -= 1) {
		const chunk = stream[index]
		const usage = chunk?.usage ?? chunk?.data?.usage
		if (usage !== undefined && usage !== null) return usage
	}
	return undefined
}

/**
 * 事件时间（毫秒）。durable 日志里是数字；重放时也可能是 ISO 字符串。
 * @param {any} event 会话事件。
 * @returns {number} 毫秒时间戳，取不到返回 0（`priceAt` 会按高峰处理）。
 */
function whenOf(event) {
	const raw = event?.time ?? event?.data?.time
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw
	if (typeof raw === 'string') {
		const parsed = Date.parse(raw)
		if (Number.isFinite(parsed)) return parsed
	}
	return 0
}

/** 折叠计数器（只为日志节流）。 */
let foldCount = 0

const zeroState = () => ({
	cost: 0,
	tokens: 0,
	idleTokens: 0,
	peakTokens: 0,
	turns: 0,
	lastTurn: -1,
	last: null
})

/**
 * 投影初始化。`inheritedEventCount` 是「本次要重放的历史事件数」，它不为 0 说明宿主会补算历史。
 * @param {any} header 会话头。
 * @param {any} inheritedEventCount 历史事件数。
 * @returns {any} 初始状态。
 */
const initState = (header, inheritedEventCount) => {
	log(`init inherited=${String(inheritedEventCount ?? '?')}`)
	return zeroState()
}

/**
 * 折叠一条事件。
 *
 * 替换语义照抄 `tokenUsage` 投影：同一 `(turn, step)` 的重复结算不累加，只把上一份减掉再加新的一份，
 * 这样 `assistant/attempt` 重复上报同一批 token 时不会双算；`llm/retry-started` 关掉替换槽，
 * 让重试后的那次结算成为一次新的累加。
 * @param {any} state 当前状态。
 * @param {any} event 会话事件。
 * @returns {any} 新状态（不修改入参）。
 */
function fold(state, event) {
	if (event?.type === 'llm/retry-started') {
		const turn = Number(event.data?.turn)
		const step = Number(event.data?.step)
		if (state.last !== null && state.last.turn === turn && state.last.step === step) {
			return { ...state, last: null }
		}
		return state
	}
	if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return state
	const sample = usageOf(event)
	if (sample === undefined) return state

	const turn = Number(event.data?.turn)
	const step = Number(event.data?.step)
	if (!Number.isFinite(turn) || !Number.isFinite(step)) return state

	const buckets = bucketsFrom(sample)
	const previous = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : undefined
	if (previous !== undefined) {
		const same =
			previous.buckets.uncachedInputTokens === buckets.uncachedInputTokens &&
			previous.buckets.outputTokens === buckets.outputTokens &&
			previous.buckets.cacheReadTokens === buckets.cacheReadTokens &&
			previous.buckets.cacheWriteTokens === buckets.cacheWriteTokens
		if (same) return state
	}

	const when = whenOf(event)
	const priced = costOf(buckets, priceAt(when))
	const peak = isPeakAt(when)
	const idle = peak ? 0 : priced.tokens
	const peakTokens = peak ? priced.tokens : 0

	const dropCost = previous?.cost ?? 0
	const dropTokens = previous?.tokens ?? 0
	const dropIdle = previous?.idle ?? 0
	const dropPeak = previous?.peak ?? 0
	const turns = turn === state.lastTurn ? state.turns : state.turns + 1

	const next = {
		cost: Math.max(0, state.cost - dropCost + priced.total),
		tokens: Math.max(0, state.tokens - dropTokens + priced.tokens),
		idleTokens: Math.max(0, state.idleTokens - dropIdle + idle),
		peakTokens: Math.max(0, state.peakTokens - dropPeak + peakTokens),
		turns,
		lastTurn: turn,
		last: { turn, step, buckets, cost: priced.total, tokens: priced.tokens, idle, peak: peakTokens }
	}
	foldCount += 1
	// 折叠进度日志：只在 `DSH_USAGE_COST_DEBUG=1` 时打（排障用，平时刷屏）。
	if (DEBUG && foldCount % 200 === 1) {
		log(`fold#${foldCount} turns=${turns} tokens=${Math.round(next.tokens)} cost=${next.cost.toFixed(4)}`)
	}
	return next
}

/** 投影定义：交给 `ctx.sessionProjections.register`。 */
const definition = {
	key: KEY,
	stateVersion: STATE_VERSION,
	stateSchema,
	init: initState,
	apply: fold,
	wire: {
		viewSchema,
		view: (state) => ({
			cost: state.cost,
			tokens: state.tokens,
			idleTokens: state.idleTokens,
			peakTokens: state.peakTokens,
			turns: state.turns
		})
	}
}

/**
 * 留痕：证明宿主这一跳跑到了。写不进去不影响功能。
 * @param {string} line 一行日志（不含时间戳）。
 * @returns {void}
 */
function log(line) {
	try {
		appendFileSync(new URL('../.activity.log', import.meta.url), `${new Date().toISOString()} ${line}\n`)
	} catch {
		// 目录只读等情况忽略。
	}
}

function trace() {
	log(`apply ${import.meta.url}`)
}

export default {
	name: 'dsh-usage-cost',
	/** Cordis 只有在 inject 里声明的服务才允许通过 `ctx.<name>` 访问。 */
	inject: ['sessionProjections'],

	apply(ctx) {
		trace()
		/** 探测一个值，连「取属性时抛错」也要记下来。 */
		const probe = (read) => {
			try {
				return typeof read()
			} catch (error) {
				return `throw:${error?.message ?? 'unknown'}`
			}
		}
		const register = (registry) => {
			if (registry === undefined || registry === null || typeof registry.register !== 'function') {
				log(`register-skip registry=${probe(() => registry)}`)
				return
			}
			try {
				registry.register(definition)
				log('register-ok usageCost')
			} catch (error) {
				// 注册失败不能拖垮整个插件：客户端还有「按已加载轮次估算」的退路。
				log(`register-fail ${error?.message ?? String(error)}`)
				console.error('[dsh-usage-cost] 注册 usageCost 投影失败：', error)
			}
		}
		try {
			log(`ctx sessionProjections=${probe(() => ctx?.sessionProjections)} inject=${probe(() => ctx?.inject)}`)
			const service = probe(() => ctx?.sessionProjections) === 'object' ? ctx.sessionProjections : undefined
			if (service !== undefined && service !== null) {
				register(service)
				return
			}
			if (typeof ctx?.inject === 'function') {
				log('using ctx.inject for sessionProjections')
				ctx.inject(['sessionProjections'], (inner) => {
					log('inject fired')
					register(inner?.sessionProjections)
				})
				return
			}
			log('no sessionProjections service and no ctx.inject')
		} catch (error) {
			log(`apply-throw ${error?.message ?? String(error)}`)
		}
	}
}

/** Cordis 要求把依赖写进 inject，否则访问 ctx.sessionProjections 会抛
 * `cannot get property "sessionProjections" without inject`。 */
export const inject = ['sessionProjections']

/** 供单测使用的内部件（宿主模块不参与浏览器 bundle）。 */
export const __test = { definition, fold, usageOf, whenOf, zeroState, KEY, STATE_VERSION }
