# dsh-context-budget

Per-step context ledger for DeepSeek Harness, plus four gates you can turn on one at a time.
**Default: accounting only, zero behavior change.**

每步上下文账本 + 四个可单独开关的闸门。**默认只开观测，不改行为。**

```sh
dsh plugin --profile web add github:JinShuXuan/dsh-context-budget
```

## 为什么（全部来自本机实测，不是估计）

| 观测项 | 实测值 | 来源 |
|---|---|---|
| 每步固定前缀 | 58.9K token（工具表 47.0K + 系统提示 11.9K） | 会话日志 `request/header` + `system/message` |
| 固定前缀占每步上下文 | ≈54% | 413.8M token / 3,754 步 ≈ 110K/步 |
| 工具表按来源 | computer-use 24 个、blender 15 个、image-gen 6 个、Agent Teams 12 个、hindsight 8 个 | 同上 |
| 工具结果体量长尾 | 2.3% 的结果占 40.5% 字符；单次均值仅 1.0–1.3K | 3,752 条结果 / 4.80M 字符 |
| 工具结果占全部内容 | 45.1% | 10.64M 总内容字符 |
| 一步一调 | 90.1% 的步只发 1 个工具调用，均值 0.99 | 3,782 步 |
| 用 shell 读文件 | 870 次（23.3%），shell 结果占结果体量 48.5% | 调用分类 |
| 重复读同一文件 | 224 次超额读 | 路径化统计 |

## 四个闸

| 闸 | 默认 | 作用 | 预期 |
|---|---|---|---|
| L0 观测 | **开** | 折叠 `request/header`、`system/message`、`step/start`、`tool/call`、`tool/result`、`assistant/message`，得到每步构成 | 0 token，无副作用 |
| G1 工具档 | 关 | 会话开头按 `cwd` 映射一次性 `tools.restrict()`，之后会话内不变 | -17~-28% |
| G2 长尾外置 | 关 | 结果 ≥ `thresholdChars` 时落盘，上下文只留头尾 + 指针 | -4%（35K 阈值）~-8%（8K 阈值） |
| G3 重复读指针 | 关 | 同 `path + offset + limit` 且 mtime 未变 → 回指针不重发 | -1~-2% |
| `read_many` | 关 | 一个调用读多个文件（用于把 calls/step 抬起来） | -12~-21%（步数） |

## 实测效果（2026-10-23，A/B）

同一 cwd 下取开 G1 前的会话（104 工具、65 步）与本会话（60 工具）对照。
两次系统提示 **md5 完全一致**（12,909 字符）、同模型 `deepseek-flash`，
且旧会话首步 `cacheRead=0`，是干净的 cache miss——差值只能来自工具表。

| 项 | 开 G1 前 | 现在 | 差值 |
|---|---|---|---|
| 工具数量 | 104 | 60 | -45（computer-use 24 / blender 15 / 画布与图片 6） |
| 工具表 JSON | 96,789 字符 | 48,540 字符 | -49.9% |
| 首步真实 prompt | 35,146 token | 18,920 token | **-16,226 token（-46.2%）** |
| 每步平均上下文（长会话） | 70,167 token | 预计 53,941 | **-23.1%**，整个 65 步会话省约 1.05M |

G2 实测 4 次触发：142,199 字符 → 23,093 字符，净省 83.6%。
G3 只在重复读大文件时才有意义（本次命中 1 次、样本太小，不作数）。

省的是**每步固定量** 16,226 token，所以对话越长占比越低：小会话约 -40%，长会话约 -23%。

2026-10-23 同机复测（两个 subagent，系统提示 11,056 字符与用户消息 **md5 均相同**、同模型）：

| | 全量 | lean | 差值 |
|---|---|---|---|
| 工具数量 | 98 | 54 | -45（+1 `read_many`） |
| 工具表 JSON | 93,686 字符 | 45,437 字符 | -51.5% |
| 首步真实 prompt | 32,422 token | 16,312 token | **-16,110 token（-49.7%）** |

同两次复测里，G2 把 35,292 字符压到 1,952 字符（-94.5%），且单行 8,606 字符的结果按预期**原样通过**（不省就不外置）。

## 配置

见 `cordis.patch.yml`（发布默认只开 L0，其余关闭）。要点：

