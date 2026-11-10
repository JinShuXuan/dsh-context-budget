# dsh-context-budget

**每步上下文账本，外加三个可以单独开关的闸门。**

一个 DeepSeek Harness 插件：先把「每一步到底重发了多少 token」变成可看的数字，再决定要不要动刀。
默认只观测，零行为变化——装上不会改变任何回答。

> Per-step context ledger for DeepSeek Harness, with three opt-in gates.
> Accounting is on by default; every gate is off until you enable it.

```sh
dsh plugin --profile <profile> add github:JinShuXuan/dsh-context-budget
```

装完多出 **5 条命令**（全是只读观察或你自己触发的改动），不新增任何模型工具。

---

## 为什么

这些数字来自一台真实机器上连续 3 天的会话日志，不是推演：

| 观测项 | 实测值 |
|---|---|
| 3 天输入 token | 514.7M（缓存命中 507.8M，**98.7%**） |
| 平均每步上下文 | **133,040** token |
| 每步固定前缀 | 58.9K（工具表 47.0K + 系统提示 11.9K）→ 占每步 **44%** |
| 工具结果长尾 | ≥8K 字符的结果只占 2.3% 的条数，却吃了 **40.5%** 的结果字符 |
| 调用密度 | 90.1% 的步只发 **1 个** 工具调用，均值 0.99 |
| 账单集中度 | 前 3 个会话占 **70.6%** |

结论很直白：**贵的是"每步重发"和"个别超长会话"**，不是回答长度。
所以这个插件不去管推理，只管三件可测的事：**重发什么、重发多大、要不要重复付**。

---

## 五条命令

| 命令 | 作用 |
|---|---|
| `/budget` | 本会话账本：回合／步／调用密度、每步固定前缀、工具表 Top5 体积、技能目录占比、**消耗 Top3 归因**、**增速预测**（距 `warnAtTokens`／`windowTokens` 各还剩几步）、闸门命中、真实 usage |
| `/budget tools` | 工具调用频次榜：每个工具被调几次、平均每次多少字符 |
| `/budget spill` | 外置目录索引：最近 20 条，`/budget spill <n>` 读回原文；`/budget spill clean` 按保留策略清理 |
| `/budget doctor` | 只读自检 7 项：spill 体积／索引一致性／条数对比／G2·G3 命中率／开关状态／阈值是否自相矛盾／增长最快工具 |
| `/budget-set key=value …` | 改配置并落盘（G2/G3 立即生效，`toolset.*` 新会话生效）；不带参数列出当前覆盖 |
| `/budget-full` | 撤销本会话的工具档，恢复全量工具（会重建一次前缀缓存） |

阈值来源会标在数字后面：是包内默认、profile 覆盖层，还是你用 `/budget-set` 落的盘，一眼看得出。

---

## 三个闸门

全部默认**关**。想省再开，逐个开、逐个量。

| 闸门 | 作用 |
|---|---|
| **L0 观测**（默认开） | 折叠会话事件，算出每步构成、固定前缀、闸门命中、真实 usage。0 token、无副作用 |
| **G1 工具档** | 会话开头按 **schema 体积**把工具表裁到预算内（与插件名无关，新装插件的工具同样纳入；`protect` 里的永远保留） |
| **G2 长尾外置** | 结果超过字符阈值就落盘，上下文只留 **前 1200 / 后 600 字符** + 指针，需要时按指针读回 |
| **G3 重复读** | 同 path+区间且文件未变 → 直接回指针，不重发内容 |
| `read_many` | 一次调用读多个文件（可选注册的工具） |

---

## 实测效果

**G1 工具档**（同 cwd、系统提示 md5 完全一致、同模型，两个 subagent 对照）：

| | 全量 | 精简 | 差值 |
|---|---|---|---|
| 工具数量 | 98 | 54 | −45 |
| 工具表 JSON | 93,686 字符 | 45,437 字符 | **−51.5%** |
| 首步真实 prompt | 32,422 token | 16,312 token | **−16,110（−49.7%）** |

省的是**每步固定量**，所以对话越长占比越低：小会话约 −40%，长会话约 −23%。

**G2 长尾外置**（字符预算后，削减率只与大小有关）：`1 − 1800 / 结果字符数`

| 结果大小 | 外置后 | 削减 |
|---|---|---|
| 10,532 字符 | 1,766 | 83% |
| 48,393 字符 | 1,600 | 97% |

**G3** 只在重复读大文件时有意义，量级很小——不要指望它。

---

