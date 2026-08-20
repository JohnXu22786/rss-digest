# dsh-rss-digest

RSS/Atom 订阅聚合、智能摘要与每日 Markdown 简报 —— 一个原生的 **dsh bundle**（DeepSeek Harness，「一切皆是插件」）。

插件负责订阅源管理（本地持久化）、定时抓取、标题/内容相似去重、调用 harness 的 LLM 生成中英文简报摘要（模型不可用时自动降级为原文摘要），并将每日简报投递到实时会话和/或本地文件。同时附带一个共享同一套核心的独立 CLI。

- **dsh 集成**：遵循 bundle 规范（`dsh.bundle` + `cordis.patch.yml`），通过 `ctx.tools` 注册模型工具，通过 harness 的定时器接缝做周期任务，通过 Agent 跟进消息投递简报。详见[架构](#架构)。
- **零依赖核心**：抓取/解析/去重/存储/简报核心模块不依赖任何第三方包，只有 dsh 集成层会引入 `@deepseek-ai/*`。

---

## 功能

- **订阅管理** — 添加 / 移除 / 列出 / 启停 RSS 2.0、Atom、RSS 1.0（RDF）源；数据持久化到单个带版本号的 JSON 文档，原子写入、损坏自动隔离。
- **定时抓取** — 可配置轮询间隔、启动首轮、单请求超时、文档大小上限、重试次数与条目保留上限。
- **相似去重** — 精确哈希 + 词元 Jaccard 近似去重（中文按字符二元组），阈值可配置。
- **智能摘要** — 每次简报一次批量调用或逐条调用，中文/英文，输出长度受限；任何模型调用失败都自动降级为原文摘要。
- **每日简报** — 在指定时刻（支持 IANA 时区）生成 Markdown 简报，投递到实时会话（`Agent.followup`）和/或写入 `digests/<日期>.md`。
- **双入口** — 同一 `RssService` 同时驱动 dsh 插件（`ctx.tools` + 定时器）与独立 CLI。

## 安装（dsh）

bundle 即一个携带配置层的 npm 包。把它安装进 dsh profile 即可，加载器会自动读取 `dsh.bundle` 声明并应用 `cordis.patch.yml`：

```bash
# 在 profile 内，或使用 --profile <name> 从任意目录执行
dsh plugin --profile demo add ./path/to/dsh-rss-digest
# 或从 registry 安装：  dsh plugin --profile demo add dsh-rss-digest
```

profile 清单会把 `dsh-rss-digest` 写入 `dsh.profile.bundles`，bundle 的补丁随之插入插件行：

```yaml
- insert:
    - id: rss-digest
      name: 'dsh-rss-digest'
```

可选：在 profile 自己的 `$DSH_HOME/profiles/demo/cordis.patch.yml` 中按行 id 覆盖配置（省略的字段保持默认值）。完整注释示例见 [`examples/profile.cordis.patch.yml`](examples/profile.cordis.patch.yml)：

```yaml
- id: rss-digest
  config:
    fetch:
      intervalMinutes: 60
    summary:
      language: zh
      mode: batch
    digest:
      time: '08:30'
      timezone: Asia/Shanghai
      deliverTo: both
```

即使完全不配置，插件也能以合理的默认值启动；之后在对话中调用 `rss_add`，或在 shell 里执行 `dsh-rss-digest add` 即可注册订阅源。

> **Peer 依赖**：插件将所链接的 dsh 包（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis-plugin-timer`）声明为 peer。dsh profile 已自带这些包；若包管理器提示 peer 未满足，可在 profile 目录执行一次 `pnpm --dir $DSH_HOME/profiles/demo add` 安装这四个包（profile 链接器会补齐其余部分）。

## 配置项

所有字段均可省略；`apply(ctx, config)` 拿到的永远是补全默认值后的完整配置。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dataPath` | `''` | 存储文件路径。`''` 依次解析 `$DSH_RSS_DIGEST_DATA`、`$DSH_HOME/data/rss-digest/store.json`、`./.dsh-rss-digest/store.json`。 |
| `sources[]` | `[]` | 启动时合并的初始订阅：`{ url, title?, enabled? }`，重复 URL 忽略。 |
| `fetch.enabled` | `true` | 是否启用周期轮询。 |
| `fetch.intervalMinutes` | `60` | 轮询间隔（最小 5）。 |
| `fetch.onStartup` | `true` | 启动约 10 秒后执行一轮抓取。 |
| `fetch.requestTimeoutMs` | `15000` | 单请求超时。 |
| `fetch.sizeLimitBytes` | `1048576` | 接受的文档大小上限。 |
| `fetch.retries` | `2` | 瞬时故障（网络 / 5xx / 429 / 408）重试次数。 |
| `fetch.maxItemsPerSource` | `50` | 每源每轮保留的解析条目数（保留最新）。 |
| `fetch.storeContentChars` | `4000` | 存储摘要/正文的截断长度。 |
| `fetch.maxStoredItems` | `1000` | 条目保留上限（按抓取时间裁剪最旧）。 |
| `dedupe.threshold` | `0.9` | 近似重复判定所需的最小词元 Jaccard 相似度。 |
| `dedupe.compareContent` | `false` | 标题为空时是否用正文参与精确去重。 |
| `summary.enabled` | `true` | `false` 强制使用原文摘要。 |
| `summary.mode` | `batch` | `batch` = 每次简报一次模型调用；`single` = 逐条调用。 |
| `summary.language` | `zh` | 摘要正文语言：`zh` \| `en`。 |
| `summary.maxLength` | `800` | 摘要正文的硬性字符上限。 |
| `summary.maxTokens` | `1024` | 模型调用的 token 预算提示。 |
| `summary.provider` | `''` | dsh provider 路由；`''` = 第一个已注册 provider。 |
| `summary.model` | `''` | 模型 id；`''` = 该 provider 第一个列出的模型。 |
| `digest.enabled` | `true` | 是否启用每日简报调度。 |
| `digest.time` | `'08:00'` | 触发时刻（`HH:MM`）。 |
| `digest.timezone` | `''` | IANA 时区；`''` = 主机本地时间。 |
| `digest.maxItems` | `20` | 每份简报的最大条目数。 |
| `digest.deliverTo` | `both` | `agents` \| `file` \| `both` —— 投递到实时会话、写入 `digests/<日期>.md`、或两者。 |
| `digest.includeItemLinks` | `true` | 条目列表是否带原文链接（仅 http/https）。 |

## 模型工具（ctx.tools）

插件通过 `ctx.tools` 注册以下工具，模型可在任意会话中调用：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `rss_list` | — | 列出订阅（id、url、标题、启停状态）。 |
| `rss_add` | `url`（必填）、`title?` | 订阅一个源，返回新源信息。 |
| `rss_remove` | `id`（必填） | 退订并删除该源的条目。 |
| `rss_fetch` | `id?` | 立即抓取单个（或全部）源；自动去重。 |
| `rss_digest` | `language?`、`mode?`、`maxItems?` | 对未入简报的条目生成 Markdown 简报并返回。 |

对话示例：

```
user: 帮我把 Hacker News 加进来，然后生成今天的简报
model: [rss_add: https://hnrss.org/frontpage]
       [rss_fetch]
       [rss_digest: language=zh]
```

## 调度模型

dsh 的 `ctx.jobs` 注册表面向长时间运行的任务*执行*（bash / subagent 类任务），并非 cron 定时 API。harness 的调度接缝是定时器服务（`ctx.timeout` / `ctx.interval`，通过 `inject: ['timer']` 注入）——本插件即使用该接缝：

- 抓取周期：`ctx.interval`（间隔可配置），外加启动首轮；
- 每日简报：自续订的 `ctx.timeout` —— 每次执行后重新计算下一个 `HH:MM` 时刻（基于 `Intl`，兼容时区与夏令时），因此简报始终锚定在配置的墙钟时间上；运行中加锁防止重叠执行。

## 投递方式

harness 没有广播 API；插件向实时会话投递内容的方式是给每个运行中的 `Agent` 排队一条 user 角色消息（`Agent.followup`，与内置任务通知相同的机制）。`digest.deliverTo = agents` 即此行为；`file` 在存储文件旁写入 `digests/<日期>.md`；默认 `both`。没有 agent 服务的 headless profile 只走文件/日志路径，插件启动时并不依赖 agent 服务。

## CLI

同一套核心，无需 harness：

```bash
dsh-rss-digest add https://hnrss.org/frontpage
dsh-rss-digest fetch
dsh-rss-digest digest --lang zh --out digest.md
dsh-rss-digest list --items
dsh-rss-digest status
```

运行 `dsh-rss-digest help` 查看完整命令参考。CLI 通过 OpenAI 兼容的 `/chat/completions` 接口调用模型（默认 DeepSeek：`https://api.deepseek.com`，密钥来自 `DEEPSEEK_API_KEY`，模型 `deepseek-chat`）；无凭据时降级为原文摘要——与插件在 harness LLM 失败时的行为一致。

## 数据

单个 JSON 文档（`schema: 1`），原子写入；损坏文件会被改名隔离（`.corrupt-<时间戳>`）而不是删除。订阅 URL（含查询串，签名源经常需要）按原样持久化；日志中的 URL 不显示查询串。环境变量：`DSH_RSS_DIGEST_DATA`（存储路径）、`DEEPSEEK_API_KEY`（CLI）。

## 架构

```
src/
  index.ts        dsh bundle 入口：name / inject / Config / apply
  config.ts       Config 接口 + Schemastery 校验 schema（含默认值）
  tools.ts        rss_list / rss_add / rss_remove / rss_fetch / rss_digest
  scheduler.ts    定时器接缝调度（抓取周期 + 自续订每日简报）
  delivery.ts     Agent.followup 投递 + digests/<日期>.md 文件
  dsh-llm.ts      ctx.llm 适配（流式调用、provider/model 解析）
  service.ts      RssService —— 核心编排（不依赖 dsh）
  parser.ts       零依赖的 RSS 2.0 / Atom / RSS 1.0 解析器
  fetcher.ts      带超时、大小上限、重试与编码探测的抓取器
  dedupe.ts       文本归一化、精确哈希、词元 Jaccard 相似度
  store.ts        带版本号的 JSON 持久化（原子写入、损坏隔离）
  summarizer.ts   LLM + 原文摘要（降级契约）
  digest.ts       Markdown 简报渲染（安全链接处理）
  llm-client.ts   OpenAI 兼容 REST 客户端（CLI）
  cli.ts          独立 CLI 入口（bin: dsh-rss-digest）
```

核心层（`service.ts` 及其以下）**零**运行时依赖；只有 dsh 集成层引入 `@deepseek-ai/*`。

## 开发

```bash
npm install
npm run build     # tsc -> lib/
npm test          # build + node --test（79 个用例：解析、去重、存储、
                  # 抓取、时间、摘要、简报、服务、CLI、接线）
node lib/cli.js status
```

需要 Node >= 22.18。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