- `enabled: false` → 整个插件不动任何东西（唯一的外科式回退）。
- `toolset.modes.lean.tools`：**必须写实际存在的工具名**。插件会先 `schemas()` 取真实集合再过滤；写错名字不会抛错，但会减少可用工具。为空则跳过 G1。
- `toolset.modes.lean.denyPrefixes` / `deny`：黑名单模式，按实际可见集过滤，写不存在的名字无害。
- `toolset.byPath`：`[{ prefix: 'D:\\path\\to\\dir', mode: 'lean' }]`，前缀匹配不区分大小写。
- `dedup.tools`：默认 `['read','ops_inspect_local_file']`。
- `read_many` 开启后建议配合 `toolset.modes.lean.tools` **不含 `read`**，这样"想省就切 lean"同时意味着"接受批量化"——这是刻意的绑定，不给"既要省又不改习惯"留中间地带。
- `debug: true`（或一个路径字符串）才写诊断日志；默认不写任何文件。日常看命中次数用 `/budget` 就够。
- 会话内被 G1 误挡：在 GUI 发 `/budget-full` 还原本会话工具集，无需重启。

### 配置写在哪一层（重要）

DSH 启动时会用**包内** `cordis.patch.yml` 重新物化 profile 的 `cordis.yml`，所以直接改 `cordis.yml` 的自定义会被下次启动覆盖（实测过一次：全开的配置被写回默认，且没有任何提示）。

要长期保留本机选择，写进 profile 的**用户覆盖层** `cordis.patch.yml`（与 `cordis.yml` 同目录）：

```yaml
- id: context-budget
  config:
    tail:
      enabled: true
      thresholdChars: 8000
```

该层应用后 `cordis.yml` 会显示新值，重启不再回退。G1 只在 agent 创建时收紧工具表，所以改完对**已存在的会话不生效**，开一个新会话即可（不必重启）。

## 命令

- `/budget` —— 本会话每步构成、工具调用数、闸门命中次数、最近一次真实 usage。
- `/budget-full` —— 撤销本会话的精简工具档（会重建一次前缀缓存）。

## 明确不做

- 不改模型、不改推理。
- 不向 system prompt 注入任何文本（每轮变化会打断前缀缓存）。
- 不在会话中途改变工具集（同上）。
- 不写会话事件、不新增会话事件类型（`fs` 拒绝是因为没有 `appendPluginRecord` 权限：那是 DSH 实验包保留的）。

## 已知限制（务必读）

1. **`accept + content` 会丢结构化 value。** `PostToolDecision` 的两个 `accept` 变体互斥：给 `content` 就没有 `value`。本插件只用它处理文本型结果（shell / read），**不要把这个机制套到有结构化输出的工具上**。
2. **`agent.ctx` 未在文档中显式承诺。** G1 依赖 `agent.ctx.tools.restrict()`；拿不到 `agent.ctx` 时插件**跳过 G1**，绝不用全局 ctx 收紧（那会影响所有会话）。
3. **L0 的 token 是估算。** 优先用 `assistant/message.data.usage`（含 `cacheReadTokens`）；缺 usage 时按 2.2 字符/token 粗估。**用于比较构成，不用于计费。**
4. **`/budget` 不进模型工具表**（`commands` 是 Human-command registry），但它被调用后产生的文本会进会话。
5. **没有导出 `Config`（zod）**：本插件不依赖 zod，因此配置不做 schema 校验，写错的键会被忽略。这是刻意的取舍，换来零依赖。
6. **G2 的按行头尾对"少行超长结果"无效。** 行数 ≤ `keepHeadLines + keepTailLines` 时（典型是单行 JSON），头尾本身就是全文，外置反而更长——所以插件会**跳过不省的结果**（实测曾出现 +187 字符，已修）。这类结果请靠 `thresholdChars` 之外的机制（如让工具自己分页）治理。

## 验收

1. **回退**：`enabled: false` 后，`tools/post-execute` 直接返回 `next()` 的结果，行为逐字还原。
2. **对账**：`/budget` 报的 `固定前缀` 与 `request/header` 里 tools+system 的体积一致；内容累计与 session 日志可复算值一致。
3. **对账差 >5% 就停工**，不进入 G2。

## 文件

- `index.js` —— Host 主插件（L0 / G1 / G2 / G3 / `/budget` / `/budget-full`）
- `read-many.js` —— `read_many` 工具（默认不注册）
- `cordis.patch.yml` —— 插入一行 Host 插件
- `locale/{en,zh}.json`、`icon.svg` —— 显示元数据与图标

## License

MIT
