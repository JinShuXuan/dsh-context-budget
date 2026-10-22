/**
 * dsh-context-budget —— 每步上下文账本 + 可单独开关的闸门。
 *
 * 设计前提（全部来自实测，见 README「依据」）：
 * 1. 每步固定前缀 ≈ 58.9K token（工具表 47.0K + 系统提示 11.9K），占每步上下文约 54%；
 * 2. 工具结果体量呈长尾：2.3% 的结果占 40.5% 字符；
 * 3. 90.1% 的步只发 1 个工具调用。
 *
 * 因此本插件做三件事，且默认只做第一件：
 * - L0 观测：每步构成（常开，无副作用，不写会话）；
 * - G2 长尾外置：超阈值结果落盘，上下文只留头尾 + 指针；
 * - G3 重复读回指针：同 path+range 且文件未变，直接回指针；
 * - G1 工具档（默认关）与 read_many（默认关）单独启用。
 *
 * 明确不做：不改模型、不注入系统提示、不在会话中途改工具集（会打断前缀缓存）。
 */

import os from 'node:os'
import path from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'

import { registerReadMany } from './read-many.js'

// Cordis inject 用数组形式声明必需服务。commands 是可选能力，运行时用 ctx.get() 取，
// 这样在缺 commands 的 profile 里插件仍能加载，而不是永远停在 pending。
export const inject = ['tools']

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
  tail: { enabled: false, thresholdChars: 35000, keepHeadLines: 20, keepTailLines: 20, dir: '.context-budget/spill' },
  dedup: { enabled: false, tools: ['read', 'ops_inspect_local_file'] },
  toolset: { enabled: false, defaultMode: 'full', modes: { lean: { tools: [] } }, byPath: [] },
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
    fixedPrefixTokens: 0,
    contentChars: 0,
    toolResultChars: 0,
    tailHits: 0,
    dedupHits: 0,
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
      if (text.length > 0) state.systemChars = text.length
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

function budgetReport(id, config) {
  const state = states.get(sessionKey(id))
  if (!state) return 'context-budget: 本会话还没有记录（插件可能刚启用）。'
  const perStep = state.steps > 0 ? Math.round(state.contentChars / state.steps) : 0
  const callsPerStep = state.steps > 0 ? (state.calls / state.steps).toFixed(2) : '0.00'
  const usage = state.lastUsage
  const usageLine = usage
    ? `最近一次真实用量：input ${usage.inputTokens ?? '?'} / cacheRead ${usage.cacheReadTokens ?? '?'} / output ${usage.outputTokens ?? '?'} / reasoning ${usage.reasoningTokens ?? '?'}`
    : '最近一次真实用量：未记录'
  const overBudget = state.fixedPrefixTokens > config.budget.warnAtTokens ? ' ⚠ 超过 warnAtTokens' : ''
  return [
    'context-budget 报告',
    `回合 ${state.turns} / 步 ${state.steps} / 工具调用 ${state.calls}（${callsPerStep} 次/步）`,
    `每步固定前缀 ≈ ${state.fixedPrefixTokens} token（工具表 + 系统提示）${overBudget}`,
    `内容累计 ${tokensOfChars(state.contentChars)} token（其中工具结果 ${tokensOfChars(state.toolResultChars)} token）`,
    `新增内容/步 ≈ ${tokensOfChars(perStep)} token`,
    `闸门命中：长尾外置 ${state.tailHits} 次 / 重复读指针 ${state.dedupHits} 次`,
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

async function tryTail(exec, state, config, text) {
  if (typeof text !== 'string' || text.length < config.tail.thresholdChars) return null

  const cwd = state.cwd ?? cwdOf(exec?.agent) ?? process.cwd()
  const dir = path.isAbsolute(config.tail.dir) ? config.tail.dir : path.resolve(cwd, config.tail.dir)
  const safeId = String(exec?.callId ?? 'call').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const file = path.join(dir, `${safeId}.txt`)

  const lines = text.split('\n')
  const headN = clampInt(config.tail.keepHeadLines, 20, 0, 200)
  const tailN = clampInt(config.tail.keepTailLines, 20, 0, 200)
  const head = lines.slice(0, headN).join('\n')
  const tail = lines.slice(Math.max(headN, lines.length - tailN)).join('\n')
  const summary =
    `[context-budget] 该结果 ${text.length} 字符 / ${lines.length} 行，已外置到磁盘以节省上下文：\n${file}\n` +
    `--- 前 ${headN} 行 ---\n${head}\n--- 后 ${tailN} 行 ---\n${tail}\n` +
    '[需要更多内容：用 grep 定位该文件，或 read_many 按 offset/limit 读取]'

  // 省不了就不动：行数 ≤ 头+尾 时（典型是单行/2 行超长 JSON），
  // 头尾本身就是全文，再加指针反而比原结果更长。实测过一次 +187 字符。
  // 先算指针再决定是否落盘，也顺手避免留下一堆无用的外置件。
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

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)
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
        const visible = new Set((scopeCtx.tools.schemas?.(agent) ?? []).map((schema) => schema.name))
        const lean = config.toolset.modes?.lean ?? {}

        // 黑名单优先：精确名 + 前缀，两者都先按实际可见集过滤，
        // 因为 restrict 遇到不存在的名字会抛错。
        const prefixes = Array.isArray(lean.denyPrefixes) ? lean.denyPrefixes : []
        const exact = Array.isArray(lean.deny) ? lean.deny : []
        const deny = new Set()
        for (const name of visible) {
          if (exact.includes(name)) deny.add(name)
          else if (prefixes.some((prefix) => typeof prefix === 'string' && prefix.length > 0 && name.startsWith(prefix))) deny.add(name)
        }
        if (deny.size > 0) {
          const dispose = scopeCtx.tools.restrict({ deny: [...deny] })
          disposers.push(dispose)
          toolsetLifters.set(sessionKey(agent.id), dispose)
          return
        }

        // 白名单兜底
        const requested = lean.tools
        if (!Array.isArray(requested) || requested.length === 0) {
          warn('G1', 'lean 模式既无 deny 也无 tools 白名单，跳过')
          return
        }
        const allow = requested.filter((name) => visible.has(name))
        if (allow.length === 0) {
          warn('G1', '白名单与实际工具集无交集，跳过（防止 restrict 抛错）')
          return
        }
        disposers.push(scopeCtx.tools.restrict({ allow }))
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
          handler: (invocation) => ({ kind: 'success', text: budgetReport(invocation?.agent?.id, config) }),
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