## 配置：三级优先级

```
/budget-set 落盘值   >   profile 覆盖层（cordis.patch.yml）   >   包内默认
```

落盘文件在 `$DSH_HOME/context-budget.json`，重启仍在。三种改法：

**① 对话里改（推荐，立即生效）**

```
/budget-set tail.enabled=true tail.thresholdChars=8000
/budget-set toolset.enabled=true toolset.strategy=budget toolset.budgetTokens=25000
/budget-set toolset.protect=["read","write","edit","ops_bash"]
```

**② 插件管理页**：本插件导出了 `Config` schema（依赖 `@deepseek-ai/schemastery`；解析不到时自动降级为无表单，插件照常工作）。**注意**：`link:` 手工挂载的包不会出现在插件管理器的 bundle 清单里，因此页面上可能没有入口——那就用 ① 或 ③。

**③ 直接写 YAML**：写进 profile 的用户覆盖层 `cordis.patch.yml`，别写 `cordis.yml`（启动时会被重新物化覆盖）。

---

## 0.3.x 新增

- `/budget-doctor`、`/budget-spill` 升为**独立命令**，命令面板里直接可见，不用记参数。
- 自检 7 项：spill 体积、索引一致性（孤儿文件／悬空条目）、条数对比、命中率、开关、阈值矛盾、增长最快工具。
- spill 清理：`/budget spill clean` 按 `retentionDays` / `maxBytes` 回收，索引同步裁剪。
- `/budget` 增加**消耗 Top3 归因**与**增速预测**（"照这个速度，还有 N 步到阈值"）。
- `/budget tools` 增加工具频次榜（次数／字符／均值）。
- 命令参数读取容错：不同宿主版本的 invocation 形状都能正确解析子命令。

---

## 隐私与边界（明确不做）

- **纯本地**：零依赖、无网络请求、不把任何内容发到外部。
- **不改模型、不改推理**。插件动的是输入和观测，不是"让它想得更深"。
- **不往 system prompt 注入任何文本**。每轮都变的内容会打断前缀缓存，省下的不如赔的多。
- **不在会话中途改变工具集**。同上；G1 只在 `agent/created` 时裁一次。
- **不写会话事件、不新增事件类型**。
- **不抢编排**：只计量与削减单次输入，不做压缩、不做任务调度。

---

## 已知限制

1. **预览是字符预算**：`keepHeadChars` / `keepTailChars`；都为 0 时才回落到按行。极短行数的超长结果（单行 JSON）现在也会外置。
2. **`accept + content` 会丢结构化 value**：只对文本型结果使用，别把机制套到有结构化输出的工具上。
3. **`agent.ctx` 没有文档承诺**：拿不到时 G1 整体跳过，绝不用全局 ctx 收紧（那会影响所有会话）。
4. **L0 的 token 是估算**：优先用 `assistant/message.data.usage`（含 `cacheReadTokens`），缺样本才按 2.2 字符/token 粗估。**用于比较构成，不用于计费。**
5. **`read_many` 不能替代 `read`**：它走 `ctx.fs` 读取，但 DSH 文档明确写 "Direct ctx.fs reads emit no fs/observed"，所以它不满足"编辑前必须先读"的策略——因此**不要**在精简档里把 `read` 裁掉。
6. **`/budget` 系列不进模型工具表**（commands registry），但它们的输出会进会话。
7. **G2 的收益依赖会话长度**：一条结果进入上下文后会被重发，剩余步数越多越划算；短任务里外置可能持平甚至略亏。

---

## 通用性

- 零依赖、纯 host 侧、跨平台（Windows / macOS / Linux）。
- 所有扩展点都是文档承诺的接口：`session/event`、`agent/created`、`tools/post-execute`、`tools.register`、`commands`。
- 默认配置保守（只开 L0）；别人的机器上不会因为缺少本地插件而报错——黑名单/前缀匹配都会先按实际可见集过滤。
- `Config` schema 依赖 `@deepseek-ai/schemastery`；缺失时降级，不阻塞加载。

---

## English

A per-step context ledger for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It measures what every step actually re-sends (fixed prefix vs. new content vs. tool results), then offers
three opt-in gates: a schema-budgeted tool table, long-tail result externalization, and duplicate-read pointers.
Zero dependencies, no network requests, no model changes, and nothing injected into the system prompt.
Observation is on by default; every gate is off until you enable it.

```sh
dsh plugin --profile <profile> add github:JinShuXuan/dsh-context-budget
```

## License

MIT