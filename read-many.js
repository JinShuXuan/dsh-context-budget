/**
 * read_many —— 一个调用读多个文件。
 *
 * 设计约束（见 README）：
 * - 只读，不写；
 * - 每个文件独立截断，整体再截断，绝不返回无界内容；
 * - 参数是 JSON Schema（原生 ToolDefinition 形态），不依赖 defineTool。
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const MAX_FILES = 20

function clampInt(value, fallback, min, max) {
  const n = Number.isInteger(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

function toLines(text) {
  // 保留尾部空行语义：只按 \n 切，不 trim 内容
  return text.split('\n')
}

/**
 * 读一个文件：优先走 ctx.fs。
 *
 * 为什么必须走 ctx.fs：DSH 的 fs-observation-policy 要求“编辑文件前必须先读过它”。
 * node:fs 的读取不会被记录成观测，于是 read_many 读过的文件仍然不能编辑。
 * 走 ctx.fs 才能让这次读取成为一条观测，read_many 才算真正替代 read。
 *
 * 返回 null 表示目标不是普通文件（由调用方标注 skipped）。
 */
async function readFileVia(fsService, abs, cwd, signal) {
  if (fsService?.resolve && fsService?.readText) {
    try {
      const target = await fsService.resolve(abs, { cwd, signal })
      if (target) return await fsService.readText(target, signal)
    } catch {
      /* 落到 node:fs 兜底 */
    }
  }
  const info = await stat(abs)
  if (!info.isFile()) return null
  return await readFile(abs, 'utf8')
}

export function registerReadMany(ctx, config) {
  const rm = config.readMany ?? {}
  let fsService
  try {
    fsService = typeof ctx.get === 'function' ? ctx.get('fs') : ctx.fs
  } catch {
    fsService = undefined
  }
  const defaultLimit = clampInt(rm.defaultLimit, 400, 1, 5000)
  const maxCharsPerFile = clampInt(rm.maxCharsPerFile, 20000, 500, 200000)
  const maxTotalChars = clampInt(rm.maxTotalChars, 60000, 1000, 400000)

  const dispose = ctx.tools.register({
    name: 'read_many',
    description:
      'Read several files in ONE call. Use this whenever you need the content of 2 or more files, ' +
      'instead of calling read once per file. Each file is truncated independently; a global cap trims the batch. ' +
      'Prefer this over shell commands like Get-Content/cat for reading file contents.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to read, in order.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Absolute or workspace-relative file path.' },
              offset: { type: 'number', description: '1-based first line to read. Default 1.' },
              limit: { type: 'number', description: `Maximum lines. Default ${defaultLimit}.` },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
        maxChars: {
          type: 'number',
          description: 'Optional cap for the whole batch output in characters.',
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const signal = exec?.signal
      const list = Array.isArray(args?.files) ? args.files.slice(0, MAX_FILES) : []
      if (list.length === 0) return 'read_many: no files requested.'

      const batchCap = clampInt(args?.maxChars, maxTotalChars, 1000, 400000)
      const cwd = typeof exec?.cwd === 'string' ? exec.cwd : process.cwd()
      const parts = []
      let used = 0
      let skipped = 0

      for (const item of list) {
        if (signal?.aborted) {
          parts.push('--- [aborted] ---')
          break
        }
        if (typeof item?.path !== 'string' || item.path.length === 0) {
          parts.push('--- (missing path) ---')
          continue
        }
        const abs = path.isAbsolute(item.path) ? item.path : path.resolve(cwd, item.path)
        if (used >= batchCap) {
          skipped += 1
          continue
        }
        try {
          const offset = clampInt(item?.offset, 1, 1, Number.MAX_SAFE_INTEGER)
          const limit = clampInt(item?.limit, defaultLimit, 1, 5000)
          const text = await readFileVia(fsService, abs, cwd, signal)
          if (text === null) {
            parts.push(`--- ${item.path} ---\n(skipped: not a regular file)`)
            continue
          }
          const lines = toLines(text)
          const start = offset - 1
          const slice = lines.slice(start, start + limit)
          const end = start + slice.length
          let body = slice.join('\n')
          let truncated = end < lines.length

          if (body.length > maxCharsPerFile) {
            body = body.slice(0, maxCharsPerFile)
            truncated = true
          }
          if (used + body.length > batchCap) {
            const room = Math.max(0, batchCap - used)
            body = body.slice(0, room)
            truncated = true
          }
          used += body.length

          const header =
            `--- ${item.path}（第 ${offset}–${end} 行 / 共 ${lines.length} 行${truncated ? '，已截断' : ''}）---`
          parts.push(`${header}\n${body}`)
          if (truncated) {
            parts.push(`[read_many: 该文件已截断，完整内容用 read_many 带 offset/limit 继续读，或用 grep 定位]`)
          }
        } catch (error) {
          parts.push(`--- ${item.path} ---\n(error: ${error instanceof Error ? error.message : String(error)})`)
        }
      }

      if (skipped > 0) {
        parts.push(`[read_many: ${skipped} 个文件因批量上限被跳过，可调小 limit 或调大 maxChars]`)
      }
      return parts.join('\n\n')
    },
  })

  return dispose
}
