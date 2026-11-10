# BFCL 官方源码子集

本目录提供 `bridge.py` 使用的官方文件环境，以及 `score.py` 使用的官方多轮评分函数，所有上游 Python 文件保持原内容不变。不是完整的 BFCL 安装，也不包含模型运行器。

- 来源仓库：`ShishirPatil/gorilla`
- 固定提交：`6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`
- 上游路径前缀：`berkeley-function-call-leaderboard/bfcl_eval/`
- `eval_checker/multi_turn_eval/func_source_code/gorilla_file_system.py`：文件、目录和文件系统类。
- `eval_checker/multi_turn_eval/func_source_code/long_context.py`：文件系统模块导入的配套常量。
- `eval_checker/multi_turn_eval/multi_turn_checker.py`：逐轮环境状态、工具结果和无关调用检查。
- `eval_checker/multi_turn_eval/multi_turn_utils.py`：评分时重新执行候选与参考工具调用。
- `constants/executable_backend_config.py`：官方环境类到模块的映射。
- `LICENSE`：该提交的仓库根目录 Apache-2.0 许可证。

固定版本入口：https://github.com/ShishirPatil/gorilla/tree/6ea57973c7a6097fd7c5915698c54c17c5b1b6c8/berkeley-function-call-leaderboard/bfcl_eval

使用已有 Python，在 `experiments/bfcl` 目录中导入 `bridge` 即可找到本地 `bfcl_eval` 源码。此阶段不需要安装第三方 Python 包。

本阶段用于 `multi_turn_base_1` 的 `GorillaFileSystem` 初始化、五种工具调用和官方多轮检查函数评分。评分所需的三个模块直接从项目参考副本 `intro/90_资料/BFCL_6ea57973/bfcl_eval` 按字节复制，未修改参考副本。题目和 ground_truth 读取同一固定提交的数据文件，没有重新生成参考答案。

| 新增上游文件 | SHA-256 |
| --- | --- |
| multi_turn_checker.py | b3b787515eda3bf0e365e39634a8fc7f831763f010f716d35d86f96fd5aab1b5 |
| multi_turn_utils.py | 9fdbd779ec715959c310445b54b431e91abaa8b45a302abb6fd8db8d61b62ba2 |
| executable_backend_config.py | 1214b960de5d86840e379007c70bc9570203e0b5a926ea740ff00c605a531e57 |

这条单题评分路径仅依赖标准库。score.py 在每组独立的新 Python 进程中调用 multi_turn_checker 和 multi_turn_irrelevance_checker，不调用 bfcl generate，不加载模型 SDK，也未执行完整 leaderboard CLI。
