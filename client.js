/**
 * dsh-usage-cost 的浏览器半边：在输入框下方那排状态药丸里，紧挨着「Token 用量」加一枚
 * 「本次对话花费 ≈ ¥0.08」。
 *
 * 数据来源：会话级投影 `tokenUsage` —— 它只吐四个计费桶（未命中缓存的输入、命中缓存的输入、
 * 写入缓存的输入、输出），恰好就是官方价目表的分档，所以金额可以直接算，不需要重新累计事件。
 * 注意该投影**不含模型名**（模型信息只在每轮的 `tokenUsage.routes` 里），所以单价用下面的
 * 常量价目表决定，模型名只用来做提示文案的说明。
 *
 * 单价写死在这里是刻意的：DSH 没有价格表，官方调价也无法预知；想换价改 `PRICES` 与
 * `ACTIVE` 两个常量即可（README 里写了改哪一行）。
 */
const CURRENCY_SYMBOL = '¥'
/** 价目表单位：每百万 token 的单价（人民币元）。 */
const UNIT = 1e6

/**
 * 官方价目表（2026-11 修订，来源：api-docs.deepseek.com/zh-cn/quick_start/pricing）。
 * 字段与投影的四个计费桶一一对应；这里填的是**空闲时段**价，高峰时段由 PEAK_FACTOR 翻倍得到。
 * 官方口径没有「缓存写入」这一档，写进缓存的那部分本来就按未命中计价，所以 cacheWrite = input。
 */
const PRICES = {
	flash: { tag: 'DeepSeek V4.1-Flash 官方价', input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 },
	v32: { tag: 'DeepSeek V3.2 官方价（2025-09-05 起）', input: 2, cacheRead: 0.2, cacheWrite: 2, output: 3 },
	legacy: { tag: 'DeepSeek 旧价（2025-09-05 之前）', input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }
}

/** 当前生效的价目表 —— 换价改这一行。 */
const ACTIVE = PRICES.flash

/**
 * 高峰时段的倍率：官方「空闲时段价格为高峰时段价格的一半」，即高峰 = 空闲 × 2。
 * 换算关系不要写成折扣：价目表里填的是空闲价。
 */
const PEAK_FACTOR = 2

/** 北京时间相对 UTC 的偏移（分钟）。 */
const BEIJING_OFFSET_MINUTES = 8 * 60

/** 高峰时段（北京时间，当天第几分钟起、至）：周一至周五 9:00–12:00、14:00–18:00。 */
const PEAK_WINDOWS = [
	[9 * 60, 12 * 60],
	[14 * 60, 18 * 60]
]

/**
 * 中国法定节假日（北京时间日期，`YYYY-MM-DD`）。官方规定节假日全天按空闲时段计价。
 * 这里只列 2026 年已知的部分；调休上班日不列入（按官方「不含法定节假日」的表述，调休日仍算工作日）。
 * 拿到新年份的假期表后直接往这里加，格式保持 `YYYY-MM-DD`。
 */
