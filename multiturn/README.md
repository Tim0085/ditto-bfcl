# BFCL multi-turn：同一套 Agent 流程的四种部署方式

## Introduction

研究问题：把 Agent 的四类能力（Context 记录本、Infer 问模型、Interaction 工具、Memory 记忆）拆成可以各自部署的 Worker 以后，能不能按负载给不同能力配不同的资源，从而提高 goodput（每秒答对的题数）或者省资源。

负载是 BFCL multi-turn 的 800 道题（base、long_context、miss_func、miss_param 四类，各 200 道），模型 `deepseek-flash`。四种部署跑同一套图、同一份节点代码：

```text
Direct       不用 Ditto 的图和 Worker，主进程按同样的顺序直接调用同样的步骤（对照组）
Monolithic   [全][全][全][全][全][全][全][全]   每份 Worker 四类能力都接，一道题从头到尾交给一份
Uniform      [记][记][问][问][工][工][忆][忆]   拆开，每类平均分
Targeted     [记][问][问][问][问][问][工][忆]   拆开，按剖析出的负载分（实测 1/5/1/1）
```

每个方括号是一份 Worker，也就是一个子进程。每份一次只做一件事，其余的在它那一侧排队。任务并发 1、4、8 表示同时做几道题。三类比较：

- **Direct 对照**：用 Ditto 编排要多花多少时间、CPU、内存；
- **比法一**：三组都是 8 份，比谁快；
- **比法二**：每组只开刚好不会在问模型这一步排队的份数，速度相当时比谁省。

代码解析，见 [`代码导读.md`](代码导读.md)。

## Content

| 位置 | 内容 |
| --- | --- |
| `src/ts/` | Node 侧：Worker 定义、七张图、一道题的 Loop、部署（子进程、绑定、选份）、Direct |
| `src/ts/egress/` | 模型出口：所有配置的模型请求都经过它；账本、限流、重试；夹具、回放、真实三种后端 |
| `src/ts/scheduler/` | 总调度：冻结计划、切块、两条线推进、续跑、恢复、导出 |
| `src/ts/docker/` | 容器启动器、镜像内容核对、cgroup 采样 |
| `src/python/` | 工具桥（每道题一个 Python 进程跑 BFCL 模拟环境）和官方评分调用 |
| `scripts/` | 调度命令入口 `t8a.ts`、离线和真实模式的保护器、镜像构建和发布、比对器 `compare.py`、大表生成 `build-release.py` |
| `config/` | 模型出口配置；`stages/` 是各阶段的配置（`live-*.json` 是真实阶段模板，上限留空） |
| `docker/` | `Dockerfile`、发布测试清单、镜像台账 |
| `tests/` | 测试，按开发任务编号分前缀（`t3-` … `t11-`）；`tests/python/` 是比对器测试 |
| `data/` | BFCL multi-turn 四类题目、参考答案、工具环境初始状态 |
| `vendor/ditto/` | Ditto 0.1.5 编译版（课题组内部包 `@codesoul-co/ditto`，来源见 `SOURCE.md`） |
| `vendor/bfcl_eval/` | BFCL 官方评分代码（Apache-2.0，见其 `LICENSE`） |
| `vendor/python/` | 容器里评分要用的 `mpmath` |
| `docs/` | `02_程序结构规划.md`（模块和接口，最值得看）、`01_离线验证规划.md`、`T8b_容器恢复手册.md`（怎么跑、停了怎么办） |

## Environments

- Node 24 以上，Python 3.12。
- 装依赖：`npm ci`（Ditto 从 `vendor/ditto` 本地安装，另外只有 `typescript` 和 `@types/node`）。
- 类型检查：`node node_modules/typescript/lib/tsc.js -p tsconfig.json --noEmit`。
- 跑单个测试：`node --experimental-transform-types --test tests/agent-core.test.ts`。不要一次跑全部测试：有些要 Docker，有些要旧实验的运行记录或本机的锁目录。

## Attention

- **跑不了真实实验**：这里没有运行记录、旧实验的回放记录（离线四关要用），也没有模型密钥。
- **代码里写死了原来那台机器的几处路径**：
  - 全机调度锁：`src/ts/scheduler/lock.ts`、`scripts/egress-live-launch.mjs`；
  - 临时目录前缀：`src/ts/scheduler/launcher.ts`、`scripts/t8a-stage.ps1`；
  - 保护器的禁区：`scripts/offline-guard-runtime.mjs`、`scripts/egress-live-guard.mjs`；
  - Python 路径 `E:/Anaconda3/python.exe`：`config/stages/*.json`；
  - 选题记录里旧实验的位置：`config/t9-selection.json`。
