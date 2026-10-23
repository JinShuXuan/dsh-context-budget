/**
 * dsh-context-budget —— 每步上下文账本 + 四个可单独开关的闸门。
 *
 * 核心判断（数字全部来自真实会话日志，见 README）：
 *   上下文成本 ≈ 步数 × 每步重发量。每步里 4 成是**固定前缀**（工具表 + 系统提示），
 *   剩下的是历史。所以能省的只有三件事：重发什么、重发多大、要不要重复付。
 *
 * 四个闸（默认只开第一个）：
 *   L0 观测   —— 折叠会话事件，产出每步构成 / 固定前缀 / 真实 usage（0 token、无副作用）
 *   G1 工具档 —— agent/created 时按 schema 体积裁到预算内，会话内不再变（保护前缀缓存）
 *   G2 外置   —— 结果超阈值就落盘，只留前 1200 / 后 600 字符 + 指针
 *   G3 去重   —— 同 path+区间且文件未变，直接回指针
 *
 * 配置三级优先级：/budget-set 落盘 > profile 覆盖层 > 包内默认。
 *
 * 明确不做：不改模型、不往 system prompt 注入文本、不在会话中途改工具集。
 * 理由是同一条：任何"每轮都变"的前缀都会打断 KV cache，省下的不如赔的多。
 */

import os from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'

import { registerReadMany } from './read-many.js'

// Cordis inject 用数组形式声明必需服务。commands 是可选能力，运行时用 ctx.get() 取，
// 这样在缺 commands 的 profile 里插件仍能加载，而不是永远停在 pending。
export const inject = ['tools']

// 可选能力：能解析到 @deepseek-ai/schemastery 时导出 Config，插件管理页才会有表单；
// 解析不到就退回“无 schema”，插件照常工作。这是刻意选的降级，不是遗漏。
let Config
try {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  Config = Schema.object({
    enabled: Schema.boolean().default(true).description('总开关'),
    debug: Schema.union([Schema.boolean(), Schema.string()]).default(false).description('诊断日志：true 或日志文件路径'),
    budget: Schema.object({
      warnAtTokens: Schema.number().default(120000).description('每步固定前缀超过这个值就在报告里标红'),
    }).description('预算告警'),
    tail: Schema.object({
      enabled: Schema.boolean().default(false).description('长尾外置：大结果落盘，上下文只留预览'),
      thresholdChars: Schema.number().default(35000).description('触发阈值（字符）'),
      keepHeadChars: Schema.number().default(1200).description('预览头部字符预算（优先于按行）'),
      keepTailChars: Schema.number().default(600).description('预览尾部字符预算'),
      keepHeadLines: Schema.number().default(0).description('按行兜底：头部行数（chars 为 0 时生效）'),
      keepTailLines: Schema.number().default(0).description('按行兜底：尾部行数'),
      dir: Schema.string().default('.context-budget/spill').description('外置文件目录（相对会话 cwd）'),
    }).description('G2'),
    dedup: Schema.object({
      enabled: Schema.boolean().default(false).description('重复读回指针'),
      tools: Schema.array(Schema.string()).default(['read', 'ops_inspect_local_file']).description('参与去重的工具名'),
    }).description('G3'),
    toolset: Schema.object({
      enabled: Schema.boolean().default(false).description('会话开头裁剪工具表'),
      strategy: Schema.union(['budget', 'deny', 'allow']).default('budget').description('budget=按体积裁；deny/allow=显式名单'),
      budgetTokens: Schema.number().default(25000).description('工具表预算（token）'),
      protect: Schema.array(Schema.string())
        .default([
          'read',
          'write',
          'edit',
          'ops_bash',
          'pwsh',
          'ops_grep',
          'ops_glob',
          'ops_inspect_local_file',
          'read_many',
          'skill',
          'ask_user_question',
        ])
        .description('永不裁剪的工具'),
      defaultMode: Schema.union(['lean', 'full']).default('full').description('默认档位；full 表示不裁剪'),
      modes: Schema.object({
        lean: Schema.object({
          tools: Schema.array(Schema.string()).default([]).description('allow 模式的白名单'),
          deny: Schema.array(Schema.string()).default([]).description('额外按名字裁掉'),
          denyPrefixes: Schema.array(Schema.string()).default([]).description('额外按前缀裁掉'),
        }),
      }).description('档位细节'),
      byPath: Schema.array(
        Schema.object({
          prefix: Schema.string(),
          mode: Schema.union(['lean', 'full']),
        }),
      )
        .default([])
        .description('按 cwd 前缀选择档位'),
    }).description('G1'),
    readMany: Schema.object({
      enabled: Schema.boolean().default(false).description('注册 read_many 工具'),
      defaultLimit: Schema.number().default(400).description('每个文件默认读取行数'),
      maxCharsPerFile: Schema.number().default(20000).description('单文件字符上限'),
      maxTotalChars: Schema.number().default(60000).description('整批字符上限'),
    }).description('复合工具'),
  })
} catch {
  Config = undefined
}
export { Config }