const CN_HOLIDAYS = new Set([
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
 * @returns {{date:string, weekday:number, minute:number}} 日期、星期（0=周日）、当天第几分钟。
 */
function beijingParts(when) {
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
 * 某个时刻是否落在**高峰**时段（北京时间工作日 9:00–12:00、14:00–18:00，不含法定节假日）。
 * @param {number} when 毫秒时间戳；非法或缺失时按高峰处理（宁可估高，不让人误以为便宜）。
 * @returns {boolean} true 表示高峰。
 */
function isPeakAt(when) {
	if (typeof when !== 'number' || !Number.isFinite(when) || when <= 0) return true
	const { date, weekday, minute } = beijingParts(when)
	if (CN_HOLIDAYS.has(date)) return false
	if (weekday === 0 || weekday === 6) return false
	return PEAK_WINDOWS.some(([from, to]) => minute >= from && minute < to)
}

/**
 * 取某个时刻生效的价目表：高峰把 `ACTIVE` 的各档乘 `PEAK_FACTOR`。
 * @param {number} when 毫秒时间戳。
 * @param {typeof ACTIVE} [base] 基准价（默认 `ACTIVE`，填的是空闲价）。
 * @returns {object} 带 `tag` / `peak` 的价目表。
 */
function priceAt(when, base = ACTIVE) {
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
function count(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 按四个计费桶算钱：输入分「未命中 / 命中 / 写入缓存」三档，输出一档。
 * @param {unknown} usage `tokenUsage` 投影的值。
 * @param {{input:number,cacheRead:number,cacheWrite:number,output:number}} [price] 价目表。
 * @returns {object} 各档 token 数、各档金额、合计金额与总 token 数。
 */
function costOf(usage, price = ACTIVE) {
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

/**
 * 整数部分加千分位。
 * @param {string} text 已经是纯数字的字符串。
 * @returns {string} 加过分组符的字符串。
 */
function groupDigits(text) {
	const [whole, fraction] = text.split('.')
	const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
	return fraction === undefined ? grouped : `${grouped}.${fraction}`
}

/**
 * 金额显示：小于 1 元保留 4 位小数（这种量级下 2 位全被四舍五入吃掉），否则 2 位。
 * 小于 0.0001 元直接写 `<0.0001`，免得显示成 `0.0000` 让人以为没花钱。
 * @param {number} value 金额。
 * @returns {string} 显示文本。
 */
function formatMoney(value) {
	if (!Number.isFinite(value) || value <= 0) return '0'
	if (value < 0.0001) return '<0.0001'
	return groupDigits(value < 1 ? value.toFixed(4) : value.toFixed(2))
}

/**
 * 悬停提示：把每一档的「token 数 × 单价 = 金额」逐行写清，顺带标明用的是哪套价、哪个模型。
 * @param {ReturnType<typeof costOf>} cost 算出的金额明细。
 * @param {{tag:string}} price 价目表。
 * @param {string} model 模型标识（可能为空）。
 * @returns {string} 多行提示文本。
 */
function breakdownText(cost, price, model, scope = '本会话') {
	const tokens = (value) => groupDigits(String(Math.round(value)))
	const lines = [
		`${scope} token 花费（${price.tag}，每百万 token 单价）`,
		`未命中缓存输入 ${tokens(cost.uncached)} × ${CURRENCY_SYMBOL}${price.input} = ${CURRENCY_SYMBOL}${formatMoney(cost.inputCost)}`,
		`命中缓存输入 ${tokens(cost.cacheRead)} × ${CURRENCY_SYMBOL}${price.cacheRead} = ${CURRENCY_SYMBOL}${formatMoney(cost.cacheReadCost)}`,
		`写入缓存输入 ${tokens(cost.cacheWrite)} × ${CURRENCY_SYMBOL}${price.cacheWrite} = ${CURRENCY_SYMBOL}${formatMoney(cost.cacheWriteCost)}`,
		`输出 ${tokens(cost.output)} × ${CURRENCY_SYMBOL}${price.output} = ${CURRENCY_SYMBOL}${formatMoney(cost.outputCost)}`,
		`合计 ${CURRENCY_SYMBOL}${formatMoney(cost.total)}（共 ${tokens(cost.tokens)} tokens）`
	]
	if (model !== '') lines.push(`模型 ${model}`)
	return lines.join('\n')
}

/**
 * 从会话快照里找最近一次请求用到的模型标识。
 *
 * 会话级投影不带模型名，只有每轮节点的 `tokenUsage.routes` 带；按节点顺序取最后一个有值的就是
 * 「最近用过的模型」。中途换过模型时它只反映最后一次 —— 提示文案里写明这是「模型」而不是
 * 「全程使用的模型」，避免误导。
 * @param {object} snapshot 聊天快照。
 * @returns {string} 形如 `deepseek/deepseek-chat`，找不到返回空串。
 */
function latestModel(snapshot) {
	let found = ''
	const nodes = snapshot?.nodes
	if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return found
	for (const node of nodes.values()) {
		const routes = node?.kind === 'turn-tail' || node?.kind === 'turn' ? node.data?.tokenUsage?.routes : undefined
		if (!Array.isArray(routes) || routes.length === 0) continue
		const names = routes
			.map((route) => (typeof route?.model === 'string' ? `${route.provider ?? ''}/${route.model}` : ''))
			.filter((name) => name !== '')
		if (names.length > 0) found = names.join(', ')
	}
	return found
}

/**
 * 取出「这条回复所属那一轮」的用量与模型。
 *
 * 消息底部的「用量 13.1M tok」徽标用的就是这份数据（轮节点的 `data.tokenUsage`），所以
 * 花费能和它排在同一个位置、对同一批 token 算钱，不会出现「徽标 13.1M、花费按会话总计」的错位。
 * @param {object} snapshot 聊天快照。
 * @param {string} messageId 消息 id。
 * @returns {{usage: object, model: string} | undefined} 找不到返回 undefined。
 */
function turnUsageOf(snapshot, messageId) {
	const nodes = snapshot?.nodes
	if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return undefined
	for (const node of nodes.values()) {
		// 轮节点的 kind 是 `turn-tail`（见 client-ui-chat 的 turnTailDefinition）；
		// 同时认 `turn` 只是防御性写法，宿主哪天改名这里不会立刻失效。
		if (node?.kind !== 'turn-tail' && node?.kind !== 'turn') continue
		if (node.data?.closing?.finalNode?.messageId !== messageId) continue
		const usage = node.data.tokenUsage
		if (usage === undefined || usage === null || typeof usage !== 'object') return undefined
		const routes = Array.isArray(usage.routes) ? usage.routes : []
		const model = routes
			.map((route) => (typeof route?.model === 'string' ? `${route.provider ?? ''}/${route.model}` : ''))
			.filter((name) => name !== '')
			.join(', ')
		// 时间戳用来判断这条回复落在高峰还是空闲时段；节点上没有就退回 0（= 按高峰估）。
		const at = Number(node.time ?? node.data?.time ?? 0) || 0
		return { usage, model, at }
	}
	return undefined
}

/**
 * 把整个会话所有轮的花费按各自时段累加起来。
 *
 * 为什么要逐轮算：`tokenUsage` 投影只给总量、不带时间，`priceAt` 只能对整个会话用同一个价；
 * 而真实的账单是**按调用时刻**分峰谷结算的 —— 凌晨跑的便宜，下午跑的贵。逐轮取价再求和，
 * 才和账单对得上。
 * @param {object} snapshot 聊天快照。
 * @param {typeof ACTIVE} [base] 基准价。
 * @returns {{total: number, tokens: number, idleTokens: number, turns: number} | undefined} 没有轮数据时返回 undefined。
 */
function sessionCostOf(snapshot, base = ACTIVE) {
	const nodes = snapshot?.nodes
	if (nodes === undefined || nodes === null || typeof nodes.values !== 'function') return undefined
	let total = 0
	let tokens = 0
	let idleTokens = 0
	let turns = 0
	for (const node of nodes.values()) {
		if (node?.kind !== 'turn-tail' && node?.kind !== 'turn') continue
		const usage = node.data?.tokenUsage
		if (usage === undefined || usage === null || typeof usage !== 'object') continue
		const at = Number(node.time ?? node.data?.time ?? 0) || 0
		const cost = costOf(usage, priceAt(at, base))
		total += cost.total
		tokens += cost.tokens
		if (!isPeakAt(at)) idleTokens += cost.tokens
		turns += 1
	}
	if (turns === 0) return undefined
	return { total, tokens, idleTokens, turns }
}

/**
 * 在页面角落留一块红底提示。
 *
 * 为什么要这个：这个插件的失败模式是**静默**的 —— 插槽没登记上、inject 没生效、宿主没加载，
 * 表现出来都是「页面上什么都没多出来」，和「插件没装」一模一样。有一块红字，就能一眼分辨
 * 「代码跑起来了但某一步失败」与「代码根本没跑」。
 * 20 秒后自动消失，不打扰第二次打开。
 * @param {string} text 失败原因。
 */
function reportFailure(text) {
	try {
		const box = document.createElement('div')
		box.textContent = `[dsh-usage-cost] ${text}`
		box.style.cssText =
			'position:fixed;left:8px;bottom:8px;z-index:99999;max-width:60vw;background:#7f1d1d;color:#fff;' +
			'font:12px/1.5 ui-monospace,monospace;padding:6px 10px;border-radius:4px;white-space:pre-wrap'
		document.body.appendChild(box)
		setTimeout(() => {
			box.remove()
		}, 20000)
	} catch {
		// 页面还没有 body（极早期）就放弃，不要因为这行提示再抛一次错。
	}
}

window.__ModuleLoader__.load({
	id: 'dsh-usage-cost',
	factory(require) {
		const jsxRuntime = require('react/jsx-runtime')
		const jsx = jsxRuntime.jsx
		const jsxs = jsxRuntime.jsxs
		// 只用两个基础 hook（搬节点用），不引入别的 React 能力。
		const reactRuntime = require('react')

		/**
		 * 药丸本体。
		 *
		 * 拿不到 `tokenUsage` 时**也**渲染一枚 `花费 ¥—`：什么都不显示虽然更干净，但排障分不清
		 * 「插件压根没加载」和「投影还没数据」；有占位符就能一眼区分。
		 * @param {{useProjection: Function, useChat: Function}} props 插槽标准 props。
		 * @returns {unknown} React 元素。
		 */
		function UsageCostPill({ useProjection, useChat }) {
			const usage = useProjection('tokenUsage')
			const summary = useChat(sessionCostOf)
			const model = useChat(latestModel) ?? ''
			// 宿主投影：整个会话的花费（与加载窗口无关）。投影未注册时是 undefined。
			const whole = useProjection('usageCost')
			// 首选宿主投影：它是**整个会话**事件流折叠出来的，与客户端加载窗口无关。
			//
			// 为什么不能用下面那个 summary：客户端只物化最近若干轮，`snapshot.nodes` 是「当前已加载
			// 窗口」；往上翻聊天会加载更早的轮，于是浏览器算出来的会话累计会随着滚动一点点变大 ——
			// 「本会话花费」这种东西显然不能随滚动变化。
			if (whole !== undefined && whole !== null && whole.tokens > 0) {
				const share = Math.round((whole.idleTokens / whole.tokens) * 100)
				const lines = [
					'本会话花费（宿主投影：整个会话，含更早的轮）',
					`合计 ${CURRENCY_SYMBOL}${formatMoney(whole.cost)}（共 ${groupDigits(String(Math.round(whole.tokens)))} tokens，${groupDigits(String(Math.round(whole.turns)))} 轮）`,
					`其中空闲时段 ${groupDigits(String(Math.round(whole.idleTokens)))} tokens，占 ${share}%（按半价结算）`,
					`价目表 ${ACTIVE.tag}；高峰（工作日 9–12 / 14–18 北京时间）= 空闲价 × ${PEAK_FACTOR}`
				]
				if (model !== '') lines.push(`模型 ${model}`)
				return jsx('span', {
					className: 'duc_anchor',
					'data-composer-stat': 'usage-cost',
					title: lines.join('\n'),
					children: jsxs('span', {
						className: 'duc_pill',
						children: [
							jsx('span', { className: 'duc_label', children: `花费 ${CURRENCY_SYMBOL}${formatMoney(whole.cost)}` })
						]
					})
				})
			}
			// 退路一：按已加载的轮次逐轮取价（投影没就绪时用，金额偏小是已知的）。
			if (summary !== undefined && summary.tokens > 0) {
				const share = Math.round((summary.idleTokens / summary.tokens) * 100)
				const lines = [
					'本会话花费（仅已加载的轮：宿主投影未就绪时的退路，往上翻会变大）',
					`合计 ${CURRENCY_SYMBOL}${formatMoney(summary.total)}（共 ${groupDigits(String(Math.round(summary.tokens)))} tokens，${summary.turns} 轮）`,
					`其中空闲时段 ${groupDigits(String(Math.round(summary.idleTokens)))} tokens，占 ${share}%（按半价结算）`,
					`价目表 ${ACTIVE.tag}；高峰（工作日 9–12 / 14–18 北京时间）= 空闲价 × ${PEAK_FACTOR}`
				]
				if (model !== '') lines.push(`模型 ${model}`)
				return jsx('span', {
					className: 'duc_anchor',
					'data-composer-stat': 'usage-cost',
					title: lines.join('\n'),
					children: jsxs('span', {
						className: 'duc_pill',
						children: [
							jsx('span', { className: 'duc_label', children: `花费 ${CURRENCY_SYMBOL}${formatMoney(summary.total)}` })
						]
					})
				})
			}
			if (usage === undefined || usage === null) {
				return jsx('span', {
					className: 'duc_anchor',
					'data-composer-stat': 'usage-cost',
					title: '没有拿到 tokenUsage 投影：本次会话还没产生用量，或投影尚未就绪。',
					children: jsxs('span', {
						className: 'duc_pill',
						children: [jsx('span', { className: 'duc_label', children: `花费 ${CURRENCY_SYMBOL}—` })]
					})
				})
			}
			// 没有轮节点可逐轮结算（例如刚加载、快照还没补齐）时，用投影总量按当前时段估一次。
			const price = priceAt(Date.now())
			const cost = costOf(usage, price)
			return jsx('span', {
				className: 'duc_anchor',
				'data-composer-stat': 'usage-cost',
				title: breakdownText(cost, price, model),
				children: jsxs('span', {
					className: 'duc_pill',
					children: [
						jsx('span', { className: 'duc_label', children: `花费 ${CURRENCY_SYMBOL}${formatMoney(cost.total)}` })
					]
				})
			})
		}

		/**
		 * 把「花费」塞进「用量 6.3M tok」那一枚徽标内部（成为它的一部分，而不是旁边的另一枚）。
		 *
		 * 为什么不再插在徽标旁边：插槽 `conversation.chat.assistant-actions` 的产物被塞进那一排的
		 * **extraActions 位置**（复制图标之前），插槽本身给不了更细的位置，只能挂载后自己搬。
		 * 但「搬到兄弟位置」总是踩宿主的布局变化（窄宽度折菜单、endInfo 晚渲染），用户看到的是
		 * 「花费」卡在图标和用量之间。直接作为徽标的子节点，位置就只取决于徽标自己，稳定得多；
		 * 间距由 CSS 的 `margin-left` 决定。
		 *
		 * 徽标是宿主 React 渲染的，重渲染可能把我们这个子节点删掉，所以盯一眼 DOM，没了就再塞一次。
		 * @param {HTMLElement | null} el 我们自己的节点。
		 * @returns {() => void} 清理函数。
		 */
		function placeNextToUsageBadge(el) {
			if (el === null || el === undefined) return () => {}
			/**
			 * 取节点自身的文字（不算我们这一段）。
			 *
			 * 我们已经塞进徽标之后，徽标的 `textContent` 会连带我们的「花费 ¥0.6」一起返回，
			 * 再拿它做匹配会自我污染；所以逐层累加、跳过自己。
			 * @param {object} node DOM 节点。
			 * @returns {string} 去掉我们之后的文本。
			 */
			const ownText = (node) => {
				if (node === el) return ''
				const text = node.textContent ?? ''
				const mine = el.textContent ?? ''
				// 真实 DOM 的 textContent 会把子节点的文字也算进来，所以要把自己那一段减掉；
				// 减不掉（说明我们不在这个子树里）就原样返回。
				return mine !== '' && text.includes(mine) ? text.replace(mine, '') : text
			}
			/** 是不是「用量 … tok」那一枚徽标。 */
			const isUsageBadge = (node) => {
				if (node === null || node === undefined || node === el) return false
				const text = ownText(node)
				return /用量/.test(text) && /tok/i.test(text)
			}
			/** 在给定子树里找最深的那一枚用量徽标。 */
			const findUsageBadge = (scope) => {
				let best = null
				const walk = (node) => {
					if (isUsageBadge(node)) best = node
					if (node.children === undefined) return
					for (const child of node.children) walk(child)
				}
				walk(scope)
				return best
			}
			/**
			 * 把节点搬进最近的「用量」徽标。
			 *
			 * 不能先判「父节点是不是徽标」：父节点也可能是个同时含「用量 … tok」的容器
			 * （图标行把徽标包在里面时就是），那时我们明明还没进徽标，却会被判成已就位，
			 * 于是永远停在外面。判断标准只有一个 —— 自己的**直接父节点**是不是要找的那一枚。
			 */
			const place = () => {
				const parent = el.parentElement
				if (parent === null) return
				// 向上最多找四层：宿主可能把「用量 + 时间」再包一层容器。
				let scope = parent
				let badge = null
				for (let depth = 0; depth < 4 && scope !== null; depth += 1) {
					badge = findUsageBadge(scope)
					if (badge !== null) break
					scope = scope.parentElement
				}
				if (badge === null) return
				if (el.parentElement === badge) return
				// 清掉同一条消息早先塞进去、但已被 React 重新渲染换掉的旧节点：
				// 不清理的话，重渲染一次就多一个金额，看起来像「花了两次钱」。
				for (const stale of badge.querySelectorAll?.('[data-usage-cost]') ?? []) {
					if (stale !== el) stale.remove()
				}
				badge.appendChild(el)
			}
			const watchRoot = el.parentElement
			place()
			// 宿主常常先渲染图标、稍后才补上「用量」，所以头几帧再试三次。
			const frames = []
			if (typeof requestAnimationFrame === 'function') {
				for (let i = 0; i < 3; i += 1) frames.push(requestAnimationFrame(() => place()))
			}
			if (watchRoot === null || typeof MutationObserver !== 'function') {
				return () => {
					if (typeof cancelAnimationFrame === 'function') for (const id of frames) cancelAnimationFrame(id)
				}
			}
			const observer = new MutationObserver(() => place())
			observer.observe(watchRoot, { childList: true, subtree: true })
			// 「用量」徽标在行尾的另一个容器里（图标行 ≠ 用量+时间）。宿主重渲染那边时
			// 我们的节点会被删掉，而那个变化不在 watchRoot 子树内 —— 所以把整行也盯上。
			const row = watchRoot.parentElement
			if (row !== null && row !== undefined) observer.observe(row, { childList: true, subtree: true })
			return () => {
				observer.disconnect()
				if (typeof cancelAnimationFrame === 'function') for (const id of frames) cancelAnimationFrame(id)
			}
		}

		/**
		 * 消息操作行里的「花费」。
		 *
		 * 挂在 `conversation.chat.assistant-actions` 上 —— 这个插槽的产物被塞进每条回复底部那排
		 * 图标里（复制 / 赞 / 踩 / 反馈 / 分享 / 用量 / 时间），读的是同一轮的 token 数；
		 * 挂载后再把它搬到「用量」右边（见 `placeNextToUsageBadge`）。
		 * 这一轮没有用量数据（比如中断的回复）时**不渲染**，不占位、不留空框。
		 * @param {{messageId: string, useChat: Function}} props 插槽标准 props。
		 * @returns {unknown} React 元素或 null。
		 */
		function UsageCostAction({ messageId, useChat }) {
			const found = useChat((snapshot) => turnUsageOf(snapshot, messageId))
			const nodeRef = reactRuntime.useRef(null)
			reactRuntime.useEffect(() => {
				const cleanup = placeNextToUsageBadge(nodeRef.current)
				return cleanup
			}, [found])
			// 卸载时自己回收：节点已经被搬进宿主的徽标里（不在 React 的子树内），
			// React 卸载时找不到它，不主动删就会永远留在那一行里。
			reactRuntime.useEffect(() => {
				return () => {
					const el = nodeRef.current
					if (el !== null && el !== undefined && typeof el.remove === 'function') el.remove()
				}
			}, [])
			if (found === undefined) return null
			const price = priceAt(found.at)
			const cost = costOf(found.usage, price)
			return jsx('span', {
				ref: nodeRef,
				className: 'duc_inline',
				'data-usage-cost': messageId,
				title: breakdownText(cost, price, found.model, '本轮'),
				children: `${CURRENCY_SYMBOL}${formatMoney(cost.total)}`
			})
		}

		return {
			// 出厂客户端插件都这样声明依赖的服务（见 @deepseek-ai/dsh-client-ui-approval 的
			// `exports.inject = inject`）：少了这一行，apply 里拿到的 ctx 不一定带 slots。
			inject: ['slots'],

			apply(ctx) {
				// 登记插槽是本体，必须最先做：它前面的任何一步抛错，药丸就彻底不出现。
				try {
					if (ctx.slots === undefined || ctx.slots === null) {
						// 走到这里说明 inject 没生效 —— 直接在页面上留痕，比「什么都没有」好查。
						reportFailure('ctx.slots 不可用（inject 未生效）')
						return
					}
					// 主位：每条回复底部的操作行，紧跟在「用量」徽标后。
					ctx.slots.inject('conversation.chat.assistant-actions', () =>
						ctx.slots.register(
							{ name: 'conversation.chat.assistant-actions', id: 'usage-cost' },
							UsageCostAction
						)
					)
					// 副位：输入框下方那排药丸里的会话累计（宿主的两个条目 id 是 `activity` /
					// `usage`；用自己的 id 排在它们后面，不顶掉原来的用量药丸）。
					ctx.slots.inject('conversation.composer.dock', () =>
						ctx.slots.register(
							{ name: 'conversation.composer.dock', id: 'usage-cost', order: 2 },
							UsageCostPill
						)
					)
				} catch (error) {
					reportFailure(`登记插槽失败：${error instanceof Error ? error.message : String(error)}`)
				}
				// 样式是装饰：失败也不该影响药丸本身。
				try {
					// 视觉上对齐随包附带的用量药丸：同样的字号、颜色变量与圆角，但用自己的类名，
					// 不依赖宿主构建产物的哈希类名（那些名字每次构建都会变）。
					ctx.effect(() => {
						const tag = document.createElement('style')
						tag.dataset.plugin = 'dsh-usage-cost'
						tag.textContent = [
							'.duc_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
							'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}',
							'.duc_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;',
							'color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;',
							'line-height:inherit;white-space:nowrap;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
							'.duc_label{text-overflow:ellipsis;min-width:0;overflow:hidden}',
							// 消息操作行：塞在「用量 13.1M tok」徽标内部，作为同一项的第二段文字。
							// 字号/颜色全部继承徽标，只留左边一段间距：看上去就是「用量 6.8M tok ¥0.23」。
							'.duc_inline{margin-left:10px;font:inherit;font-size:inherit;line-height:inherit;',
							'color:inherit;font-variant-numeric:tabular-nums;white-space:nowrap}'
						].join('')
						document.head.appendChild(tag)
						return () => {
							tag.remove()
						}
					})
				} catch (error) {
					console.error('[dsh-usage-cost] 注入样式失败', error)
				}
			},
			// 给测试用：纯函数不需要浏览器就能验证。
			__test: {
				costOf,
				formatMoney,
				breakdownText,
				latestModel,
				turnUsageOf,
				sessionCostOf,
				isPeakAt,
				priceAt,
				placeNextToUsageBadge,
				PEAK_FACTOR,
				PRICES,
				ACTIVE,
				CN_HOLIDAYS
			}
		}
	}
})
