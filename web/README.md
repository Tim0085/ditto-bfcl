# BFCL Web：同一套 Agent 流程的四种部署方式

## Introduction

研究问题：把 Agent 的四类能力（Context 记录本、Infer 问模型、Interaction 工具、Memory 记忆）拆成可以各自部署的 Worker 以后，能不能按负载给不同能力配不同的资源，从而提高 goodput（每秒答对的题数）或者省资源。

负载是 BFCL v4 网页搜索类 `web_search_no_snippet` 的 100 道题。每题是一个要查好几步的问题，模型用两个工具：

- `search_engine_query`：搜索。no_snippet 表示结果只给标题和网址，不给摘要，模型必须再打开网页看；
- `fetch_url_content`：抓网页正文。

搜索用 DeepSeek Search 代替官方的 SerpAPI，网页从互联网实时抓。模型 `deepseek-flash`，评分用官方 `agentic_checker`（最后的回答里含标准答案就算对）。

和 multi-turn 最大的不同：Web 的工具很重。剖析实测问模型约占干活时间的 61%，工具约占 39%；multi-turn 里工具不到 4%。

四种部署跑同一套图、同一份节点代码：

```text
Direct       不用 Ditto 的图和 Worker，主进程按同样的顺序直接调用同样的步骤（对照组）
Monolithic   [全][全][全][全][全][全][全][全]   每份 Worker 四类能力都接，一道题从头到尾交给一份
Uniform      [记][记][问][问][工][工][忆][忆]   拆开，每类平均分
Targeted     [记][问][问][问][问][工][工][忆]   拆开，按剖析出的负载分（实测 1/4/2/1）
```

每个方括号是一份 Worker，也就是一个子进程。每份一次只做一件事，其余的在它那一侧排队。任务并发 1、4、8 表示同时做几道题。三类比较：

- **Direct 对照**：用 Ditto 编排要多花多少时间、CPU、内存；
- **比法一**：三组都是 8 份，比谁快；
- **比法二**：每组按"每份一次只做一件事"开候选份数（Monolithic c 份；Targeted 问模型 c 份、工具 c 份、记录本和记忆各 1 份，即 10 / 18 份；Uniform 4c 份），速度相当时比谁省。Targeted 给工具 c 份是 Web 特有的：工具每次要一秒以上，只给 1 份，c 道题的抓网页全排在它后面。

代码解读，见 [`代码导读.md`](代码导读.md)。

## 和 multi-turn 的关系

这份代码从 multi-turn 子实验（同仓库的 `multiturn/`）移植过来，原则是能不改就不改：

- **和 multi-turn 逐字节相同的**：
  - 七张图 `graphs.ts`；
  - Worker 定义 `agent-core.ts`；
  - 绑定和挑最闲一份的规则：`bindings.ts`、`least-queued.ts`；
  - 问模型节点：`bfcl-sample.ts`、`bfcl-sample-node.ts`；
  - 记录本和记忆的存储：`context-store.ts`、`memory-store.ts`；
  - Direct 的步骤执行：`direct-steps.ts`。
- **只改了几行的**：
  - Loop（`task-loop.ts`，2 行）：开题时把 Web 工具的设置带给工具环境；
  - 分块（`scheduler/plan.ts`）：题目类别、剖析题号和默认代理地址换成 Web 的。
- **改得多的**：
  - 题目、工具和评分换成 Web 的；
  - 宿主出口多了一条搜索通道，单独记账；
  - 抓网页在容器里经代理直接抓；
  - 新增"输入超限"单题终态：请求体超过 1.8 MiB，或单次工具结果超过 1 MB。

  具体位置见 `代码导读.md` 第 6–8 节。

## Content

| 位置 | 内容 |
| --- | --- |
| `src/ts/` | Node 侧：Worker 定义、七张图、一道题的 Loop、部署（子进程、绑定、选份）、Direct |
| `src/ts/egress/` | 宿主出口：所有配置的模型请求和搜索请求都经过它；账本（模型、搜索各一本）、限流、重试；夹具、回放、真实三种后端 |
| `src/ts/scheduler/` | 总调度：冻结计划、切块、两条线推进、剖析、续跑、恢复、导出 |
| `src/ts/docker/` | 容器启动器、镜像内容核对、cgroup 采样 |
| `src/python/` | 工具桥（每道题一个 Python 进程，跑官方 `WebSearchAPI`）、Web 后端 `web_backend.py`（搜索转发、经代理抓网页）、官方评分调用 |
| `scripts/` | 调度命令入口 `t8a.ts`、离线和真实模式的保护器、镜像构建和发布、比对器、大表生成 `build-release.py` |
| `config/` | 出口配置（`egress.*.json`）；`stages/` 是各阶段配置（`live-*.json` 是真实阶段模板，上限留空） |
| `docker/` | `Dockerfile`、发布测试清单、镜像台账 `images.json` |
| `tests/` | 测试，按开发任务编号分前缀（`t3-` … `t11-`，`web-` 是移植到 Web 时加的）；`tests/python/` 是比对器测试 |
| `data/` | 100 道题、参考答案、离线夹具、工具说明 |
| `vendor/ditto/` | Ditto 0.1.5 编译版（课题组内部包 `@codesoul-co/ditto`，来源见 `SOURCE.md`） |
| `vendor/bfcl_eval/` | BFCL 官方代码子集：`WebSearchAPI`、`agentic_checker` 等（Apache-2.0，见其 `LICENSE`） |
| `vendor/python/` | 容器里官方 `WebSearchAPI` 要用的 Python 包（requests、bs4、html2text 等，各带自己的许可证） |

## Environments

- Node 24 以上，Python 3.12。
- 装依赖：`npm ci`（Ditto 从 `vendor/ditto` 本地安装，另外只有 `typescript` 和 `@types/node`）。Python 包不用装，跑时 `PYTHONPATH` 指到 `vendor/python`。
- 类型检查：`node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit`。
- 跑单个测试：`node --experimental-transform-types --test tests/agent-core.test.ts`。不要一次跑全部测试：有些要 Docker，有些要旧实验的回放材料或本机的锁目录。

## Attention

- **跑不了真实实验**：这里没有运行记录和模型密钥，也没有离线回放材料 `data/replay/`（41 MB，旧 Web 实验的模型记录和抓下来的网页正文，`web-` 开头的部分测试和比对器要用）。
- **代码里写死了原来那台机器的几处路径**：
  - 全机调度锁：`src/ts/scheduler/lock.ts`、`scripts/egress-live-launch.mjs`；
  - 临时目录前缀：`src/ts/scheduler/launcher.ts`、`scripts/t8a-stage.ps1`；
  - 保护器的禁区：`scripts/offline-guard-runtime.mjs`、`scripts/egress-live-guard.mjs`；
  - Python 路径 `E:/Anaconda3/python.exe`：`config/stages/*.json`；
  - 选题记录里旧实验的位置：`config/t9-selection.json`。

  只读代码不受影响。
- **真实模式下抓网页要走代理**：冻结计划时默认写入 `http://host.docker.internal:7897`（`src/ts/scheduler/plan.ts` 第 69 行），也就是原机器上的本机代理。`config-main.ts` 第 34–46 行会检查它。