const CHARS_PER_TOKEN = 2.2 // 中英混排粗估；L0 优先用真实 usage，缺样本时才用它

// 诊断日志：默认关闭，且绝不硬编码机器相关路径。
//   debug: true       → 写到系统临时目录 dsh-context-budget/debug.log
//   debug: '<path>'   → 写到指定路径（相对路径按进程 cwd 解析）
// 日常要看闸门命中次数不需要它：/budget 直接报 state.tailHits / state.dedupHits。
let debugEnabled = false
let debugLogPath = ''

function trace(line) {
  if (!debugEnabled || debugLogPath === '') return
  try {
    mkdirSync(path.dirname(debugLogPath), { recursive: true })
    appendFileSync(debugLogPath, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* ignore */
  }
}

const MAX_SESSIONS = 64
const MAX_SEEN_READS = 512

const DEFAULTS = {
  enabled: true,
  budget: { warnAtTokens: 120000 },
  // 预览预算按**字符**而不是按行：行数固定时，省多少取决于行长分布
  // （400 行的结果省 93%，47 行的只省 36%）。按字符才能让“省多少”可计算。
  // keepHeadLines/keepTailLines 保留为兜底：chars 都为 0 时才按行取。
  tail: {
    enabled: false,
    thresholdChars: 35000,
    keepHeadChars: 1200,
    keepTailChars: 600,
    keepHeadLines: 0,
    keepTailLines: 0,
    dir: '.context-budget/spill',
  },
  dedup: { enabled: false, tools: ['read', 'ops_inspect_local_file'] },
  toolset: {
    enabled: false,
    // budget：按 schema 体积裁到预算内（与具体插件名无关，天然通用）。
    // deny/allow：老的显式名单模式，保留兼容。
    strategy: 'budget',
    budgetTokens: 25000,
    protect: [
      'read',
      'write',
      'edit',
      'ops_bash',
      'pwsh',
      'ops_grep',
      'ops_glob',
      'ops_inspect_local_file',
      'read_many',
      'skill',
      'ask_user_question',
    ],
    defaultMode: 'full',
    modes: { lean: { tools: [] } },
    byPath: [],
  },
  readMany: { enabled: false },
}

function warn(scope, error) {
  try {
    console.warn(`[context-budget] ${scope}:`, error instanceof Error ? error.message : String(error))
  } catch {
    /* console unavailable */
  }
}

function mergeConfig(raw) {
  const base = structuredClone(DEFAULTS)
  if (!raw || typeof raw !== 'object') return base
  const out = { ...base, ...raw }
  for (const key of ['budget', 'tail', 'dedup', 'toolset', 'readMany']) {
    if (raw[key] && typeof raw[key] === 'object') out[key] = { ...base[key], ...raw[key] }
  }
  return out
}

function tokensOfChars(chars) {
  return Math.round(chars / CHARS_PER_TOKEN)
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function clampInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

function sessionKey(id) {
  return typeof id === 'string' ? id : String(id)
}

const states = new Map()

function stateOf(id) {
  const key = sessionKey(id)
  let state = states.get(key)
  if (state) return state
  if (states.size >= MAX_SESSIONS) {
    const oldest = states.keys().next().value
    if (oldest !== undefined) states.delete(oldest)
  }
  state = {
    cwd: undefined,
    turns: 0,
    steps: 0,
    calls: 0,
    systemChars: 0,
    skillsChars: 0,
    skillsCount: 0,
    fixedPrefixTokens: 0,
    contentChars: 0,
    toolResultChars: 0,
    tailHits: 0,
    dedupHits: 0,
    toolsetDenied: 0,
    toolsetSaved: 0,
    lastUsage: undefined,
    seenReads: new Map(),
  }
  states.set(key, state)
  return state
}

function cwdOf(agent) {
  try {
    const cwd = agent?.session?.header?.cwd
    return typeof cwd === 'string' ? cwd : undefined
  } catch {
    return undefined
  }
}

// 每个 session 的工具档解锁器：/budget-full 调它把本会话还原成全量工具。
// 这样 G1 就不是单向门——被误挡时用户能自救，代价只是那一次前缀缓存重建。
const toolsetLifters = new Map()

function foldEvent(session, event) {
  const state = stateOf(session?.id)
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'turn/start':
      state.turns += 1
      break
    case 'step/start':
      state.steps += 1
      break
    case 'tool/call':
      state.calls += 1
      break
    case 'system/message': {
      const text = textOf(data.message?.content)
      if (text.length > 0) {
        state.systemChars = text.length
        // 技能目录本来就写在系统提示里，不用额外 API：
        // 从 <available_skills> 块量出条数与字符数，就能回答“装了哪些 skill、占多少前缀”。
        const block = text.match(/<available_skills>[\s\S]*?<\/available_skills>/)
        state.skillsChars = block ? block[0].length : 0
        state.skillsCount = block ? (block[0].match(/^- `/gm) || []).length : 0
      }
      break
    }
    case 'request/header': {
      const toolsChars = JSON.stringify(data.header?.tools ?? []).length
      state.fixedPrefixTokens = tokensOfChars(toolsChars) + tokensOfChars(state.systemChars)
      break
    }
    case 'tool/result': {
      const chars = textOf(data.message?.content).length
      state.toolResultChars += chars
      state.contentChars += chars
      break
    }
    case 'assistant/message': {
      state.contentChars += textOf(data.message?.content).length
      if (data.usage && typeof data.usage === 'object') state.lastUsage = data.usage
      break
    }
    default:
      break
  }
}

function budgetReport(ctx, agent, config) {
  const state = states.get(sessionKey(agent?.id))
  if (!state) return 'context-budget: 本会话还没有记录（插件可能刚启用）。'
  const perStep = state.steps > 0 ? Math.round(state.contentChars / state.steps) : 0
  const callsPerStep = state.steps > 0 ? (state.calls / state.steps).toFixed(2) : '0.00'
  const usage = state.lastUsage
  const usageLine = usage
    ? `最近一次真实用量：input ${usage.inputTokens ?? '?'} / cacheRead ${usage.cacheReadTokens ?? '?'} / output ${usage.outputTokens ?? '?'} / reasoning ${usage.reasoningTokens ?? '?'}`
    : '最近一次真实用量：未记录'
  const overBudget = state.fixedPrefixTokens > config.budget.warnAtTokens ? ' ⚠ 超过 warnAtTokens' : ''

  // 工具表构成：读的是**当前 agent 实际可见**的那份，所以含 G1 裁剪后的结果。
  let toolLine = '工具表：读不到（tools 服务不可用）'
  try {
    const schemas = ctx?.tools?.schemas?.(agent) ?? []
    if (schemas.length > 0) {
      const sized = schemas
        .map((schema) => ({
          name: schema.name,
          tokens: Math.max(1, Math.round(JSON.stringify(schema).length / CHARS_PER_TOKEN)),
        }))
        .sort((a, b) => b.tokens - a.tokens)
      const total = sized.reduce((sum, item) => sum + item.tokens, 0)
      const top = sized.slice(0, 5).map((item) => `${item.name}(${item.tokens})`).join('、')
      toolLine = `工具表：${sized.length} 个 / 约 ${total} token；最肥的 5 个：${top}`
    }
  } catch (error) {
    warn('/budget tools', error)
  }

  const skillLine = state.skillsChars
    ? `技能目录：${state.skillsCount} 个 / 约 ${tokensOfChars(state.skillsChars)} token（占系统提示 ${Math.round(
        (state.skillsChars / Math.max(1, state.systemChars)) * 100,
      )}%）`
    : '技能目录：系统提示里没有 <available_skills> 块（或本会话还没发过系统提示）'

  return [
    'context-budget 报告',
    `回合 ${state.turns} / 步 ${state.steps} / 工具调用 ${state.calls}（${callsPerStep} 次/步）`,
    `每步固定前缀 ≈ ${state.fixedPrefixTokens} token（工具表 + 系统提示）${overBudget}`,
    toolLine,
    skillLine,
    `内容累计 ${tokensOfChars(state.contentChars)} token（其中工具结果 ${tokensOfChars(state.toolResultChars)} token）`,
    `新增内容/步 ≈ ${tokensOfChars(perStep)} token`,
    `闸门命中：长尾外置 ${state.tailHits} 次 / 重复读指针 ${state.dedupHits} 次`,
    `工具档：裁掉 ${state.toolsetDenied} 个工具，预计省 ${state.toolsetSaved} token/步`,
    usageLine,
    '说明：token 为估算值（优先真实 usage），用于比较构成，不用于计费。',
  ].join('\n')
}

async function tryDedup(exec, state, config) {
  const name = exec?.name
  const tools = config.dedup.tools
  if (!Array.isArray(tools) || !tools.includes(name)) return null
  const args = exec?.arguments ?? {}
  const clientPath = args.file_path ?? args.path
  if (typeof clientPath !== 'string' || clientPath.length === 0) return null

  const offset = clampInt(args.offset, 1, 1, Number.MAX_SAFE_INTEGER)
  const limit = clampInt(args.limit, 200, 1, 20000)
  const key = `${name}|${clientPath}|${offset}|${limit}`
  const previous = state.seenReads.get(key)

  // 先取 mtime：第一次读也要存，否则重复读永远不会命中
  let mtimeMs
  try {
    const abs = path.isAbsolute(clientPath) ? clientPath : path.resolve(state.cwd ?? process.cwd(), clientPath)
    mtimeMs = (await stat(abs)).mtimeMs
  } catch {
    return null // 读不到就放过：宁可重发，不可错回指针
  }

  if (!previous) {
    state.seenReads.set(key, { at: Date.now(), mtimeMs })
    if (state.seenReads.size > MAX_SEEN_READS) {
      const oldest = state.seenReads.keys().next().value
      if (oldest !== undefined) state.seenReads.delete(oldest)
    }
    return null
  }

  if (previous.mtimeMs === undefined || previous.mtimeMs !== mtimeMs) {
    state.seenReads.set(key, { at: Date.now(), mtimeMs })
    return null
  }

  state.dedupHits += 1
  return (
    `[context-budget] 本会话已读过 ${clientPath} 的同一区间（第 ${offset} 行起 ${limit} 行），文件自上次读取后未修改。\n` +
    '内容未重复发送，请直接引用之前的工具结果；如需其他区间，用不同的 offset/limit 重新读取。'
  )
}

// 按字符取头部预览：尽量切在换行处，单行过长时硬切。
function headByChars(text, max) {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max)
  return text.slice(0, cut > max * 0.5 ? cut : max)
}

// 按字符取尾部预览：从头尾重叠里避开，尽量从整行开始。
function tailByChars(text, max) {
  if (max <= 0) return ''
  if (text.length <= max) return ''
  const start = text.length - max
  const nl = text.indexOf('\n', start)
  return text.slice(nl >= 0 && nl < start + max * 0.5 ? nl + 1 : start)
}

async function tryTail(exec, state, config, text) {
  if (typeof text !== 'string' || text.length < config.tail.thresholdChars) return null

  const cwd = state.cwd ?? cwdOf(exec?.agent) ?? process.cwd()
  const dir = path.isAbsolute(config.tail.dir) ? config.tail.dir : path.resolve(cwd, config.tail.dir)
  const safeId = String(exec?.callId ?? 'call').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const file = path.join(dir, `${safeId}.txt`)

  const lines = text.split('\n')
  const headChars = clampInt(config.tail.keepHeadChars, 0, 0, 20000)
  const tailChars = clampInt(config.tail.keepTailChars, 0, 0, 20000)

  let head
  let tail
  let headLabel
  let tailLabel

  if (headChars > 0 || tailChars > 0) {
    head = headByChars(text, headChars)
    tail = tailByChars(text, tailChars)
    headLabel = `前 ${head.length} 字符`
    tailLabel = `后 ${tail.length} 字符`
  } else {
    const headN = clampInt(config.tail.keepHeadLines, 20, 0, 200)
    const tailN = clampInt(config.tail.keepTailLines, 10, 0, 200)
    head = lines.slice(0, headN).join('\n')
    tail = lines.slice(Math.max(headN, lines.length - tailN)).join('\n')
    headLabel = `前 ${headN} 行`
    tailLabel = `后 ${tailN} 行`
  }

  const summary =
    `[context-budget] 该结果 ${text.length} 字符 / ${lines.length} 行，已外置到磁盘以节省上下文：\n${file}\n` +
    `--- ${headLabel} ---\n${head}\n--- ${tailLabel} ---\n${tail}\n` +
    '[需要更多内容：用 grep 定位该文件，或 read_many 按 offset/limit 读取]'

  // 省不了就不动：预览本身比原文还长时跳过（典型是极短行数 + 超长单行）。
  // 先算指针再决定是否落盘，顺手避免留下一堆无用外置件。
  if (summary.length >= text.length) return null

  await mkdir(dir, { recursive: true })
  await writeFile(file, text, 'utf8')
  if (exec?.signal?.aborted) return null

  state.tailHits += 1
  return summary
}

function pickMode(cwd, config) {
  const mappings = Array.isArray(config.toolset.byPath) ? config.toolset.byPath : []
  if (typeof cwd === 'string') {
    for (const entry of mappings) {
      if (!entry || typeof entry.prefix !== 'string') continue
      if (cwd.toLowerCase().startsWith(entry.prefix.toLowerCase())) return entry.mode ?? config.toolset.defaultMode
    }
  }
  return config.toolset.defaultMode
}

// ---- 落盘覆盖层：/budget-set 的存储 ----
// 优先级：这里的值 > bundle 内 patch / profile 覆盖层 > 内置默认值。
// 放在 DSH_HOME 下（拿不到就放插件目录旁），不依赖插件管理器。
function overridesPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.length > 0 ? home : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  return path.join(base, 'context-budget.json')
}

function loadOverrides() {
  try {
    const text = readFileSync(overridesPath(), 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

// 就地深合并：只覆盖 source 里出现的键，其余保留。
function applyOverrides(target, source) {
  if (!source || typeof source !== 'object') return target
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      applyOverrides(target[key], value)
    } else {
      target[key] = value
    }
  }
  return target
}

function parseSettingValue(raw) {
  const text = String(raw).trim()
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if ((text.startsWith('[') && text.endsWith(']')) || (text.startsWith('{') && text.endsWith('}'))) {
    try {
      return JSON.parse(text)
    } catch {
      /* 当作字符串 */
    }
  }
  return text
}

function setByPath(target, dotted, value) {
  const parts = String(dotted).split('.').filter(Boolean)
  if (parts.length === 0) return false
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[parts[parts.length - 1]] = value
  return true
}

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)
  // 落盘覆盖层最后叠加：/budget-set 写在这里，重启也在。
  applyOverrides(config, loadOverrides())
  const disposers = []
  const debug = config.debug
  debugEnabled = debug === true || (typeof debug === 'string' && debug.length > 0)
  debugLogPath = debug === true
    ? path.join(os.tmpdir(), 'dsh-context-budget', 'debug.log')
    : typeof debug === 'string' ? path.resolve(debug) : ''

  if (config.enabled === false) return () => {}

  // ---- L0 观测：只读折叠，不写会话、不改行为 ----
  disposers.push(
    ctx.on('session/event', (session, event) => {
      try {
        foldEvent(session, event)
      } catch (error) {
        warn('L0', error)
      }
    }),
  )

  // ---- G1 工具档：只在 agent 创建时定一次，会话内不变（保护前缀缓存）----
  disposers.push(
    ctx.on('agent/created', (payload) => {
      if (!config.toolset.enabled) return
      try {
        const agent = payload?.agent
        if (!agent) return
        const state = stateOf(agent.id)
        const cwd = cwdOf(agent)
        const mode = pickMode(cwd, config)
        if (mode !== 'lean') return

        // 必须在 agent 自己的 ctx 上收紧；拿不到 agent.ctx 就整体跳过，
        // 绝不用全局 ctx 调 restrict（那会影响所有会话）。
        const scopeCtx = agent.ctx
        if (!scopeCtx) {
          warn('G1', 'agent.ctx 不可用，跳过（不在全局范围收紧工具）')
          return
        }
        const schemas = scopeCtx.tools.schemas?.(agent) ?? []
        const visible = new Set(schemas.map((schema) => schema.name))
        const lean = config.toolset.modes?.lean ?? {}
        const deny = new Set()

        // 1) 显式名单（可选）：精确名 + 前缀，先按实际可见集过滤，
        //    因为 restrict 遇到不存在的名字会抛错。
        const prefixes = Array.isArray(lean.denyPrefixes) ? lean.denyPrefixes : []
        const exact = Array.isArray(lean.deny) ? lean.deny : []
        for (const name of visible) {
          if (exact.includes(name)) deny.add(name)
          else if (prefixes.some((p) => typeof p === 'string' && p.length > 0 && name.startsWith(p))) deny.add(name)
        }

        // 2) 预算模式（默认）：按 schema 体积从大到小裁，直到压回预算内。
        //    不用知道插件叫什么——新装的插件带进来的工具会被同样对待。
        const strategy = config.toolset.strategy ?? 'budget'
        if (strategy === 'budget') {
          const budget = clampInt(config.toolset.budgetTokens, 25000, 1000, 200000)
          const protect = new Set(Array.isArray(config.toolset.protect) ? config.toolset.protect : [])
          const sized = schemas
            .filter((schema) => !deny.has(schema.name))
            .map((schema) => ({
              name: schema.name,
              tokens: Math.max(1, Math.round(JSON.stringify(schema).length / CHARS_PER_TOKEN)),
            }))
          let total = sized.reduce((sum, item) => sum + item.tokens, 0)
          const before = total
          if (total > budget) {
            for (const item of [...sized].sort((a, b) => b.tokens - a.tokens)) {
              if (total <= budget) break
              if (protect.has(item.name)) continue
              deny.add(item.name)
              total -= item.tokens
            }
          }
          state.toolsetSaved = Math.max(0, before - total)
        } else if (strategy === 'allow') {
          const requested = Array.isArray(lean.tools) ? lean.tools : []
          const allow = requested.filter((name) => visible.has(name))
          if (allow.length > 0) {
            const dispose = scopeCtx.tools.restrict({ allow })
            disposers.push(dispose)
            toolsetLifters.set(sessionKey(agent.id), dispose)
            state.toolsetDenied = visible.size - allow.length
          }
          return
        }

        if (deny.size === 0) return
        const dispose = scopeCtx.tools.restrict({ deny: [...deny] })
        disposers.push(dispose)
        toolsetLifters.set(sessionKey(agent.id), dispose)
        state.toolsetDenied = deny.size
        trace(`G1 budget=${config.toolset.budgetTokens} denied=${deny.size} savedTokens=${state.toolsetSaved}`)
      } catch (error) {
        warn('G1', error)
      }
    }),
  )

  // ---- G2 / G3：同一条 post-execute 链，先去重、再外置 ----
  // 实测结论（两轮 debug 得到）：
  //   next() 返回的 decision 只是裸 {kind:'accept'}，不含文本；
  //   真正的内容在第二个参数 result 上（result.content 块 / result.value）。
  //   所以：读 result，替换时返回 accept + content。
  disposers.push(
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const decision = await next()
      try {
        if (decision?.kind !== 'accept') return decision
        const dContent = Array.isArray(decision.content) ? textOf(decision.content) : ''
        const dValue = typeof decision.value === 'string' ? decision.value : ''
        const rContent = textOf(result?.content)
        const rValue = typeof result?.value === 'string' ? result.value : ''
        const text = dContent || dValue || rContent || rValue
        trace(
          `entry name=${exec?.name} chars=${text.length} from=${
            dContent ? 'decision.content' : dValue ? 'decision.value' : rContent ? 'result.content' : rValue ? 'result.value' : 'none'
          } rerr=${result?.isError ? 'yes' : 'no'}`,
        )
        if (text.length === 0 || result?.isError) return decision
        if (exec?.signal?.aborted) return decision
        if (!exec?.agent) return decision

        const state = stateOf(exec.agent.id)
        if (typeof state.cwd !== 'string') state.cwd = cwdOf(exec?.agent)

        const make = (nextText) =>
          dValue && !dContent && !rContent
            ? { kind: 'accept', value: nextText }
            : { kind: 'accept', content: [{ type: 'text', text: nextText }] }

        if (config.dedup.enabled) {
          const pointer = await tryDedup(exec, state, config)
          if (pointer) {
            trace(`dedup-hit name=${exec?.name} saved=${text.length}`)
            return make(pointer)
          }
        }
        if (config.tail.enabled) {
          const summary = await tryTail(exec, state, config, text)
          if (summary) {
            trace(`tail-hit name=${exec?.name} saved=${text.length}`)
            return make(summary)
          }
        }
      } catch (error) {
        trace('ERROR ' + (error instanceof Error ? (error.stack ?? error.message).slice(0, 400) : String(error)))
        warn('G2/G3', error)
      }
      return decision
    }),
  )

  // ---- read_many：默认关；只注册工具，不改动其它工具 ----
  if (config.readMany?.enabled) {
    try {
      disposers.push(registerReadMany(ctx, config))
    } catch (error) {
      warn('read_many', error)
    }
  }

  // ---- /budget：斜杠命令，不进模型工具表，0 token ----
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : ctx.commands
  if (commands) {
    try {
      disposers.push(
        commands.register({
          name: 'budget',
          description: '显示本会话每步上下文构成与闸门命中情况',
          handler: (invocation) => ({ kind: 'success', text: budgetReport(ctx, invocation?.agent, config) }),
        }),
      )
      // 单向门的自救口：把本会话的工具档还原成全量。
      disposers.push(
        commands.register({
          name: 'budget-full',
          description: '撤销本会话的精简工具档，恢复全部工具（会重建一次前缀缓存）',
          handler: (invocation) => {
            const key = sessionKey(invocation?.agent?.id)
            const lift = toolsetLifters.get(key)
            if (!lift) return { kind: 'success', text: '本会话没有生效中的工具档限制（或已经还原）。' }
            try {
              lift()
              toolsetLifters.delete(key)
              return { kind: 'success', text: '已恢复本会话的全部工具。注意：下一次请求会重建前缀缓存，之后才恢复命中。' }
            } catch (error) {
              return { kind: 'error', text: '还原失败：' + (error instanceof Error ? error.message : String(error)) }
            }
          },
        }),
      )
      // 改配置：写落盘覆盖层，G2/G3 立即生效，重启仍在。
      disposers.push(
        commands.register({
          name: 'budget-set',
          description: '修改本插件配置并落盘：/budget-set tail.thresholdChars=6000（不带参数查看当前覆盖）',
          handler: (invocation) => {
            const raw = String(invocation?.rawInput ?? '').trim()
            const overrides = loadOverrides()
            if (raw.length === 0) {
              const keys = Object.keys(overrides)
              return {
                kind: 'success',
                text:
                  keys.length > 0
                    ? `当前落盘覆盖（文件 ${overridesPath()}）：\n${JSON.stringify(overrides, null, 2)}`
                    : `还没有落盘覆盖。用法：/budget-set tail.thresholdChars=6000\n文件位置：${overridesPath()}`,
              }
            }
            const applied = []
            for (const token of raw.split(/\s+/)) {
              const eq = token.indexOf('=')
              if (eq <= 0) continue
              const key = token.slice(0, eq)
              const value = parseSettingValue(token.slice(eq + 1))
              if (!setByPath(overrides, key, value)) continue
              setByPath(config, key, value) // 立即生效：G2/G3 读的就是这个对象
              applied.push(`${key} = ${JSON.stringify(value)}`)
            }
            if (applied.length === 0) {
              return { kind: 'error', text: '没识别到 key=value。例子：/budget-set tail.thresholdChars=6000' }
            }
            try {
              mkdirSync(path.dirname(overridesPath()), { recursive: true })
              writeFileSync(overridesPath(), JSON.stringify(overrides, null, 2) + '\n', 'utf8')
            } catch (error) {
              return { kind: 'error', text: '写入失败：' + (error instanceof Error ? error.message : String(error)) }
            }
            return {
              kind: 'success',
              text: `已更新并落盘（${overridesPath()}）：\n${applied.join('\n')}\nG2/G3 立即生效；toolset.* 只在 agent 创建时应用，需要新会话。`,
            }
          },
        }),
      )
    } catch (error) {
      warn('commands', error)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch (error) {
        warn('dispose', error)
      }
    }
  }
}
