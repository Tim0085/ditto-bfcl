"""Build a release package (workbook, CSV, figures, README, reading guide, data dictionary) from export directories.

T9 C1. Reads only export directories written by `scripts/t8a.ts export` (plus the run root's plan.json
and targeted-split.json, read-only) and writes a new package directory. Python 3, openpyxl; matplotlib
for figures. Format follows the user's earlier requests: white background, bold plain header, SimSun for
Chinese and Times New Roman for Latin text and numbers, gridlines on, no frozen top rows, header in row 1,
blank for missing values, full precision underneath. The workbook default font (font 0, the Normal style,
used by blank cells) is Times New Roman too, so no cell falls back to Calibri.

Usage (run with -B, TEMP/TMP on F:):
  python -B scripts/build-release.py --out <new dir> --title <name> --package-root <experiment package root>
      --code-version <treeSha256 of the frozen code> --export-command "<export command with {root}>"
      --manifest <new manifest json outside the package>
      --stage "2a 剖析=<export dir>=<run root>" --stage "2b 小批=<export dir>=<run root>"
      [--profile-report <profile-basis json>]

The package holds finished products only (workbook, CSV, figures, three generated documents). Every path
written into the documents is relative to the experiment package root (for example
runs/live/live-pilot-001/egress/ledger.jsonl), so the package stays correct when it is moved under
releases/. Exports are not copied; the README gives the command that regenerates them. The package is
written to <out>.partial first and renamed only after the path self-check passes; an existing <out>,
<out>.partial or manifest is refused.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
import statistics
import sys
from collections import Counter, OrderedDict, defaultdict
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock
from openpyxl.cell.text import InlineFont
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from openpyxl.utils.indexed_list import IndexedList

CHINESE_FONT = "SimSun"
LATIN_FONT = "Times New Roman"
FONT_SIZE = 10
BEIJING = dt.timezone(dt.timedelta(hours=8))
CATEGORY = {"multi_turn_base": "base", "multi_turn_miss_func": "miss_func", "multi_turn_miss_param": "miss_param", "multi_turn_long_context": "long_context", "web_search_no_snippet": "web_search_no_snippet"}
CATEGORY_ORDER = list(CATEGORY)
CAPS = ["Context", "Infer", "Interaction", "Memory"]
CAP_CN = {"Context": "挑选上下文", "Infer": "问模型", "Interaction": "工具", "Memory": "记忆", "All": "全能", "main": "主进程", "python": "Python 工具进程", "entry": "容器入口 Python", "init": "容器 init"}
GROUP_ORDER = {"Direct": 0, "Monolithic": 1, "Uniform": 2, "Targeted": 3}
COMPARISON_CN = {"direct": "Direct 对照", "equal": "比法一", "cost": "比法二"}
OUTCOME_CN = {"completed": "正常完成", "request_limit": "单题请求超限", "input_limit": "输入超限", "output_limit": "输出超限", "model_output": "模型输出出错", "runtime_failure": "运行失败"}


# ---------------------------------------------------------------- reading

def read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rows.append(json.loads(line))
    return rows


# Spellings that must never reach a generated document: absolute F: paths, scratch and draft directories,
# offline evidence directories. A hit stops the build before the package is renamed into place.
FORBIDDEN_IN_DOCS = ["F:/", "F:\\", "_tmp", "release-draft", "runs/offline/t9-"]
PACKAGE_NAME = "01_bfcl_multiturn"  # set from --package-root in main()


def forbidden_hits(text):
    return [p for p in FORBIDDEN_IN_DOCS if p.lower() in text.lower()]


def package_relative(path, package_root):
    """Posix path of `path` relative to the experiment package root; refuses paths outside it."""
    rel = os.path.relpath(os.path.abspath(path), os.path.abspath(package_root))
    if rel == os.curdir or rel.startswith(os.pardir) or os.path.isabs(rel):
        sys.exit("run root is not inside --package-root: %s" % path)
    return rel.replace("\\", "/")


def clean_note(text, plan_ref):
    """Drop comma-separated clauses that name a forbidden location (e.g. an offline evidence directory in
    the price-table source) and point to the full original text instead."""
    if not text:
        return text
    parts = [p for p in str(text).replace(",", "，").split("，")]
    kept = [p.strip() for p in parts if p.strip() and not forbidden_hits(p)]
    if len(kept) == len([p for p in parts if p.strip()]):
        return str(text)
    return "，".join(kept) + "（原文见 `%s` 的 `stage.prices.source`）" % plan_ref


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


class Stage:
    def __init__(self, label, export_dir, run_root, package_root):
        self.label, self.export, self.root = label, Path(export_dir), Path(run_root)
        self.rel = package_relative(self.root, package_root)
        e = self.export
        self.meta = read_json(e / "metadata.json")
        self.summary = read_json(e / "summary.json")
        self.tasks = read_json(e / "tasks.json")
        self.blocks = read_json(e / "blocks.json")
        self.latency = read_json(e / "latency.json")
        self.phases = read_json(e / "stepPhases.json")
        self.processes = read_json(e / "processResources.json")
        self.block_load = read_json(e / "blockLoad.json")
        self.workers = read_jsonl(e / "workers.jsonl")
        self.requests = read_jsonl(e / "modelRequests.jsonl")
        self.egress = read_jsonl(e / "egressLoad.jsonl")
        self.plan = read_json(self.root / "plan.json")
        self.split = read_json(self.root / "targeted-split.json") if (self.root / "targeted-split.json").exists() else None
        self.configs = {c["id"]: c for c in self.plan["stage"]["configs"]}
        self.rounds = sorted({r["round"] for r in self.summary})
        self.profiling = all(b.get("id") == "profile" for b in self.plan["stage"]["batches"])


# ---------------------------------------------------------------- helpers

def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def total(values):
    values = list(values)
    if not values or any(not num(v) for v in values):
        return None
    return sum(values)


def total_known(values):
    return sum(v for v in values if num(v))


# T9 C3: one definition for the 已确认实付 column of every table that has it.
CHARGED_DEFINITION = ("用户用 scripts/confirm-fee.ts 确认“已扣费”的请求，确认的实付金额之和。是用户确认的实付，不按价表算，不分谷价、峰价；"
                      "这些请求的用量账本里没有，不在 token 和谷价、峰价已知费用里。本行没有“确认已扣费”的请求时留空（不填 0）。")


def charged_cny(summaries):
    """已确认实付: sum of the user-confirmed amounts; blank (None) when the rows have no charged confirmation."""
    if not total_known(r.get("confirmedChargedRequests") for r in summaries):
        return None
    return total_known(r.get("confirmedChargedCny") for r in summaries)


def ratio(a, b):
    return a / b if num(a) and num(b) and b > 0 else None


def quantile(values, p):
    v = sorted(x for x in values if num(x))
    if not v:
        return None
    i = (len(v) - 1) * p
    lo = math.floor(i)
    return v[lo] + (v[math.ceil(i)] - v[lo]) * (i - lo)


def mean(values):
    v = [x for x in values if num(x)]
    return sum(v) / len(v) if v else None


def vmax(values):
    v = [x for x in values if num(x)]
    return max(v) if v else None


def vmin(values):
    v = [x for x in values if num(x)]
    return min(v) if v else None


def yes(v):
    return None if v is None else ("是" if v else "否")


def beijing(ms):
    if not num(ms):
        return None
    return dt.datetime.fromtimestamp(ms / 1000, tz=BEIJING).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def beijing_iso(text):
    if not text:
        return None
    try:
        t = dt.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return t.astimezone(BEIJING).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def group_of(cid, stage):
    return stage.configs[cid]["group"]


def copies_text(copies, group):
    if group == "Direct" or not copies:
        return None
    if "All" in copies:
        return "全能 %d" % copies["All"]
    return "/".join(str(copies.get(k, 0)) for k in CAPS)


def copies_of(stage, cid):
    """Copies as frozen in the plan's units (Targeted 'profile' is resolved per unit)."""
    for job in stage.plan["jobs"]:
        for u in job["units"]:
            if u["configId"] == cid and isinstance(u.get("copies"), dict):
                return u["copies"]
    c = stage.configs[cid].get("copies")
    return c if isinstance(c, dict) else None


def config_sort(stage, cid):
    c = stage.configs[cid]
    return (c["c"], GROUP_ORDER.get(c["group"], 9), cid)


def cat_sort(cat):
    return CATEGORY_ORDER.index(cat) if cat in CATEGORY_ORDER else 99


# ---------------------------------------------------------------- column specs
# Each column: (field, Chinese name, unit, definition, source, kind)
# kind: text | int | float | pct | bool | time


def col(field, name, unit, definition, source, kind="float"):
    return {"field": field, "name": name, "unit": unit, "definition": definition, "source": source, "kind": kind}


ID_COLS = [
    col("stage", "阶段", "", "运行阶段；2a 是剖析（只跑 Uniform 8 份并发 1，用来定 Targeted 的分法），2b 是小批试跑。", "命令行 --stage 标签", "text"),
    col("configId", "配置编号", "", "冻结计划里的配置标识，形如 组-份数-c并发。", "plan.json stage.configs[].id", "text"),
    col("group", "组", "", "Direct、Monolithic、Uniform、Targeted 四组之一。", "plan.json stage.configs[].group", "text"),
    col("copies", "份数", "上下文/问模型/工具/记忆", "每类能力的 Worker 份数；Monolithic 写“全能 n”；Direct 没有 Worker，留空。", "plan.json jobs[].units[].copies", "text"),
    col("copyCount", "总份数", "份", "Worker 份数之和；Direct 为 0。", "summary.copyCount", "int"),
    col("c", "并发", "题", "同一配置同时推进的题数上限。", "plan.json stage.configs[].c", "int"),
]
CAT_COL = col("category", "题型", "", "冻结计划的 BFCL 题型，Web 段用 web_search_no_snippet。", "summary.category", "text")


def search_columns(layer):
    return [col("searchAttempts", "搜索次数", "", "搜索上游预留次数，含重试与未知。", layer + ".searchAttempts", "int"),
            col("searchCny", "搜索费用（元）", "", "已结算的搜索费用，未知预留另记，费用不分谷峰。", layer + ".searchCny", "float"),
            col("searchUnknownHeldCny", "搜索未知预留（元）", "", "搜索未结或保留的预留金额。测得为零时填 0，缺测留空。", layer + ".searchUnknownHeldCny", "float")]


def search_values(rows):
    return {key: total(row.get(key) for row in rows) for key in ("searchAttempts", "searchCny", "searchUnknownHeldCny")}


def spec_main():
    return ID_COLS + [
        col("comparison", "比较类别", "", "这一配置参加的比较：Direct 对照、比法一（同份数不同分法）、比法二（同速度看资源）。", "plan.json stage.configs[].comparison", "text"),
        CAT_COL,
        col("rounds", "轮数", "轮", "合并进本行的轮数。", "summary.round", "int"),
        col("tasks", "任务数", "题", "本行计划的题目执行次数。", "tasks.json 行数", "int"),
        col("completed", "完成数", "题", "留下最终单题记录的题数，含正常完成和单题受限终止（见“单题受限”）。", "summary.completed", "int"),
        col("valid", "有效样本", "题", "已拿到官方评分的完成题数。", "summary.effectiveSampleSize", "int"),
        col("correct", "通过数", "题", "官方评分通过的题数。", "summary.correct", "int"),
        col("successRate", "成功率", "比例", "通过数 ÷ 任务数。", "summary.correct / tasks", "pct"),
        col("goodputPerMin", "goodput", "通过题/分钟", "通过数 ÷ 活动时间 × 60。", "summary.correct, summary.activeSeconds", "float"),
        col("completionPerSec", "每秒完成题数", "题/秒", "完成数 ÷ 活动时间。", "summary.completed, summary.activeSeconds", "float"),
        col("execP50", "执行耗时 p50", "秒", "单题从被接纳到释放 Worker 的耗时的中位数。", "tasks.elapsedSeconds", "float"),
        col("execP95", "执行耗时 p95", "秒", "同上，p95（线性插值分位数）。", "tasks.elapsedSeconds", "float"),
        col("execP99", "执行耗时 p99", "秒", "同上，p99。", "tasks.elapsedSeconds", "float"),
        col("sojournP95", "含排队耗时 p95", "秒", "从到达到结束（含等待被接纳）的耗时 p95。", "tasks.sojournSeconds", "float"),
        col("sojournP99", "含排队耗时 p99", "秒", "同上，p99。", "tasks.sojournSeconds", "float"),
        col("apiP50", "模型 API p50", "毫秒", "成功请求的模型 API 耗时中位数（出口记录，不含限速等待）。", "modelRequests.apiMs（status=completed）", "float"),
        col("apiP95", "模型 API p95", "毫秒", "同上，p95。", "modelRequests.apiMs（status=completed）", "float"),
        col("activeSeconds", "活动时间", "秒", "各块从第一题开始到最后一题结束的时间之和。", "summary.activeSeconds", "float"),
        col("cpuSeconds", "CPU 合计", "核·秒", "容器 cgroup CPU 计数在活动时间内的增量之和。", "summary.cpuSeconds", "float"),
        col("cpuPerComplete", "每完成 CPU", "核·秒/题", "CPU 合计 ÷ 完成数。", "summary.cpuPerComplete", "float"),
        col("cpuPerCorrect", "每答对 CPU", "核·秒/题", "CPU 合计 ÷ 通过数；通过数为 0 时留空。", "summary.cpuPerCorrect", "float"),
        col("gibSeconds", "内存积分合计", "GiB·秒", "容器 cgroup 内存在活动时间内对时间的积分（1 GiB = 1024³ 字节）。", "summary.gibSeconds", "float"),
        col("gibPerComplete", "每完成内存积分", "GiB·秒/题", "内存积分 ÷ 完成数。", "summary.gibPerComplete", "float"),
        col("gibPerCorrect", "每答对内存积分", "GiB·秒/题", "内存积分 ÷ 通过数；通过数为 0 时留空。", "summary.gibPerCorrect", "float"),
        col("meanCpuCores", "平均 CPU 占用", "核", "CPU 合计 ÷ 活动时间。", "summary.meanCpuCores", "float"),
        col("meanMemoryMiB", "活动期平均内存", "MiB", "内存积分 × 1024 ÷ 活动时间。", "summary.meanActiveMemoryMiB", "float"),
        col("peakMemoryMiB", "采样内存峰值", "MiB", "活动时间内 cgroup 内存采样的最大值。", "summary.peakRssBytes", "float"),
        col("processCountMean", "每题进程数", "个", "每道题经过的 Node 进程与 Python 进程数的平均值。", "tasks.processCount", "float"),
        col("requests", "模型请求", "次", "账本预留次数（含失败重试的那一次）。", "summary.requests", "int"),
        col("settledRequests", "已结算请求", "次", "账本已结算次数。", "summary.settledRequests", "int"),
        col("unknownRequests", "未知请求", "次", "可能已扣费、未结算也未经用户确认的请求数。", "summary.unknownRequests", "int"),
        col("confirmedFreeRequests", "确认免单请求", "次", "用户确认未扣费、记 0 元的请求数。", "summary.confirmedFreeRequests", "int"),
        col("toolCalls", "工具调用", "次", "Python 工具调用次数（不含初始化、快照、释放）。", "summary.toolCalls", "int"),
        col("inputTokens", "输入 token", "token", "已结算请求的输入 token 合计。", "summary.recordedInputTokens", "int"),
        col("cachedTokens", "缓存命中 token", "token", "输入中命中缓存的部分。", "summary.recordedCachedTokens", "int"),
        col("uncachedTokens", "未命中 token", "token", "输入 − 缓存命中。", "summary.recordedInputTokens − recordedCachedTokens", "int"),
        col("outputTokens", "输出 token", "token", "已结算请求的输出 token（含推理）。", "summary.recordedOutputTokens", "int"),
        col("reasoningTokens", "推理 token", "token", "输出中属于推理的部分。", "summary.recordedReasoningTokens", "int"),
        col("valleyCny", "谷价已知费用", "元", "已结算用量 × 冻结价表谷价；为主口径。", "summary.knownValleyCny", "float"),
        col("peakCny", "峰价已知费用", "元", "已结算用量 × 冻结价表峰价。", "summary.knownPeakCny", "float"),
        col("referenceUsd", "参考美元", "美元", "账本结算时按参考单价记的美元，供和旧实验对照。", "summary.knownReferenceUsd", "float"),
        col("heldPeakCny", "未知预留", "元（峰价）", "未知请求在账本里保留的预留额，按峰价，不清零。", "summary.unknownHeldPeakCny", "float"),
        col("confirmedChargedCny", "已确认实付", "元", CHARGED_DEFINITION, "summary.confirmedChargedCny", "float"),
        col("skipped", "跳过", "题", "运行失败而跳过的题数。", "summary.skipped", "int"),
        col("interrupted", "中断", "题", "被中断、没有最终结果的题数。", "summary.interrupted", "int"),
        col("terminated", "单题受限", "题", "单题以请求超限、输入超限、输出超限或模型输出出错终止的题数。", "summary.terminated", "int"),
        col("http429", "HTTP 429", "次", "出口收到 429 的请求次数。", "summary.http429", "int"),
        col("timeouts", "超时", "次", "出口请求超时次数。", "summary.timeouts", "int"),
        col("retries", "重试", "次", "出口重试发出的请求次数（retryAttempt > 0）。", "summary.retries", "int"),
        col("egressPeakInFlight", "出口在途峰值", "个", "同一块内这一配置同时在出口上的请求数最大值（由请求起止时间重建）。", "blocks.egressPeakInFlight", "int"),
        col("nonConcurrent", "补跑标记", "是/否", "“是”表示有续跑、多次尝试或未按原计划并发执行。", "summary.nonConcurrent", "bool"),
        col("resourceSamplingOk", "采样达标", "是/否", "资源采样是否满足原规则（窗口开头有样本、尾部缺口不超过一个采样间隔、没有不可用样本）；不达标时数值照常给出。", "summary.resourceSamplingOk", "bool"),
    ] + search_columns("summary")


def merge_rows(stage, summaries, tasks, requests):
    """One row for a set of summary rows (several rounds and/or categories)."""
    f = summaries[0]
    seconds = total(r["activeSeconds"] for r in summaries)
    completed = sum(r["completed"] for r in summaries)
    correct = sum(r["correct"] for r in summaries)
    valid = sum(r["effectiveSampleSize"] for r in summaries)
    cpu = total(r["cpuSeconds"] for r in summaries)
    gibs = total(r["gibSeconds"] for r in summaries)
    done = [t for t in tasks if t["state"] == "completed"]
    api = [q["apiMs"] for q in requests if q["status"] == "completed"]
    inp, cac = total(r["recordedInputTokens"] for r in summaries), total(r["recordedCachedTokens"] for r in summaries)
    peak = vmax(r["peakRssBytes"] for r in summaries)
    allvalid = valid == completed
    cid = f["configId"]
    return {
        **search_values(summaries),
        "stage": stage.label, "configId": cid, "group": f["group"], "copies": copies_text(copies_of(stage, cid), f["group"]), "copyCount": f["copyCount"], "c": f["c"],
        "comparison": "、".join(COMPARISON_CN.get(x, x) for x in f["comparison"]),
        "rounds": len({r["round"] for r in summaries}), "tasks": len(tasks), "completed": completed, "valid": valid, "correct": correct,
        "successRate": ratio(correct, len(tasks)), "goodputPerMin": ratio(correct * 60, seconds) if allvalid else None, "completionPerSec": ratio(completed, seconds),
        "execP50": quantile([t["elapsedSeconds"] for t in done], .5), "execP95": quantile([t["elapsedSeconds"] for t in done], .95), "execP99": quantile([t["elapsedSeconds"] for t in done], .99),
        "execMean": mean(t["elapsedSeconds"] for t in done), "execP90": quantile([t["elapsedSeconds"] for t in done], .9), "execMax": vmax(t["elapsedSeconds"] for t in done),
        "sojournP95": quantile([t["sojournSeconds"] for t in done], .95), "sojournP99": quantile([t["sojournSeconds"] for t in done], .99),
        "apiP50": quantile(api, .5), "apiP95": quantile(api, .95),
        "activeSeconds": seconds, "cpuSeconds": cpu, "cpuPerComplete": ratio(cpu, completed), "cpuPerCorrect": ratio(cpu, correct) if allvalid else None,
        "gibSeconds": gibs, "gibPerComplete": ratio(gibs, completed), "gibPerCorrect": ratio(gibs, correct) if allvalid else None,
        "meanCpuCores": ratio(cpu, seconds), "meanMemoryMiB": ratio(gibs * 1024, seconds) if num(gibs) else None, "peakMemoryMiB": peak / 1024 ** 2 if num(peak) else None,
        "processCountMean": mean(t["processCount"] for t in done),
        "requests": total(r["requests"] for r in summaries), "settledRequests": total(r["settledRequests"] for r in summaries), "unknownRequests": total(r["unknownRequests"] for r in summaries),
        "confirmedFreeRequests": total(r["confirmedFreeRequests"] for r in summaries), "toolCalls": total(r["toolCalls"] for r in summaries),
        "inputTokens": inp, "cachedTokens": cac, "uncachedTokens": inp - cac if num(inp) and num(cac) else None, "outputTokens": total(r["recordedOutputTokens"] for r in summaries),
        "reasoningTokens": total(r["recordedReasoningTokens"] for r in summaries),
        "valleyCny": total(r["knownValleyCny"] for r in summaries), "peakCny": total(r["knownPeakCny"] for r in summaries), "referenceUsd": total(r["knownReferenceUsd"] for r in summaries),
        "heldPeakCny": total(r["unknownHeldPeakCny"] for r in summaries), "confirmedChargedCny": charged_cny(summaries),
        "skipped": sum(r["skipped"] for r in summaries), "interrupted": sum(r["interrupted"] for r in summaries), "terminated": sum(r["terminated"] for r in summaries),
        "http429": sum(r["http429"] for r in summaries), "timeouts": sum(r["timeouts"] for r in summaries), "retries": sum(r["retries"] for r in summaries),
        "egressPeakInFlight": vmax(r["egressPeakInFlight"] for r in summaries),
        "nonConcurrent": any(r["nonConcurrent"] for r in summaries), "resourceSamplingOk": all(r["resourceSamplingOk"] for r in summaries),
    }


def scope(stage, cid=None, category=None, rnd=None):
    s = [r for r in stage.summary if (cid is None or r["configId"] == cid) and (category is None or r["category"] == category) and (rnd is None or r["round"] == rnd)]
    t = [r for r in stage.tasks if (cid is None or r["configId"] == cid) and (category is None or r["category"] == category) and (rnd is None or r["round"] == rnd)]
    q = [r for r in stage.requests if (cid is None or r["configId"] == cid) and (category is None or r["category"] == category) and (rnd is None or r["round"] == rnd)]
    return s, t, q


def stage_configs(stage):
    return sorted({r["configId"] for r in stage.summary}, key=lambda c: config_sort(stage, c))


def stage_categories(stage):
    return sorted({r["category"] for r in stage.summary}, key=cat_sort)


def rows_main(stages):
    out = []
    for st in stages:
        for cid in stage_configs(st):
            for cat in stage_categories(st):
                s, t, q = scope(st, cid, cat)
                if s:
                    row = merge_rows(st, s, t, q)
                    row["category"] = CATEGORY.get(cat, cat)
                    out.append(row)
    return out


def phase_means(stage, cid, category=None):
    rows = [p for p in stage.phases if p["configId"] == cid and (category is None or p["category"] == category)]
    res = {}
    for name in ["graphSchedule", "ipc", "queue"]:
        n = sum(p[name + "Samples"] for p in rows)
        s = sum(p[name + "SumMs"] for p in rows if num(p[name + "SumMs"]))
        res[name] = s / n if n else None
    return res


def spec_direct():
    side = lambda p, who: [
        col(p + "Correct", who + "通过数", "题", who + "的官方通过题数。", "summary.correct", "int"),
        col(p + "SuccessRate", who + "成功率", "比例", "通过数 ÷ 任务数。", "summary", "pct"),
        col(p + "Goodput", who + " goodput", "通过题/分钟", "通过数 ÷ 活动时间 × 60。", "summary", "float"),
        col(p + "Completion", who + "每秒完成", "题/秒", "完成数 ÷ 活动时间。", "summary", "float"),
        col(p + "P50", who + "执行 p50", "秒", "单题执行耗时中位数。", "tasks.elapsedSeconds", "float"),
        col(p + "P95", who + "执行 p95", "秒", "单题执行耗时 p95。", "tasks.elapsedSeconds", "float"),
        col(p + "P99", who + "执行 p99", "秒", "单题执行耗时 p99。", "tasks.elapsedSeconds", "float"),
        col(p + "Cpu", who + "每完成 CPU", "核·秒/题", "CPU 合计 ÷ 完成数。", "summary.cpuSeconds", "float"),
        col(p + "Gib", who + "每完成内存积分", "GiB·秒/题", "内存积分 ÷ 完成数。", "summary.gibSeconds", "float"),
        col(p + "Mem", who + "活动期平均内存", "MiB", "内存积分 × 1024 ÷ 活动时间。", "summary", "float"),
        col(p + "Proc", who + "每题进程数", "个", "每道题经过的进程数平均。", "tasks.processCount", "float"),
        col(p + "CompMin", who + "每秒完成（各轮最小）", "题/秒", "各轮每秒完成题数的最小值；只有一轮时等于该轮。", "summary.completionRate", "float"),
        col(p + "CompMax", who + "每秒完成（各轮最大）", "题/秒", "各轮每秒完成题数的最大值。", "summary.completionRate", "float"),
    ]
    diffs = []
    for key, name, unit in [("SuccessRate", "成功率", "比例"), ("Goodput", "goodput", "通过题/分钟"), ("Completion", "每秒完成", "题/秒"), ("P50", "执行 p50", "秒"), ("P95", "执行 p95", "秒"), ("Cpu", "每完成 CPU", "核·秒/题"), ("Gib", "每完成内存积分", "GiB·秒/题"), ("Mem", "活动期平均内存", "MiB")]:
        diffs.append(col("diff" + key, name + "差", unit, "Monolithic − Direct。", "由左侧两列相减", "float"))
        diffs.append(col("pct" + key, name + "差占比", "比例", "（Monolithic − Direct）÷ Direct。", "由左侧两列计算", "pct"))
    return [ID_COLS[0], col("c", "并发", "题", "两边配置的并发。", "plan.json", "int"), CAT_COL,
            col("direct", "Direct 配置", "", "Direct 一侧的配置编号。", "plan.json", "text"), col("mono", "Monolithic 配置", "", "Monolithic 一侧（份数等于并发）。", "plan.json", "text"),
            col("tasksPerSide", "每边题数", "题", "每一侧本行的题目执行次数。", "tasks.json", "int")] + side("d", "Direct ") + side("m", "Monolithic ") + diffs + [
            col("monoSchedMs", "Monolithic 每步图调度", "毫秒", "Monolithic 每步平均的图调度时间（上一节点返回到本节点发出）。", "stepPhases.graphScheduleSumMs ÷ graphScheduleSamples", "float"),
            col("monoIpcMs", "Monolithic 每步进程间传消息", "毫秒", "每步平均的进程间传消息时间。", "stepPhases.ipcSumMs ÷ ipcSamples", "float"),
            col("monoQueueMs", "Monolithic 每步排队", "毫秒", "每步平均在 Worker 里排队的时间。", "stepPhases.queueSumMs ÷ queueSamples", "float")]


def rows_direct(stages):
    out = []
    for st in [s for s in stages if not s.profiling]:
        for c in [1, 4, 8]:
            d, m = "direct-c%d" % c, "mono-%d-c%d" % (c, c)
            if not any(r["configId"] == d for r in st.summary) or not any(r["configId"] == m for r in st.summary):
                continue
            for cat in stage_categories(st) + [None]:
                row = {"stage": st.label, "c": c, "category": CATEGORY.get(cat, cat) if cat else "合计", "direct": d, "mono": m}
                for p, cid in [("d", d), ("m", m)]:
                    s, t, q = scope(st, cid, cat)
                    r = merge_rows(st, s, t, q)
                    row["tasksPerSide"] = r["tasks"]
                    comp = [ratio(sum(y["completed"] for y in scope(st, cid, cat, rnd)[0]), total(y["activeSeconds"] for y in scope(st, cid, cat, rnd)[0])) for rnd in st.rounds]
                    row.update({p + "Correct": r["correct"], p + "SuccessRate": r["successRate"], p + "Goodput": r["goodputPerMin"], p + "Completion": r["completionPerSec"], p + "P50": r["execP50"], p + "P95": r["execP95"], p + "P99": r["execP99"],
                                p + "Cpu": r["cpuPerComplete"], p + "Gib": r["gibPerComplete"], p + "Mem": r["meanMemoryMiB"], p + "Proc": r["processCountMean"], p + "CompMin": vmin(comp), p + "CompMax": vmax(comp)})
                for key in ["SuccessRate", "Goodput", "Completion", "P50", "P95", "Cpu", "Gib", "Mem"]:
                    a, b = row["d" + key], row["m" + key]
                    row["diff" + key] = b - a if num(a) and num(b) else None
                    row["pct" + key] = (b - a) / a if num(a) and num(b) and a != 0 else None
                pm = phase_means(st, m, cat)
                row.update({"monoSchedMs": pm["graphSchedule"], "monoIpcMs": pm["ipc"], "monoQueueMs": pm["queue"]})
                out.append(row)
    return out


def worker_busy(stage, cid, cat, infer):
    rows = [w for w in stage.workers if w["configId"] == cid and w["category"] == cat and (w.get("capability") in ("Infer", "All")) == infer]
    return mean(w["busyFraction"] for w in rows)


def queue_stats(stage, cid, cat, capability=None, exclude=None):
    rows = [p for p in stage.phases if p["configId"] == cid and p["category"] == cat and (capability is None or p["capability"] == capability) and (exclude is None or p["capability"] != exclude)]
    n = sum(p["queueSamples"] for p in rows)
    s = sum(p["queueSumMs"] for p in rows if num(p["queueSumMs"]))
    return (s if n else None), (s / n if n else None)


def round_values(stage, cid, cat, key):
    out = []
    for rnd in [1, 2, 3]:
        s = scope(stage, cid, cat, rnd)[0]
        if not s:
            out.append(None)
            continue
        seconds = total(x["activeSeconds"] for x in s)
        if key == "completion":
            out.append(ratio(sum(x["completed"] for x in s), seconds))
        else:
            out.append(ratio(sum(x["correct"] for x in s) * 60, seconds))
    return out


def spec_equal():
    return [ID_COLS[0], CAT_COL, ID_COLS[5], ID_COLS[1], ID_COLS[2], ID_COLS[3],
            col("mainMetric", "主看指标", "", "miss_func、miss_param 两类以每秒完成题数为主，其余看 goodput。", "设计 5.8", "text"),
            col("goodput", "goodput（合并）", "通过题/分钟", "各轮合并：通过数 ÷ 活动时间 × 60。", "summary", "float"),
            col("goodputR1", "goodput 第 1 轮", "通过题/分钟", "第 1 轮的 goodput。", "summary", "float"), col("goodputR2", "goodput 第 2 轮", "通过题/分钟", "第 2 轮；没跑时留空。", "summary", "float"), col("goodputR3", "goodput 第 3 轮", "通过题/分钟", "第 3 轮；没跑时留空。", "summary", "float"),
            col("completion", "每秒完成（合并）", "题/秒", "各轮合并：完成数 ÷ 活动时间。", "summary", "float"),
            col("completionR1", "每秒完成第 1 轮", "题/秒", "第 1 轮。", "summary", "float"), col("completionR2", "每秒完成第 2 轮", "题/秒", "第 2 轮。", "summary", "float"), col("completionR3", "每秒完成第 3 轮", "题/秒", "第 3 轮。", "summary", "float"),
            col("successRate", "成功率", "比例", "通过数 ÷ 任务数。", "summary", "pct"),
            col("execP50", "执行 p50", "秒", "单题执行耗时中位数。", "tasks.elapsedSeconds", "float"), col("execP95", "执行 p95", "秒", "p95。", "tasks.elapsedSeconds", "float"), col("execP99", "执行 p99", "秒", "p99。", "tasks.elapsedSeconds", "float"),
            col("inferQueueSum", "问模型排队合计", "毫秒", "问模型（Monolithic 为全部）步骤在 Worker 里排队的时间之和。", "stepPhases.queueSumMs", "float"),
            col("inferQueueMean", "问模型排队均值", "毫秒/步", "同上，每步平均。", "stepPhases", "float"),
            col("otherQueueMean", "其余三类排队均值", "毫秒/步", "挑选上下文、工具、记忆三类每步平均排队；Monolithic 不分能力，留空。", "stepPhases", "float"),
            col("inferBusy", "问模型份平均忙碌比例", "比例", "问模型那几份 Worker 的忙碌时间 ÷ 观测窗口的平均（Monolithic 为全部份）。", "workers.busyFraction", "pct"),
            col("otherBusy", "其余份平均忙碌比例", "比例", "其余 Worker 的平均忙碌比例。", "workers.busyFraction", "pct"),
            col("targetedOverUniform", "Targeted ÷ Uniform goodput", "倍", "同题型、同并发下 Targeted 与 Uniform 的 goodput 之比；只在 Targeted 行给出。", "summary", "float"),
            col("cpuPerCorrect", "每答对 CPU", "核·秒/题", "CPU 合计 ÷ 通过数。", "summary", "float"),
            col("gibPerCorrect", "每答对内存积分", "GiB·秒/题", "内存积分 ÷ 通过数。", "summary", "float")]


def rows_equal(stages):
    out = []
    for st in [s for s in stages if not s.profiling]:
        cids = [c for c in stage_configs(st) if "equal" in st.configs[c]["comparison"]]
        for cat in stage_categories(st):
            for cid in cids:
                s, t, q = scope(st, cid, cat)
                if not s:
                    continue
                r = merge_rows(st, s, t, q)
                g = st.configs[cid]["group"]
                qs, qm = queue_stats(st, cid, cat, None if g == "Monolithic" else "Infer")
                _, om = (None, None) if g == "Monolithic" else queue_stats(st, cid, cat, exclude="Infer")
                gp, cp = round_values(st, cid, cat, "goodput"), round_values(st, cid, cat, "completion")
                row = {"stage": st.label, "category": CATEGORY.get(cat, cat), "c": st.configs[cid]["c"], "configId": cid, "group": g, "copies": r["copies"],
                       "mainMetric": "每秒完成题数" if cat in ("multi_turn_miss_func", "multi_turn_miss_param") else "goodput",
                       "goodput": r["goodputPerMin"], "goodputR1": gp[0], "goodputR2": gp[1], "goodputR3": gp[2], "completion": r["completionPerSec"], "completionR1": cp[0], "completionR2": cp[1], "completionR3": cp[2],
                       "successRate": r["successRate"], "execP50": r["execP50"], "execP95": r["execP95"], "execP99": r["execP99"],
                       "inferQueueSum": qs, "inferQueueMean": qm, "otherQueueMean": om,
                       "inferBusy": worker_busy(st, cid, cat, True), "otherBusy": None if g == "Monolithic" else worker_busy(st, cid, cat, False),
                       "targetedOverUniform": None, "cpuPerCorrect": r["cpuPerCorrect"], "gibPerCorrect": r["gibPerCorrect"]}
                out.append(row)
    for row in out:
        if row["group"] == "Targeted":
            u = [x for x in out if x["stage"] == row["stage"] and x["category"] == row["category"] and x["c"] == row["c"] and x["group"] == "Uniform"]
            if u:
                row["targetedOverUniform"] = ratio(row["goodput"], u[0]["goodput"])
    return out


def mean_rss(stage, cid, cat, roles):
    rows = [p for p in stage.processes if p["configId"] == cid and p["category"] == cat and p["role"] in roles]
    n = sum(p["samples"] for p in rows)
    s = sum(p["meanRssBytes"] * p["samples"] for p in rows if num(p["meanRssBytes"]))
    return s / n / 1024 ** 2 if n else None


def spec_cost():
    return [ID_COLS[0], CAT_COL, ID_COLS[5], ID_COLS[1], ID_COLS[2], ID_COLS[3], ID_COLS[4],
            col("processCountMean", "每题进程数", "个", "每道题经过的进程数平均。", "tasks.processCount", "float"),
            col("completionR1", "每秒完成第 1 轮", "题/秒", "第 1 轮完成数 ÷ 活动时间。", "summary", "float"), col("completionR2", "每秒完成第 2 轮", "题/秒", "第 2 轮。", "summary", "float"), col("completionR3", "每秒完成第 3 轮", "题/秒", "第 3 轮。", "summary", "float"),
            col("completion", "每秒完成（合并）", "题/秒", "各轮合并。", "summary", "float"),
            col("speedRatio", "相对 Monolithic", "倍", "三轮每秒完成题数之和 ÷ 同并发 Monolithic 的三轮之和；要三轮都完整才给出。", "summary.speedRatio", "float"),
            col("speedComparable", "速度相当", "是/否", "相对 Monolithic 在 ±10% 以内。", "summary.speedComparable", "bool"),
            col("goodputR1", "goodput 第 1 轮", "通过题/分钟", "第 1 轮。", "summary", "float"), col("goodputR2", "goodput 第 2 轮", "通过题/分钟", "第 2 轮。", "summary", "float"), col("goodputR3", "goodput 第 3 轮", "通过题/分钟", "第 3 轮。", "summary", "float"),
            col("cpuPerComplete", "每完成 CPU", "核·秒/题", "CPU 合计 ÷ 完成数。", "summary", "float"), col("cpuPerCorrect", "每答对 CPU", "核·秒/题", "CPU 合计 ÷ 通过数。", "summary", "float"),
            col("gibPerComplete", "每完成内存积分", "GiB·秒/题", "内存积分 ÷ 完成数。", "summary", "float"), col("gibPerCorrect", "每答对内存积分", "GiB·秒/题", "内存积分 ÷ 通过数。", "summary", "float"),
            col("meanMemoryMiB", "活动期平均内存", "MiB", "内存积分 × 1024 ÷ 活动时间。", "summary", "float"),
            col("workerRssMiB", "每份 Worker 平均常驻内存", "MiB", "Worker 进程常驻内存采样（1 秒一次）的平均。", "processResources.meanRssBytes", "float"),
            col("pythonRssMiB", "每个 Python 平均常驻内存", "MiB", "工具 Python 进程常驻内存采样的平均。", "processResources.meanRssBytes（role=python）", "float")]


def rows_cost(stages):
    out = []
    for st in [s for s in stages if not s.profiling]:
        cids = [c for c in stage_configs(st) if "cost" in st.configs[c]["comparison"]]
        for cat in stage_categories(st):
            for cid in cids:
                s, t, q = scope(st, cid, cat)
                if not s:
                    continue
                r = merge_rows(st, s, t, q)
                cp, gp = round_values(st, cid, cat, "completion"), round_values(st, cid, cat, "goodput")
                out.append({"stage": st.label, "category": CATEGORY.get(cat, cat), "c": st.configs[cid]["c"], "configId": cid, "group": st.configs[cid]["group"], "copies": r["copies"], "copyCount": r["copyCount"],
                            "processCountMean": r["processCountMean"], "completionR1": cp[0], "completionR2": cp[1], "completionR3": cp[2], "completion": r["completionPerSec"],
                            "speedRatio": s[0].get("speedRatio"), "speedComparable": s[0].get("speedComparable"), "goodputR1": gp[0], "goodputR2": gp[1], "goodputR3": gp[2],
                            "cpuPerComplete": r["cpuPerComplete"], "cpuPerCorrect": r["cpuPerCorrect"], "gibPerComplete": r["gibPerComplete"], "gibPerCorrect": r["gibPerCorrect"], "meanMemoryMiB": r["meanMemoryMiB"],
                            "workerRssMiB": mean_rss(st, cid, cat, CAPS + ["All"]), "pythonRssMiB": mean_rss(st, cid, cat, ["python"])})
    return out


def spec_phases():
    cols = [ID_COLS[0], ID_COLS[1], ID_COLS[2], CAT_COL, col("round", "轮次", "轮", "第几轮。", "stepPhases.round", "int"),
            col("capability", "能力", "", "节点所属能力：挑选上下文、问模型、工具、记忆。", "stepPhases.capability", "text"), col("node", "节点", "", "图里的节点名。", "stepPhases.node", "text"),
            col("steps", "步数", "步", "这一节点被调用的次数（不含诊断步骤）。", "stepPhases.steps", "int")]
    for key, name, d in [("graphSchedule", "图调度", "上一节点返回到本节点发出（第一个节点从图开始算；最后一个节点还含图结束的尾段）"), ("ipc", "进程间传消息", "发出到 Worker 收到、Worker 返回到调度端收到的时间"), ("queue", "排队", "Worker 收到到开始干活"), ("work", "干活", "Worker 开始到结束")]:
        cols += [col(key + "SumMs", name + "合计", "毫秒", d + "的合计；Direct 没有图调度、进程间和排队，留空。", "stepPhases." + key + "SumMs", "float"),
                 col(key + "MeanMs", name + "均值", "毫秒/步", "同上，每步平均。", "stepPhases." + key + "MeanMs", "float"),
                 col(key + "P95Ms", name + " p95", "毫秒", "同上，p95。", "stepPhases." + key + "P95Ms", "float")]
    return cols


def rows_phases(stages):
    out = []
    for st in stages:
        for p in sorted(st.phases, key=lambda p: (config_sort(st, p["configId"]), cat_sort(p["category"]), p["round"], CAPS.index(p["capability"]) if p["capability"] in CAPS else 9, str(p["node"]))):
            r = dict(p)
            r.update({"stage": st.label, "group": group_of(p["configId"], st), "category": CATEGORY.get(p["category"], p["category"]), "capability": CAP_CN.get(p["capability"], p["capability"])})
            for key in ["graphSchedule", "ipc", "queue", "work"]:
                if not p[key + "Samples"]:
                    r[key + "SumMs"] = None
            out.append(r)
    return out


LAYER_CN = {"task_execution": "单题执行", "task_sojourn": "单题含排队", "model_api": "模型 API（成功请求）", "model_rate_wait": "限速等待（成功请求）", "model_attempt_api": "模型 API（全部尝试）",
            "model_attempt_rate_wait": "限速等待（全部尝试）", "failed_model_attempt_api": "模型 API（失败尝试）", "failed_model_attempt_rate_wait": "限速等待（失败尝试）", "retry_cooldown": "重试冷却",
            "graph_schedule": "图调度", "ipc": "进程间传消息", "worker_queue": "Worker 排队", "tool_service": "工具服务",
            **{c + "_queue": CAP_CN[c] + "排队" for c in CAPS}, **{c + "_work": CAP_CN[c] + "干活" for c in CAPS}}


def spec_latency():
    return [ID_COLS[0], ID_COLS[1], ID_COLS[2], CAT_COL, col("round", "轮次", "轮", "第几轮。", "latency.round", "int"),
            col("layerName", "延迟层", "", "延迟分层的中文名；代码名见下一列。", "latency.layer", "text"), col("layer", "层代码", "", "导出里的层名。", "latency.layer", "text"),
            col("samples", "有效样本", "个", "有数值的样本数。", "latency.samples", "int"), col("missing", "缺失样本", "个", "应有但没有数值的样本数。", "latency.missing", "int"),
            col("mean", "均值", "毫秒", "算术平均。", "latency.mean", "float"), col("p50", "p50", "毫秒", "中位数（线性插值）。", "latency.p50", "float"), col("p90", "p90", "毫秒", "p90。", "latency.p90", "float"),
            col("p95", "p95", "毫秒", "p95。", "latency.p95", "float"), col("p99", "p99", "毫秒", "p99。", "latency.p99", "float"), col("max", "最大值", "毫秒", "最大值。", "latency.max", "float")]


def rows_latency(stages):
    out = []
    for st in stages:
        order = list(LAYER_CN)
        for r in sorted(st.latency, key=lambda r: (config_sort(st, r["configId"]), cat_sort(r["category"]), r["round"], order.index(r["layer"]) if r["layer"] in order else 99)):
            x = dict(r)
            x.update({"stage": st.label, "group": group_of(r["configId"], st), "category": CATEGORY.get(r["category"], r["category"]), "layerName": LAYER_CN.get(r["layer"], r["layer"])})
            out.append(x)
    return out


def spec_process():
    return [ID_COLS[0], ID_COLS[1], ID_COLS[2], CAT_COL, col("round", "轮次", "轮", "第几轮。", "processResources.round", "int"),
            col("roleName", "角色", "", "主进程、各能力 Worker、全能 Worker（Monolithic）、Python 工具进程，另有容器入口和 init。", "processResources.role", "text"),
            col("processCount", "进程数", "个", "活动时间内出现过的不同进程数。", "processResources.processCount", "int"),
            col("samples", "采样数", "个", "进程×采样时刻的样本数（1 秒一次）。", "processResources.samples", "int"),
            col("meanRssMiB", "平均常驻内存", "MiB", "每个进程每次采样的常驻内存的平均。", "processResources.meanRssBytes", "float"),
            col("peakRssMiB", "峰值常驻内存", "MiB", "单个进程单次采样的最大值。", "processResources.peakRssBytes", "float"),
            col("cpuSeconds", "CPU", "核·秒", "进程累计 CPU 在活动时间内的增量（按 1 秒采样线性截取）。", "processResources.cpuSeconds", "float"),
            col("gibSeconds", "进程内存积分", "GiB·秒", "进程常驻内存对时间的积分，同角色相加。", "processResources.gibSeconds", "float")]


def rows_process(stages):
    out = []
    role_order = ["init", "entry", "main", "All"] + CAPS + ["python"]
    for st in stages:
        for p in sorted(st.processes, key=lambda p: (config_sort(st, p["configId"]), cat_sort(p["category"]), p["round"], role_order.index(p["role"]) if p["role"] in role_order else 99)):
            out.append({"stage": st.label, "configId": p["configId"], "group": group_of(p["configId"], st), "category": CATEGORY.get(p["category"], p["category"]), "round": p["round"],
                        "roleName": CAP_CN.get(p["role"], p["role"]), "processCount": p["processCount"], "samples": p["samples"],
                        "meanRssMiB": p["meanRssBytes"] / 1024 ** 2 if num(p["meanRssBytes"]) else None, "peakRssMiB": p["peakRssBytes"] / 1024 ** 2 if num(p["peakRssBytes"]) else None,
                        "cpuSeconds": p["cpuSeconds"], "gibSeconds": p["gibSeconds"]})
    return out


def spec_workers():
    return [ID_COLS[0], ID_COLS[1], ID_COLS[2], CAT_COL, col("round", "轮次", "轮", "第几轮。", "workers.round", "int"),
            col("workerId", "Worker", "", "Worker 标识，如 Infer-3；Direct 只有一个普通进程，记 direct。", "workers.workerId", "text"),
            col("capabilityName", "能力", "", "Worker 负责的能力。", "workers.capability", "text"),
            col("calls", "调用数", "次", "这份 Worker 处理的步骤数。", "workers.calls", "int"), col("errors", "出错数", "次", "返回失败或状态不是 success 的步骤数。", "workers.errors", "int"),
            col("queueMsTotal", "排队合计", "毫秒", "步骤在这份 Worker 里排队的时间之和。", "workers.queueMsTotal", "float"),
            col("workMsTotal", "干活合计", "毫秒", "步骤干活时间之和。", "workers.workMsTotal", "float"),
            col("ipcMsTotal", "进程间耗时合计", "毫秒", "步骤进程间传消息时间之和。", "workers.ipcMsTotal", "float"),
            col("busyMs", "忙碌时间", "毫秒", "干活区间的并集长度（同一时刻多步只算一次）。", "workers.busyMs", "float"),
            col("windowMs", "观测窗口", "毫秒", "块内第一题开始到最后一题结束。", "workers.observationWindowMs", "float"),
            col("busyFraction", "忙碌比例", "比例", "忙碌时间 ÷ 观测窗口。", "workers.busyFraction", "pct")]


def rows_workers(stages):
    out = []
    for st in stages:
        agg = OrderedDict()
        for w in st.workers:
            k = (w["configId"], w["category"], w["round"], w["workerId"])
            agg.setdefault(k, []).append(w)
        for k in sorted(agg, key=lambda k: (config_sort(st, k[0]), cat_sort(k[1]), k[2], k[3])):
            ws = agg[k]
            busy, window = total(w["busyMs"] for w in ws), total(w["observationWindowMs"] for w in ws)
            cap = ws[0].get("capability")
            out.append({"stage": st.label, "configId": k[0], "group": group_of(k[0], st), "category": CATEGORY.get(k[1], k[1]), "round": k[2], "workerId": k[3], "capabilityName": CAP_CN.get(cap, cap) if cap else "（Direct 普通进程）",
                        "calls": total(w["calls"] for w in ws), "errors": total(w["errors"] for w in ws), "queueMsTotal": total(w["queueMsTotal"] for w in ws), "workMsTotal": total(w["workMsTotal"] for w in ws),
                        "ipcMsTotal": total(w["ipcMsTotal"] for w in ws), "busyMs": busy, "windowMs": window, "busyFraction": ratio(busy, window)})
    return out


def spec_tasks():
    return [ID_COLS[0], ID_COLS[1], ID_COLS[2], ID_COLS[3], ID_COLS[5], CAT_COL,
            col("round", "轮次", "轮", "第几轮。", "tasks.round", "int"), col("blockId", "块", "", "所在的块。", "tasks.blockId", "text"), col("caseId", "题号", "", "BFCL 原题编号。", "tasks.caseId", "text"),
            col("correct", "最终通过", "是/否", "官方评分是否通过。", "tasks.correct", "bool"), col("scored", "官方已评分", "是/否", "是否拿到官方评分。", "tasks.scoreStatus", "bool"),
            col("outcome", "执行终态", "", "单题记录自身的终态：正常完成、单题请求超限、输入超限、输出超限、模型输出出错。", "tasks.executionOutcome", "text"),
            col("runFailure", "运行失败类型", "", "没有最终单题记录时的失败类型（跳过、中断）。", "tasks.failureType / state", "text"),
            col("officialFailureType", "官方失败类型", "", "官方评分未通过时给出的错误类型。", "official.json official_result / irrelevance_result .error_type", "text"),
            col("completedTurns", "完成轮次", "轮", "这道题完成的对话轮数。", "tasks.completedTurns", "int"),
            col("toolCalls", "工具调用", "次", "Python 工具调用次数。", "tasks.toolCalls", "int"),
            col("modelRequests", "本次请求", "次", "这道题在账本里的预留次数（含重试）。本次请求 = 已结算 + 确认免单 + 未知 + 确认已扣费（右边四列）。", "tasks.modelRequests", "int"),
            col("settledRequests", "已结算请求", "次", "已结算次数。", "tasks.settledRequests", "int"),
            col("confirmedFreeRequests", "确认免单请求", "次", "用户确认未扣费的次数。", "tasks.confirmedFreeRequests", "int"),
            col("unknownRequests", "未知请求", "次", "未结算也未确认的次数。", "tasks.unknownRequests", "int"),
            col("confirmedChargedRequests", "确认已扣费请求", "次", "用户确认已扣费的次数；这些请求账本里没有用量，不算在 token 和谷价、峰价里，金额见“费用待确认”的“确认实际收费”。", "tasks.confirmedChargedRequests", "int"),
            col("inputTokens", "输入 token", "token", "已结算请求的输入 token。", "tasks.inputTokens", "int"), col("cachedInputTokens", "缓存命中 token", "token", "其中命中缓存。", "tasks.cachedInputTokens", "int"),
            col("uncachedInputTokens", "未命中 token", "token", "输入 − 命中。", "tasks.uncachedInputTokens", "int"), col("outputTokens", "输出 token", "token", "输出（含推理）。", "tasks.outputTokens", "int"),
            col("reasoningTokens", "推理 token", "token", "输出中的推理部分。", "tasks.reasoningTokens", "int"),
            col("knownValleyCny", "谷价", "元", "已结算用量按谷价。", "tasks.knownValleyCny", "float"), col("knownPeakCny", "峰价", "元", "已结算用量按峰价。", "tasks.knownPeakCny", "float"),
            col("knownReferenceUsd", "参考美元", "美元", "账本参考美元。", "tasks.knownReferenceUsd", "float"), col("unknownHeldPeakCny", "未知预留", "元（峰价）", "未知请求的预留。", "tasks.unknownHeldPeakCny", "float"),
            col("elapsedSeconds", "单题执行耗时", "秒", "从被接纳到释放 Worker。", "tasks.elapsedSeconds", "float"), col("sojournSeconds", "含排队总耗时", "秒", "从到达到结束。", "tasks.sojournSeconds", "float"),
            col("copyCount", "总份数", "份", "这一配置的 Worker 总份数。", "tasks.copyCount", "int"),
            col("fixedAssignment", "固定分配", "", "题目被接纳时固定分到的上下文/工具/记忆 Worker；问模型按空闲动态选，不固定。", "tasks.fixedAssignment", "text"),
            col("processCount", "进程数", "个", "这道题经过的 Node 与 Python 进程数。", "tasks.processCount", "int"),
            col("maxSelectedItemCount", "记录本最大条目数", "条", "挑选上下文一步选出的条目数的最大值。", "tasks.selectedItemCounts", "int"),
            col("maxRequestBodyBytes", "最大请求体", "字节", "这道题发给模型的单个请求体（JSON）的最大字节数。", "tasks.maxRequestBodyBytes", "int"),
            col("nonConcurrent", "补跑标记", "是/否", "结果来自第 2 次及以后的尝试。", "tasks.nonConcurrent", "bool"),
            col("attempt", "尝试", "次", "最终结果来自第几次尝试。", "tasks.attempt", "int"),
            col("firstRequestAt", "本次首个请求（北京）", "", "这道题第一个模型请求的发出时间。", "modelRequests.requestStartedAt", "text"),
            col("source", "原始任务文件", "", "单题记录相对运行根的路径。", "tasks.source.path", "text"),
            col("scoreFile", "评分文件", "", "评分结果相对运行根的路径（同目录有 official.json）。", "tasks.scoreFile", "text"),
            col("officialFailureMessage", "官方失败说明", "", "官方评分未通过时的说明原文。", "official.json .error_message", "text")] + search_columns("tasks")


def assignment_text(a):
    if not isinstance(a, dict):
        return None
    return "；".join("%s=%s" % (k, a[k]) for k in sorted(a))


def rows_tasks(stages):
    out = []
    for st in stages:
        for t in sorted(st.tasks, key=lambda t: (config_sort(st, t["configId"]), cat_sort(t["category"]), t["round"], t["caseId"])):
            out.append({"stage": st.label, "configId": t["configId"], "group": t["group"], "copies": copies_text(copies_of(st, t["configId"]), t["group"]), "c": t["c"], "category": CATEGORY.get(t["category"], t["category"]),
                        "round": t["round"], "blockId": t["blockId"], "caseId": t["caseId"], "correct": t["correct"], "scored": t["scoreStatus"] == "scored",
                        "outcome": OUTCOME_CN.get(t.get("executionOutcome"), t.get("executionOutcome")), "runFailure": None if t["state"] == "completed" else "%s %s" % (t["state"], t.get("failureType") or ""),
                        "officialFailureType": t.get("officialFailureType"), "completedTurns": t.get("completedTurns"), "toolCalls": t.get("toolCalls"),
                        **{k: t.get(k) for k in ["searchAttempts", "searchCny", "searchUnknownHeldCny", "modelRequests", "settledRequests", "confirmedFreeRequests", "unknownRequests", "confirmedChargedRequests", "inputTokens", "cachedInputTokens", "uncachedInputTokens", "outputTokens", "reasoningTokens",
                                                 "knownValleyCny", "knownPeakCny", "knownReferenceUsd", "unknownHeldPeakCny", "elapsedSeconds", "sojournSeconds", "copyCount", "processCount", "maxSelectedItemCount", "maxRequestBodyBytes", "nonConcurrent", "attempt", "scoreFile", "officialFailureMessage"]},
                        "fixedAssignment": assignment_text(t.get("fixedAssignment")), "firstRequestAt": beijing(t.get("firstRequestAt")), "source": (t.get("source") or {}).get("path")})
    return out


def spec_pairs(columns):
    return [ID_COLS[0], CAT_COL, col("caseId", "题号", "", "BFCL 原题编号。", "tasks.caseId", "text"), col("round", "轮次", "轮", "第几轮。", "tasks.round", "int")] + \
        [col("cfg:" + c, c, "通过/未通过", "这一配置下这道题的官方结果；没跑留空。", "tasks.correct", "text") for c in columns] + \
        [col("passCount", "通过配置数", "个", "这道题在几个配置下通过。", "由左侧各列计数", "int"), col("ranCount", "运行配置数", "个", "这道题跑了几个配置。", "tasks.json", "int")]


def rows_pairs(stages):
    columns = []
    for st in stages:
        for c in stage_configs(st):
            if c not in columns:
                columns.append(c)
    out = []
    for st in stages:
        keys = sorted({(t["category"], t["caseId"], t["round"]) for t in st.tasks}, key=lambda k: (cat_sort(k[0]), int(k[1].rsplit("_", 1)[1]) if k[1].rsplit("_", 1)[1].isdigit() else 0, k[2]))
        for cat, case, rnd in keys:
            row = {"stage": st.label, "category": CATEGORY.get(cat, cat), "caseId": case, "round": rnd}
            passed = ran = 0
            for t in st.tasks:
                if (t["category"], t["caseId"], t["round"]) == (cat, case, rnd):
                    ran += 1
                    row["cfg:" + t["configId"]] = "通过" if t["correct"] is True else ("未通过" if t["correct"] is False else None)
                    passed += t["correct"] is True
            row.update({"passCount": passed, "ranCount": ran})
            out.append(row)
    return out, columns


def spec_costs():
    return [ID_COLS[0], col("rowType", "行类型", "", "明细：配置×题型；阶段合计；总计。", "由脚本生成", "text"), ID_COLS[1], ID_COLS[2], ID_COLS[5], CAT_COL,
            col("tasks", "任务数", "题", "题目执行次数。", "tasks.json", "int"), col("requests", "模型请求", "次", "账本预留次数。", "summary.requests", "int"),
            col("settledRequests", "已结算", "次", "账本已结算次数。", "summary.settledRequests", "int"), col("confirmedFreeRequests", "确认免单", "次", "用户确认未扣费、记 0 元。", "summary.confirmedFreeRequests", "int"),
            col("unknownRequests", "未知请求", "次", "未结算也未确认。", "summary.unknownRequests", "int"),
            col("inputTokens", "输入 token", "token", "已结算输入。", "summary.recordedInputTokens", "int"), col("cachedTokens", "缓存命中 token", "token", "其中命中缓存。", "summary.recordedCachedTokens", "int"),
            col("uncachedTokens", "未命中 token", "token", "输入 − 命中。", "计算", "int"), col("outputTokens", "输出 token", "token", "已结算输出（含推理）。", "summary.recordedOutputTokens", "int"),
            col("reasoningTokens", "推理 token", "token", "其中推理。", "summary.recordedReasoningTokens", "int"),
            col("cacheHit", "缓存命中率", "比例", "缓存命中 ÷ 输入。", "计算", "pct"),
            col("valleyCny", "谷价已知费用", "元", "已结算用量 × 谷价（主口径）。", "summary.knownValleyCny", "float"), col("peakCny", "峰价已知费用", "元", "已结算用量 × 峰价。", "summary.knownPeakCny", "float"),
            col("referenceUsd", "参考美元", "美元", "账本参考美元。", "summary.knownReferenceUsd", "float"), col("heldPeakCny", "未知预留", "元（峰价）", "未知请求的账本预留，不清零。", "summary.unknownHeldPeakCny", "float"),
            col("heldUsd", "未知预留（美元）", "美元", "同上，参考美元。", "summary.unknownHeldReferenceUsd", "float"),
            col("confirmedChargedCny", "已确认实付", "元", CHARGED_DEFINITION, "summary.confirmedChargedCny", "float"),
            col("pending", "费用待确认", "是/否", "本行有模型或搜索未知请求。", "summary.unknownRequests / searchUnknownRequests", "bool")] + search_columns("summary")


def cost_row(label, row_type, s, n_tasks, cid=None, group=None, c=None, cat=None):
    inp, cac = total(r["recordedInputTokens"] for r in s), total(r["recordedCachedTokens"] for r in s)
    unk = total(r["unknownRequests"] for r in s)
    search_unknown = total(r.get("searchUnknownRequests") for r in s)
    return {**search_values(s), "stage": label, "rowType": row_type, "configId": cid, "group": group, "c": c, "category": cat, "tasks": n_tasks, "requests": total(r["requests"] for r in s),
            "settledRequests": total(r["settledRequests"] for r in s), "confirmedFreeRequests": total(r["confirmedFreeRequests"] for r in s), "unknownRequests": unk,
            "inputTokens": inp, "cachedTokens": cac, "uncachedTokens": inp - cac if num(inp) and num(cac) else None, "outputTokens": total(r["recordedOutputTokens"] for r in s),
            "reasoningTokens": total(r["recordedReasoningTokens"] for r in s), "cacheHit": ratio(cac, inp),
            "valleyCny": total(r["knownValleyCny"] for r in s), "peakCny": total(r["knownPeakCny"] for r in s), "referenceUsd": total(r["knownReferenceUsd"] for r in s),
            "heldPeakCny": total(r["unknownHeldPeakCny"] for r in s), "heldUsd": total(r["unknownHeldReferenceUsd"] for r in s), "confirmedChargedCny": charged_cny(s),
            "pending": True if (unk or 0) > 0 or (search_unknown or 0) > 0 else False if unk is not None and search_unknown is not None else None}


def rows_costs(stages):
    out, every = [], []
    for st in stages:
        for cid in stage_configs(st):
            for cat in stage_categories(st):
                s, t, _ = scope(st, cid, cat)
                if s:
                    out.append(cost_row(st.label, "明细", s, len(t), cid, st.configs[cid]["group"], st.configs[cid]["c"], CATEGORY.get(cat, cat)))
        out.append(cost_row(st.label, "阶段合计", st.summary, len(st.tasks)))
        every += st.summary
    if len(stages) > 1:
        out.append(cost_row("全部", "总计", every, sum(len(st.tasks) for st in stages)))
    return out


def spec_failures():
    return [ID_COLS[0], ID_COLS[1], ID_COLS[2], CAT_COL, col("kind", "类别", "", "官方失败类型、运行失败和跳过、单题受限（按终态）。", "tasks.json", "text"),
            col("type", "类型", "", "具体类型。", "tasks.officialFailureType / failureType / executionOutcome", "text"),
            col("count", "次数", "题", "这一类型的题数。", "tasks.json", "int"), col("share", "占比", "比例", "次数 ÷ 本配置本题型的任务数。", "tasks.json", "pct")]


def rows_failures(stages):
    out = []
    for st in stages:
        for cid in stage_configs(st):
            for cat in stage_categories(st):
                t = [x for x in st.tasks if x["configId"] == cid and x["category"] == cat]
                if not t:
                    continue
                kinds = [("官方失败类型", Counter(x.get("officialFailureType") or "（无类型）" for x in t if x["correct"] is False)),
                         ("运行失败和跳过", Counter("%s %s" % (x["state"], x.get("failureType") or "") for x in t if x["state"] != "completed")),
                         ("单题受限", Counter(OUTCOME_CN.get(x.get("executionOutcome"), x.get("executionOutcome")) for x in t if x.get("taskStatus") == "terminated"))]
                for kind, counter in kinds:
                    for typ, n in sorted(counter.items(), key=lambda kv: (-kv[1], kv[0])):
                        out.append({"stage": st.label, "configId": cid, "group": st.configs[cid]["group"], "category": CATEGORY.get(cat, cat), "kind": kind, "type": typ, "count": n, "share": n / len(t)})
    return out


def spec_profile():
    return [ID_COLS[0], CAT_COL, col("copiesText", "候选分法", "上下文/问模型/工具/记忆", "8 份分给四类能力的一种分法（每类至少 1 份），共 35 种。", "profile.ts optimize 的枚举", "text"),
            col("contextMs", "挑选上下文干活", "毫秒", "剖析 8 道题里这一能力的干活时间合计。", "targeted-split.json byCategory.A", "float"),
            col("inferMs", "问模型干活", "毫秒", "同上；问模型一步扣掉了重连等待（profile.ts 原规则）。", "targeted-split.json byCategory.A", "float"),
            col("interactionMs", "工具干活", "毫秒", "同上。", "targeted-split.json byCategory.A", "float"), col("memoryMs", "记忆干活", "毫秒", "同上。", "targeted-split.json byCategory.A", "float"),
            col("objectiveMs", "目标值", "毫秒", "各能力“干活时间 ÷ 份数”的最大值；越小越好。", "profile.ts optimize", "float"),
            col("selected", "选中", "是/否", "现行规则选中的分法（目标值最小，平手取字典序最小）。", "targeted-split.json byCategory.copies", "bool"),
            col("inferRateWaitMs", "问模型里的限速等待", "毫秒", "问模型步骤记录的出口限速等待合计（含重试冷却期间的等待）。", "steps modelTiming.rateWaitMs（profile-basis 报告）", "float"),
            col("objectiveAfterMs", "扣限速等待后的目标值", "毫秒", "问模型干活时间扣掉限速等待后，同一分法的目标值。", "profile-basis 报告", "float"),
            col("selectedAfter", "扣后选中", "是/否", "按扣后的值会选中的分法。", "profile-basis 报告", "bool")]


def rows_profile(stages, report):
    out = []
    for st in stages:
        if not st.split:
            continue
        for cat in CATEGORY_ORDER:
            info = st.split["byCategory"].get(cat)
            if not info:
                continue
            A, chosen = info["A"], info["copies"]
            rep = (report or {}).get("byCategory", {}).get(cat)
            after = {json.dumps(c["copies"], sort_keys=True): c["objectiveMsAfterRateWait"] for c in rep["candidates"]} if rep else {}
            chosen_after = rep["after"]["copies"] if rep and "copies" in rep["after"] else None
            for a in range(1, 6):
                for b in range(1, 7 - a):
                    for c in range(1, 8 - a - b):
                        d = 8 - a - b - c
                        if d < 1:
                            continue
                        x = dict(zip(CAPS, [a, b, c, d]))
                        objective = max(A[k] / x[k] for k in CAPS)
                        key = json.dumps(x, sort_keys=True)
                        out.append({"stage": st.label, "category": CATEGORY[cat], "copiesText": "/".join(str(x[k]) for k in CAPS), "contextMs": A["Context"], "inferMs": A["Infer"], "interactionMs": A["Interaction"], "memoryMs": A["Memory"],
                                    "objectiveMs": objective, "selected": x == chosen, "inferRateWaitMs": rep["rateWaitMs"]["Infer"] if rep else None,
                                    "objectiveAfterMs": after.get(key), "selectedAfter": (x == chosen_after) if chosen_after else None})
    return out


def spec_load():
    return [ID_COLS[0], col("blockId", "块", "", "块标识。", "blockLoad.blockId", "text"), CAT_COL, col("round", "轮次", "轮", "第几轮。", "blockLoad.round", "int"),
            ID_COLS[1], ID_COLS[2], ID_COLS[5],
            col("requests", "请求数", "次", "这一块这一配置发出的模型请求（含失败）。", "egressLoad.requests", "int"),
            col("peakInFlight", "在途峰值", "个", "同时在出口上的请求数最大值（由请求起止时间重建）。", "egressLoad.egressPeakInFlight", "int"),
            col("meanInFlight", "在途均值", "个", "请求时长之和 ÷（首个请求开始到最后一个返回）。", "egressLoad.egressMeanInFlight", "float"),
            col("http429", "HTTP 429", "次", "收到 429 的次数。", "egressLoad.http429", "int"), col("timeouts", "超时", "次", "请求超时次数。", "egressLoad.timeouts", "int"),
            col("retries", "重试", "次", "重试发出的请求数。", "egressLoad.retries", "int"), col("apiP95", "模型 API p95", "毫秒", "成功请求的 API 耗时 p95。", "egressLoad.modelApiP95Ms", "float"),
            col("blockPeakInFlight", "整块在途峰值", "个", "这一块所有配置合起来的出口在途峰值。", "blockLoad.egressPeakInFlight", "int"),
            col("maxUnits", "同时在跑配置数", "个", "这一块里同时在跑的容器（配置）数最大值。", "blockLoad.maxConcurrentUnits", "int"),
            col("oom", "OOM", "次", "这一块里因内存不足被杀的容器数。", "blockLoad.oomKilled", "int"),
            col("hostMinFreeGiB", "宿主最低空闲内存", "GiB", "块内宿主（Windows）空闲物理内存的最小值，2 秒一次。", "blockLoad.hostMinFreeMemoryBytes", "float"),
            col("hostMaxCpu", "宿主 CPU 峰值", "%", "块内宿主 CPU 占用的最大值。", "blockLoad.hostMaxCpuPercent", "float"),
            col("vmMaxContainerGiB", "Docker 虚拟机内容器内存峰值", "GiB", "块内所有在跑容器内存之和的最大值（docker stats，5 秒一次）；阶段 2 还没有这项采样，留空。", "blockLoad.dockerVmMaxContainerMemBytes", "float"),
            col("vmMinFreeGiB", "Docker 虚拟机可用内存下限估计", "GiB", "虚拟机总内存 − 容器内存之和的最小值；没算虚拟机自身和缓存占用，是偏高的估计；阶段 2 留空。", "blockLoad.dockerVmMinApproxAvailableBytes", "float")]


def rows_load(stages):
    out = []
    for st in stages:
        bl = {b["jobKey"]: b for b in st.block_load}
        for e in sorted(st.egress, key=lambda e: (e["round"], cat_sort(e["category"]), e["blockId"], config_sort(st, e["configId"]))):
            b = bl.get(e["jobKey"], {})
            out.append({"stage": st.label, "blockId": e["blockId"], "category": CATEGORY.get(e["category"], e["category"]), "round": e["round"], "configId": e["configId"], "group": e["group"], "c": e["c"],
                        "requests": e["requests"], "peakInFlight": e["egressPeakInFlight"], "meanInFlight": e["egressMeanInFlight"], "http429": e["http429"], "timeouts": e["timeouts"], "retries": e["retries"],
                        "apiP95": e.get("modelApiP95Ms"), "blockPeakInFlight": b.get("egressPeakInFlight"), "maxUnits": b.get("maxConcurrentUnits"), "oom": b.get("oomKilled"),
                        "hostMinFreeGiB": b["hostMinFreeMemoryBytes"] / 1024 ** 3 if num(b.get("hostMinFreeMemoryBytes")) else None, "hostMaxCpu": b.get("hostMaxCpuPercent"),
                        "vmMaxContainerGiB": b["dockerVmMaxContainerMemBytes"] / 1024 ** 3 if num(b.get("dockerVmMaxContainerMemBytes")) else None,
                        "vmMinFreeGiB": b["dockerVmMinApproxAvailableBytes"] / 1024 ** 3 if num(b.get("dockerVmMinApproxAvailableBytes")) else None})
    return out


def spec_pending():
    return [ID_COLS[0], col("reservationId", "请求 ID", "", "账本预留 ID，也是 egress/model-records 下的文件名。", "modelRequests.reservationId", "text"),
            ID_COLS[1], CAT_COL, col("caseId", "题号", "", "BFCL 原题编号。", "modelRequests.caseId", "text"),
            col("turn", "轮", "", "对话第几轮。", "modelRequests.turn", "int"), col("step", "步", "", "本轮第几次请求。", "modelRequests.step", "int"),
            col("startedAt", "请求时间（北京）", "", "请求发出时间。", "modelRequests.requestStartedAt", "text"),
            col("apiMs", "耗时", "毫秒", "请求从发出到失败的时间。", "modelRequests.apiMs", "float"),
            col("error", "连接错误", "", "出口记录的失败阶段和错误码。", "modelRequests.transportPhase / transportCode", "text"),
            col("ledgerStatus", "账本状态", "", "retained = 出口按规则保留预留；pending = 没有结算也没有保留行。", "modelRequests.ledgerStatus", "text"),
            col("confirmation", "用户确认状态", "", "未确认；确认未扣费；确认已扣费。", "scheduler/fee-confirmations.jsonl", "text"),
            col("confirmedChargedCny", "确认实际收费", "元", "用户确认扣了多少钱。", "fee-confirmations.chargedCny", "float"),
            col("heldPeakCny", "未知预留", "元（峰价）", "仍保留的预留额（确认后为空）。", "modelRequests.heldPeakCny", "float"),
            col("heldUsd", "未知预留（美元）", "美元", "同上，参考美元。", "modelRequests.heldReferenceUsd", "float"),
            col("retried", "后来重试成功", "是/否", "同一题同一轮同一步之后有成功的请求。", "modelRequests", "bool"),
            col("recordFile", "原始请求", "", "出口记录文件，含请求体和失败详情。", "modelRequests.recordFile", "text")]


def rows_pending(stages):
    out = []
    for st in stages:
        for q in st.requests:
            if q["ledgerStatus"] not in ("retained", "pending"):
                continue
            later = any(x["taskId"] == q["taskId"] and x["turn"] == q["turn"] and x["step"] == q["step"] and x["status"] == "completed" for x in st.requests)
            out.append({"stage": st.label, "reservationId": q["reservationId"], "configId": q["configId"], "category": CATEGORY.get(q["category"], q["category"]), "caseId": q["caseId"], "turn": q["turn"], "step": q["step"],
                        "startedAt": beijing(q["requestStartedAt"]), "apiMs": q["apiMs"], "error": " ".join(x for x in [q.get("transportPhase"), q.get("transportCode")] if x) or None, "ledgerStatus": q["ledgerStatus"],
                        "confirmation": {"not-charged": "确认未扣费", "charged": "确认已扣费"}.get(q.get("feeConfirmation"), "未确认"), "confirmedChargedCny": q.get("confirmedChargedCny"),
                        "heldPeakCny": q.get("heldPeakCny"), "heldUsd": q.get("heldReferenceUsd"), "retried": later, "recordFile": q.get("recordFile")})
    return out


def spec_gaps():
    return [ID_COLS[0], ID_COLS[1], CAT_COL, col("round", "轮次", "轮", "第几轮。", "summary.round", "int"),
            col("attempts", "尝试次数", "次", "这一配置各块的尝试次数之和。", "blocks.attempts", "int"),
            col("nonConcurrent", "补跑标记", "是/否", "有续跑或多次尝试。", "summary.nonConcurrent", "bool"),
            col("notStarted", "没开始", "题", "没有开始的题数。", "summary.notStarted", "int"), col("interrupted", "中断", "题", "被中断的题数。", "summary.interrupted", "int"),
            col("scoringMissing", "缺评分", "题", "有单题记录但没有评分。", "summary.scoringMissing", "int"), col("scoringFailed", "评分失败", "题", "评分程序出错。", "summary.scoringFailed", "int"),
            col("resourceSamplingOk", "采样达标", "是/否", "资源采样满足原规则。", "summary.resourceSamplingOk", "bool"),
            col("coverage", "采样覆盖率", "比例", "活动时间里被相邻两次可用采样覆盖的比例（最低一块）。中间夹着不可用样本时，跨过它的那一段仍算覆盖，覆盖率可能仍是 100%；这时看“不可用样本”和“采样达标”。", "summary.resourceMinCoverage", "pct"),
            col("maxGapMs", "最大采样间隔", "毫秒", "活动时间里没被采样覆盖的最长一段（开头、结尾或两次采样之间）。", "summary.resourceMaxGapMs", "float"),
            col("unavailable", "不可用样本", "个", "cgroup 采样里不可用的次数。", "summary.resourceUnavailableSamples", "int"),
            col("containerStats", "docker stats 完整", "是/否", "容器级 docker stats 是否覆盖整个生命周期；阶段 2 的 docker stats 在容器退出后才开始采，所以都是“否”，CPU 和内存以 cgroup 为准。", "summary.containerCpuSeconds", "bool"),
            col("notes", "缺项条数", "条", "导出 missing 列表的条数；原文在 summary.json / blocks.json，含义见阅读说明。", "summary.missing", "int")]


def rows_gaps(stages):
    out = []
    for st in stages:
        for r in sorted(st.summary, key=lambda r: (config_sort(st, r["configId"]), cat_sort(r["category"]), r["round"])):
            bl = [b for b in st.blocks if b["configId"] == r["configId"] and b["category"] == r["category"] and b["round"] == r["round"]]
            out.append({"stage": st.label, "configId": r["configId"], "category": CATEGORY.get(r["category"], r["category"]), "round": r["round"], "attempts": sum(len(b["attempts"]) for b in bl),
                        "nonConcurrent": r["nonConcurrent"], "notStarted": r["notStarted"], "interrupted": r["interrupted"], "scoringMissing": r["scoringMissing"], "scoringFailed": r["scoringFailed"],
                        "resourceSamplingOk": r["resourceSamplingOk"], "coverage": r["resourceMinCoverage"], "maxGapMs": r["resourceMaxGapMs"], "unavailable": r["resourceUnavailableSamples"],
                        "containerStats": r.get("containerCpuSeconds") is not None, "notes": len(r["missing"])})
    return out


# ---------------------------------------------------------------- workbook

def is_chinese(ch):
    n = ord(ch)
    return 0x3400 <= n <= 0x9FFF or 0xF900 <= n <= 0xFAFF or 0x20000 <= n <= 0x323AF or 0x3000 <= n <= 0x303F or 0xFF00 <= n <= 0xFFEF


def rich(text, bold=False):
    """Per-run fonts: SimSun for Chinese, Times New Roman for the rest."""
    runs = []
    for ch in text:
        face = CHINESE_FONT if is_chinese(ch) else LATIN_FONT
        if runs and runs[-1][0] == face:
            runs[-1][1] += ch
        else:
            runs.append([face, ch])
    if len(runs) == 1:
        return text, runs[0][0]
    return CellRichText([TextBlock(InlineFont(rFont=f, sz=FONT_SIZE, b=bold or None), s) for f, s in runs]), None


def display(value, kind):
    if value is None:
        return None
    if kind == "bool":
        return "是" if value else "否"
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


NUMBER_FORMAT = {"int": "0", "pct": "0.00%", "float": "0.000"}


def number_format(spec, values):
    kind = spec["kind"]
    if kind == "float":
        v = [abs(x) for x in values if num(x)]
        biggest = max(v) if v else 0
        if biggest >= 1000:
            return "#,##0.0"
        if biggest >= 1:
            return "0.000"
        return "0.000000"
    return NUMBER_FORMAT.get(kind)


def write_sheet(wb, name, spec, rows, freeze_cols=0):
    ws = wb.create_sheet(name)
    for j, c in enumerate(spec, start=1):
        header = c["name"] + ("\n（" + c["unit"] + "）" if c["unit"] else "")
        value, face = rich(header, bold=True)
        cell = ws.cell(row=1, column=j, value=value)
        cell.font = Font(name=face or LATIN_FONT, size=FONT_SIZE, bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for i, row in enumerate(rows, start=2):
        for j, c in enumerate(spec, start=1):
            v = display(row.get(c["field"]), c["kind"])
            if v is None:
                continue
            if isinstance(v, str):
                value, face = rich(v)
                cell = ws.cell(row=i, column=j, value=value)
                cell.font = Font(name=face or LATIN_FONT, size=FONT_SIZE)
            else:
                cell = ws.cell(row=i, column=j, value=v)
                cell.font = Font(name=LATIN_FONT, size=FONT_SIZE)
    for j, c in enumerate(spec, start=1):
        fmt = number_format(c, [r.get(c["field"]) for r in rows])
        letter = get_column_letter(j)
        if fmt:
            for i in range(2, len(rows) + 2):
                cell = ws.cell(row=i, column=j)
                if cell.value is not None and not isinstance(cell.value, (str, CellRichText)):
                    cell.number_format = fmt
        width = max([len(c["name"]) * 2 + 2, len(c["unit"]) * 2 if c["unit"] else 0] + [min(40, len(str(display(r.get(c["field"]), c["kind"]) or ""))) + 2 for r in rows[:200]])
        ws.column_dimensions[letter].width = max(8, min(42, width))
    ws.row_dimensions[1].height = 30
    if rows:
        ws.auto_filter.ref = "A1:%s%d" % (get_column_letter(len(spec)), len(rows) + 1)
    if freeze_cols:
        ws.freeze_panes = ws.cell(row=1, column=freeze_cols + 1).coordinate
    return ws


def set_default_font(wb):
    # Font 0 is openpyxl's Calibri (theme "minor" scheme). The Normal style and every cell without its own
    # font (the blank cells) point at it. Replace it in place, without a scheme, so the ids already given to
    # the other fonts stay valid.
    fonts = list(wb._fonts)
    fonts[0] = Font(name=LATIN_FONT, size=FONT_SIZE)
    wb._fonts = IndexedList(fonts)


def write_csv(path, spec, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([c["name"] + ("（" + c["unit"] + "）" if c["unit"] else "") for c in spec])
        for r in rows:
            out = []
            for c in spec:
                v = display(r.get(c["field"]), c["kind"])
                out.append("" if v is None else (repr(v) if isinstance(v, float) else v))
            w.writerow(out)


# ---------------------------------------------------------------- figures

def figures(stages, out_dir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": ["Times New Roman", "SimSun"], "font.size": 9, "axes.unicode_minus": False, "svg.fonttype": "none", "svg.hashsalt": "t9c1", "axes.edgecolor": "#333333"})
    made = []
    pilot = [st for st in stages if len(stage_configs(st)) > 1]
    for st in pilot:
        cids = stage_configs(st)
        data = [[t["elapsedSeconds"] for t in st.tasks if t["configId"] == c and num(t["elapsedSeconds"])] for c in cids]
        fig, ax = plt.subplots(figsize=(6.4, 3.2))
        ax.boxplot(data, labels=cids, widths=.5, medianprops={"color": "black"}, boxprops={"color": "#333333"}, whiskerprops={"color": "#333333"}, capprops={"color": "#333333"}, flierprops={"markeredgecolor": "#555555", "markersize": 3})
        for i, d in enumerate(data, start=1):
            ax.scatter([i] * len(d), d, s=8, color="#777777", zorder=3)
        ax.set_ylabel("单题执行耗时（秒）")
        ax.set_title("%s：各配置单题执行耗时（每配置 %d 题）" % (st.label, len(data[0]) if data else 0), fontsize=9)
        ax.tick_params(axis="x", labelrotation=30)
        ax.grid(axis="y", color="#dddddd", linewidth=.6)
        fig.tight_layout()
        made += save(fig, out_dir, "%s-单题执行耗时" % st.label.split()[0])
        plt.close(fig)
        # requests and valley cost per config
        reqs = [sum(t["modelRequests"] or 0 for t in st.tasks if t["configId"] == c) for c in cids]
        cost = [sum(t["knownValleyCny"] or 0 for t in st.tasks if t["configId"] == c) for c in cids]
        fig, ax = plt.subplots(figsize=(6.4, 3.0))
        ax.bar(range(len(cids)), cost, color="#888888", edgecolor="#333333", width=.6)
        for i, (c, r) in enumerate(zip(cost, reqs)):
            ax.text(i, c, "%d 次" % r, ha="center", va="bottom", fontsize=8)
        ax.set_xticks(range(len(cids)), cids, rotation=30)
        ax.set_ylabel("谷价已知费用（元）")
        ax.set_title("%s：各配置费用（柱顶为请求次数）" % st.label, fontsize=9)
        ax.grid(axis="y", color="#dddddd", linewidth=.6)
        fig.tight_layout()
        made += save(fig, out_dir, "%s-各配置费用" % st.label.split()[0])
        plt.close(fig)
    for st in stages:
        if not st.split:
            continue
        cats = [c for c in CATEGORY_ORDER if c in st.split["byCategory"]]
        fig, ax = plt.subplots(figsize=(6.4, 2.8))
        left = [0.0] * len(cats)
        shades = {"Context": "#e0e0e0", "Infer": "#555555", "Interaction": "#aaaaaa", "Memory": "#cccccc"}
        for k in CAPS:
            share = [st.split["byCategory"][c]["A"][k] / sum(st.split["byCategory"][c]["A"].values()) for c in cats]
            ax.barh(range(len(cats)), share, left=left, color=shades[k], edgecolor="#333333", label=CAP_CN[k], height=.55)
            left = [a + b for a, b in zip(left, share)]
        ax.set_yticks(range(len(cats)), [CATEGORY[c] for c in cats])
        ax.set_xlim(0, 1)
        ax.set_xlabel("干活时间占比")
        ax.legend(ncol=4, fontsize=8, frameon=False, loc="upper center", bbox_to_anchor=(.5, -.25))
        ax.set_title("%s：四类能力干活时间占比（分法均为 1/5/1/1）" % st.label, fontsize=9)
        fig.tight_layout()
        made += save(fig, out_dir, "%s-剖析能力占比" % st.label.split()[0])
        plt.close(fig)
    return made


def save(fig, out_dir, name):
    paths = []
    for ext in ["png", "svg"]:
        p = out_dir / ("%s.%s" % (name, ext))
        fig.savefig(p, dpi=200, metadata={"Date": None, "Software": None} if ext == "png" else {"Date": None, "Creator": None})
        paths.append(p.name)
    return paths


# ---------------------------------------------------------------- documents

def dictionary_md(title, sheets):
    lines = ["# 数据字典", "", "本字典对应 `%s`，由 `scripts/build-release.py` 按表结构生成。逐表列出 Excel 列号、字段、单位、定义和来源。" % title, "",
             "## 表的粒度", "", "| 工作表 | 数据行数 | 每行代表什么 |", "|---|---:|---|"]
    for s in sheets:
        lines.append("| %s | %d | %s |" % (s["name"], len(s["rows"]), s["grain"]))
    lines += ["", "所有工作表第 1 行是表头，第 2 行开始是数据。表头写成“中文名（单位）”。缺测、未知、不适用的格子留空，不补 0。单元格里是完整精度，显示的小数位只为阅读。",
              "“来源”一列里的 `summary`、`tasks`、`blocks`、`latency`、`stepPhases`、`processResources`、`blockLoad`、`workers`、`modelRequests`、`egressLoad` 指导出目录里的同名文件；`plan.json`、`targeted-split.json`、`official.json` 在原运行目录。", ""]
    for s in sheets:
        lines += ["## " + s["name"], "", s["grain"], "", "| Excel列 | 字段 | 显示名称 | 单位 | 定义 | 来源 |", "|---|---|---|---|---|---|"]
        for j, c in enumerate(s["spec"], start=1):
            lines.append("| %s | `%s` | %s | %s | %s | %s |" % (get_column_letter(j), c["field"], c["name"], c["unit"], c["definition"].replace("|", "/"), c["source"].replace("|", "/")))
        lines.append("")
    lines += ["## 导出口径（导出 metadata.json 原文要点）", "",
              "- **资源积分**：CPU 秒、内存积分按 cgroup 采样（200 毫秒一次）在活动时间内积分；有样本就照常积分，不外推。“采样达标”沿用原规则：窗口开头有样本、尾部缺口不超过一个采样间隔（T8c 修复前的旧采样器为 1000 毫秒，这是用户批准过的旧规则，原文保留在 metadata 的 `resourceRule` 和 `resourceTailPolicy`），并且没有不可用样本。不达标时数值照常给出，另看覆盖率、最大间隔和不可用样本数。注意：中间夹着不可用样本时，CPU 用累计计数跨过这一段、内存按线性插值，这一段仍算“覆盖”，所以覆盖率（`resourceCoverage`、`resourceMinCoverage`）可能仍报 1；这时要看不可用样本数（`resourceUnavailableSamples`）和采样达标（`resourceSamplingOk`，有不可用样本就是“否”）。",
              "- **内存单位**：`gibSeconds` 是 GiB·秒（1024³ 字节）；导出里另有 `gbSeconds`，是十进制 GB·秒（10⁹ 字节），含义没变，表里不用。",
              "- **费用**：谷价、峰价 = 已结算用量 × 冻结价表；谷价为主。参考美元是账本结算时记的美元。未知预留按峰价记在账本里，不清零；用户确认未扣费的请求记 0 元、不再算未知（确认记录在运行根 `scheduler/fee-confirmations.jsonl`，账本 `ledger.jsonl` 不改，里面的预留行原样保留，只是导出不再把确认过的请求算作未知）。用户确认已扣费的请求记在“已确认实付”一列：这是用户确认的实付金额，不按价表算、不分谷价峰价；这些请求的用量账本里没有，所以本范围内只要有一笔确认已扣费，导出的完整用量列（`inputTokens`、`reasoningTokens`、`valleyCny`、`peakCny` 等）照旧留空，表里的 token 和谷价、峰价已知费用也不含这笔钱。没有确认已扣费时“已确认实付”留空，不填 0。",
              "- **完成与终态**：`completed`（完成数）指留下了最终单题记录，含单题受限终止；终态看“执行终态”列。",
              "- **说明性长字段**：导出里的 `missing` 数组、`resourceRule` 等长说明不放进表格，见导出原文和阅读说明。", ""]
    return "\n".join(lines)


def export_commands(stages, template):
    return [(st, template.replace("{root}", st.rel)) for st in stages]


def reading_md(title, stages, sheets, export_template):
    st0 = stages[0]
    prices = st0.meta.get("priceTable") or {}
    lines = ["# 实验记录阅读说明", "", "本说明对应 `%s`。原始记录不复制，原位保留；表格里的数都能从下面的路径追回去。路径都从实验包根目录（`%s/`）算起。" % (title, PACKAGE_NAME), "", "## 1. 目录树", "", "```"]
    for st in stages:
        lines += ["%s/  （%s）" % (st.rel, st.label), "  plan.json                     冻结计划：配置、题目、价表、指纹",
                  "  blocks/<块>/<配置>/r<轮>/attempt-<n>/", "    output/configs/<配置>/tasks/<题号>.r<轮>.json   单题记录：对话、工具轨迹、终态、用量",
                  "    output/configs/<配置>/steps.jsonl              每一步：节点、落在哪份 Worker、四段耗时", "    output/configs/<配置>/resources.jsonl          cgroup 采样（200 毫秒）和进程采样（1 秒）",
                  "    output/configs/<配置>/graphs.jsonl, lifecycle.json, block-summary.json", "  egress/ledger.jsonl            账本：预留、结算、保留", "  egress/model-records/<请求ID>.json   每次请求的原始请求体、回复、耗时、失败详情",
                  "  egress/rate.jsonl, rate.cooldowns.jsonl, status.json", "  scores/<块键>/<配置>/<题号>/score-<n>/official.json   官方评分", "  scheduler/events.jsonl, host.jsonl   调度事件、宿主负载（2 秒一次）"]
        if st.split:
            lines.append("  targeted-split.json           剖析选出的 Targeted 分法")
    lines += ["```", "", "导出（表格的直接来源）不放进发布包。它由原始记录生成，同一份运行根导出两次逐字节相同；需要时在实验包根目录运行下面的命令重新生成，`<输出目录>` 换成一个还不存在的目录："]
    for st, cmd in export_commands(stages, export_template):
        lines.append("- %s：`%s`" % (st.label, cmd))
    last = stages[-1]
    lines += ["", "## 2. 从表追到一道题、一次请求、账本里的一行", ""]
    t = next((x for x in last.tasks if x["correct"] is False and x.get("modelRequests")), last.tasks[0])
    q = next((x for x in last.requests if x["configId"] == t["configId"] and x["caseId"] == t["caseId"]), None)
    lines += ["以“正式逐题”里的一行为例：阶段 %s、配置 `%s`、题号 `%s`。表里的文件路径列都相对运行根，前面加上运行根 `%s/` 就是从实验包根算起的路径。" % (last.label, t["configId"], t["caseId"], last.rel), "",
              "1. **单题记录**：这一行的“原始任务文件”列是 `%s`，即 `%s/%s`。打开它看 `messages`（完整对话）、`completed`（工具轨迹）、`executionOutcome`（终态）、`usage`。" % ((t.get("source") or {}).get("path"), last.rel, (t.get("source") or {}).get("path")),
              "2. **评分**：“评分文件”列是 `%s`，同目录的 `official.json` 有官方结果；未通过时 `official_result` 或 `irrelevance_result` 里有 `error_type`、`error_message`。" % t.get("scoreFile"),
              "3. **一次请求**：在导出的 `modelRequests.jsonl` 里按 `configId` 和 `caseId` 筛，可以看到这道题的每次请求%s。`recordFile` 列指向 `%s/egress/model-records/<请求ID>.json`，里面有原样的请求体和回复。" % ("（第一行请求 ID `%s`）" % q["reservationId"] if q else "", last.rel),
              "4. **账本**：在 `%s/egress/ledger.jsonl` 里搜同一个请求 ID，能找到一行 `reserve`（预留）和一行 `settle`（结算，含用量）；失败且可能扣费的是 `retain_failed`（保留预留）。" % last.rel,
              "5. **每一步**：`steps.jsonl` 里按 `taskId` 筛，`workerId` 是这一步落在哪份 Worker，`graphScheduleMs/ipcMs/queueMs/workMs` 是四段耗时。", "",
              "## 3. 费用口径", "",
              "- **价表**：%s，日期 %s。谷价每百万 token：缓存命中输入 %s 元、未命中输入 %s 元、输出 %s 元；峰价是谷价的 2 倍。" % (clean_note(prices.get("source"), st0.rel + "/plan.json"), prices.get("date"), (prices.get("valley") or {}).get("cachedInput"), (prices.get("valley") or {}).get("uncachedInput"), (prices.get("valley") or {}).get("output")),
              "- **已知费用** = 已结算请求的用量 × 价表。谷价为主，峰价并列。阶段 2 两次运行都在周六，全程谷价时段。",
              "- **参考美元**：账本结算时按参考单价记的美元，只用来和旧实验对照。",
              "- **未知预留**：请求失败、可能已扣费的，账本保留一笔预留（按峰价），不清零。用户确认后，用 `scripts/confirm-fee.ts` 往运行根 `scheduler/fee-confirmations.jsonl` 追加一行确认；导出读这份确认，确认未扣费的记 0 元、不再算未知；确认扣了钱的，金额记在“已确认实付”一列（用户确认的实付，不分谷价峰价，不含在已知费用里），这一范围的完整用量和谷价、峰价合计照旧留空。账本本身不改，里面的预留行原样保留。",
              "- 实际扣费以 DeepSeek 账单为准。", "",
              "## 4. 几个容易误读的地方", "",
              "- **完成数**包含单题受限终止的题；看“执行终态”。",
              "- **CPU 和内存**以容器 cgroup 采样为准；`docker stats` 在容器退出后才开始采，阶段 2 里都不完整，只作旁证。",
              "- **每题进程数**数的是这道题经过的 Node 进程和它自己的 Python 进程。",
              "- **单题记录里的 `realModelCalls`、`usageSource`**：阶段 2 的运行用的是修过 #48 的代码，单题记录写的是 `live`；如果以后看旧离线运行，这几个字段以账本为准。", ""]
    return "\n".join(lines)


def readme_md(title, stages, sheets, export_template, skipped, figs, script_path, code_version):
    lines = ["# %s" % title, "",
             "本包是实验一阶段 2 两次真实运行（2a 剖析、2b 小批）的结果草稿，按以前 multi-turn、MATH 大表的格式整理。模型 `deepseek-flash`，思考打开、推理强度 high。", "",
             "## 先打开什么", "",
             "1. `01_论文结果/结果汇总.xlsx`：先看“主结果”，再看“费用与用量”。",
             "2. `02_实验设置/实验记录阅读说明.md`：怎样从表追到一道题、一次请求、账本里的一行；费用口径。",
             "3. `02_实验设置/数据字典.md`：每张表每一列的单位、定义和来源。用 Python 或 R 分析时读 `01_论文结果/CSV/` 下的同名 CSV。", "",
             "## 结果概览", "", "| 项目 | " + " | ".join(st.label for st in stages) + " |", "|---|" + "---:|" * len(stages)]
    def per(fn):
        return " | ".join(fn(st) for st in stages)
    lines += [
        "| 题目执行次数 | " + per(lambda st: "%d 题 × %d 配置 = %d 次" % (len({(t['category'], t['caseId']) for t in st.tasks}), len(stage_configs(st)), len(st.tasks))) + " |",
        "| 官方通过 | " + per(lambda st: "%d / %d" % (sum(1 for t in st.tasks if t["correct"] is True), len(st.tasks))) + " |",
        "| 模型请求 | " + per(lambda st: "%d" % sum(r["requests"] for r in st.summary)) + " |",
        "| 每题请求数（最少/中位/最多） | " + per(lambda st: "%d / %g / %d" % (min(t["modelRequests"] for t in st.tasks), statistics.median(t["modelRequests"] for t in st.tasks), max(t["modelRequests"] for t in st.tasks))) + " |",
        "| 谷价已知费用 | " + per(lambda st: "%.4f 元" % sum(r["knownValleyCny"] for r in st.summary)) + " |",
        "| 峰价已知费用 | " + per(lambda st: "%.4f 元" % sum(r["knownPeakCny"] for r in st.summary)) + " |",
        "| 输入命中缓存 | " + per(lambda st: "%.1f%%" % (100 * sum(r["recordedCachedTokens"] for r in st.summary) / sum(r["recordedInputTokens"] for r in st.summary))) + " |",
        "| 未知请求（预留，峰价） | " + per(lambda st: "%d 笔（%.6f 元）" % (sum(r["unknownRequests"] for r in st.summary), sum(r["unknownHeldPeakCny"] for r in st.summary))) + " |",
        "| 单题受限 / 跳过 / 中断 | " + per(lambda st: "%d / %d / %d" % (sum(r["terminated"] for r in st.summary), sum(r["skipped"] for r in st.summary), sum(r["interrupted"] for r in st.summary))) + " |",
        "", "## 工作表导航", "", "| 工作表 | 行数 | 用途 |", "|---|---:|---|"]
    for s in sheets:
        lines.append("| %s | %d | %s |" % (s["name"], len(s["rows"]), s["purpose"]))
    lines += ["", "所有工作表第 1 行是表头，第 2 行开始是数据；2a 和 2b 在同一张表里，用“阶段”一列区分。"]
    if skipped:
        lines += ["", "**没出的表**：" + "；".join(skipped) + "。"]
    lines += ["", "## 必读说明", "",
              "- **每格样本很小，只看格式、不作结论。** 2b 每个配置 8 道题、每类每个配置 2 道；Direct 对照、比法一、比法二三张专表的每一格也只有 2 道（合计行 8 道）。耗时、请求数、费用的差别主要来自模型每次回答不一样。",
              "- **2b 看不出并发 8 的效果**：按题型分块，每块每个配置只有 2 道题，并发 8 的配置同一时间最多也只问 2 个请求。",
              "- **2a 不看对错**：剖析只用来定 Targeted 的分法（四类都是 1/5/1/1）；“剖析分配”表列出全部 35 种候选和扣掉限速等待后的对照。",
              "- **2a 有 1 笔未知费用**：long_context 第 151 题一次请求读回复时被对方断开（ECONNRESET），出口冷却 30 秒后重试成功；断开的那次按规则保留峰价预留，见“费用待确认”。",
              "- **比法二**在阶段 2 只有 Monolithic 8 份并发 8 一个配置，“相对 Monolithic”“速度相当”要三轮完整才给出，阶段 2 留空。",
              "- **Docker 虚拟机内存**阶段 2 还没有采样（段 C 补上了采样，阶段 3 起才有），“出口与机器负载”表那一列留空。", "",
              "## 路径", "",
              "以下路径都从实验包根目录（`%s/`）算起。本包只放成品；原始记录原位保留，导出不放进包里，可以随时重新生成。" % PACKAGE_NAME, "",
              "- 原运行目录：" + "；".join("%s `%s/`" % (st.label, st.rel) for st in stages)]
    lines += ["- 导出：在实验包根目录运行下面的命令，从原运行目录重新生成（同一份运行根导出两次逐字节相同；`<输出目录>` 换成一个还不存在的目录）："]
    for st, cmd in export_commands(stages, export_template):
        lines.append("  - %s：`%s`" % (st.label, cmd))
    lines += ["- 生成脚本：`%s`（同一脚本以后给阶段 3、4 用），代码版本 `%s`（`src`、`scripts`、`config`、`docker`、`tests` 五个目录逐文件 SHA-256 的总哈希 treeSha256）。表格、CSV、图和这三份说明都由它从导出生成。" % (script_path, code_version), ""]
    if figs:
        lines += ["图（`01_论文结果/图/`，PNG 供阅读、SVG 供排版，灰阶）：" + "、".join(sorted({f.rsplit('.', 1)[0] for f in figs})) + "。", ""]
    return "\n".join(lines)


def write_manifest(package, manifest_path, code_version):
    rows = []
    for p in sorted(package.rglob("*")):
        if p.is_file():
            rows.append({"path": p.relative_to(package).as_posix(), "bytes": p.stat().st_size, "sha256": sha256_file(p)})
    rows.sort(key=lambda r: r["path"])
    tree = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    body = {"package": package.name, "pathsRelativeTo": "package root", "codeVersion": code_version, "files": len(rows),
            "bytes": sum(r["bytes"] for r in rows), "treeSha256": tree, "rows": rows}
    with open(manifest_path, "x", encoding="utf-8", newline="\n") as f:
        json.dump(body, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return body


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--stage", action="append", required=True, help="label=export_dir=run_root")
    ap.add_argument("--profile-report")
    ap.add_argument("--script-path", default="scripts/build-release.py")
    ap.add_argument("--package-root", required=True, help="experiment package root; every path in the documents is relative to it")
    ap.add_argument("--code-version", required=True, help="treeSha256 of the frozen code (src, scripts, config, docker, tests)")
    ap.add_argument("--export-command", required=True, help="command that regenerates one export, run from the package root; {root} is replaced by the run root")
    ap.add_argument("--manifest", required=True, help="new JSON file outside the package: path, bytes and SHA-256 of every package file")
    args = ap.parse_args()
    out = Path(args.out)
    partial = out.with_name(out.name + ".partial")
    manifest = Path(args.manifest)
    for p in (out, partial, manifest):
        if p.exists():
            sys.exit("output exists: %s" % p)
    if os.path.abspath(manifest).startswith(os.path.abspath(out) + os.sep):
        sys.exit("--manifest must be outside the package: %s" % manifest)
    if "{root}" not in args.export_command or forbidden_hits(args.export_command) or forbidden_hits(args.script_path):
        sys.exit("--export-command needs {root} and neither it nor --script-path may name an absolute or scratch path")
    if not (len(args.code_version) == 64 and all(c in "0123456789abcdef" for c in args.code_version)):
        sys.exit("--code-version must be a 64-character lowercase SHA-256")
    global PACKAGE_NAME
    PACKAGE_NAME = Path(os.path.abspath(args.package_root)).name
    stages = []
    for s in args.stage:
        label, e, r = s.split("=", 2)
        stages.append(Stage(label, e, r, args.package_root))
    report = read_json(args.profile_report) if args.profile_report else None
    pair_rows, pair_cols = rows_pairs(stages)
    multi_round = any(len(st.rounds) > 1 for st in stages)
    sheets = [
        {"name": "主结果", "spec": spec_main(), "rows": rows_main(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型（各轮合并）。", "purpose": "每个配置每类题的成绩、速度、延迟、资源、请求与费用、异常"},
        {"name": "Direct对照", "spec": spec_direct(), "rows": rows_direct(stages), "freeze": 3, "grain": "每行：阶段 × 并发 × 题型（含合计）；左右两侧是 Direct 和同并发的 Monolithic。", "purpose": "Direct 与 Monolithic 并排、差值；每格样本很小，只看格式"},
        {"name": "比法一", "spec": spec_equal(), "rows": rows_equal(stages), "freeze": 4, "grain": "每行：阶段 × 题型 × 并发 × 配置（同 8 份的三组）。", "purpose": "同份数不同分法：goodput、每秒完成、排队、忙碌比例、Targeted÷Uniform"},
        {"name": "比法二", "spec": spec_cost(), "rows": rows_cost(stages), "freeze": 4, "grain": "每行：阶段 × 题型 × 配置（参加比法二的配置）。", "purpose": "速度相当时看资源；阶段 2 只有 Monolithic 8 份并发 8"},
        {"name": "四段耗时", "spec": spec_phases(), "rows": rows_phases(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次 × 能力 × 节点。", "purpose": "图调度、进程间传消息、排队、干活四段的合计、均值、p95"},
        {"name": "分层延迟", "spec": spec_latency(), "rows": rows_latency(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次 × 延迟层。", "purpose": "单题、模型 API、限速等待、重试冷却、图调度、进程间、各能力排队和干活"},
        {"name": "进程资源", "spec": spec_process(), "rows": rows_process(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次 × 进程角色。", "purpose": "按角色的进程数、常驻内存、CPU、内存积分"},
        {"name": "Worker负载", "spec": spec_workers(), "rows": rows_workers(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次 × Worker（各块各尝试相加）。", "purpose": "每份 Worker 的调用、出错、排队、干活、忙碌比例"},
        {"name": "正式逐题", "spec": spec_tasks(), "rows": rows_tasks(stages), "freeze": 2, "grain": "每行：一道题在一个配置一轮里的最终结果。", "purpose": "逐题成绩、终态、失败类型、请求、token、费用、耗时、原件路径"},
        {"name": "同题对照", "spec": spec_pairs(pair_cols), "rows": pair_rows, "freeze": 3, "grain": "每行：一道题的一轮；每个配置一列“通过/未通过”。", "purpose": "同一道题在各配置下是否通过"},
        {"name": "费用与用量", "spec": spec_costs(), "rows": rows_costs(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型的明细；每阶段一行合计，最后一行两阶段总计。", "purpose": "模型请求与用量、谷价、峰价、美元、未知预留，以及独立的搜索次数、费用和未知预留"},
        {"name": "失败与跳过", "spec": spec_failures(), "rows": rows_failures(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 类别 × 类型。", "purpose": "官方失败类型分布、运行失败和跳过、单题受限"},
        *([{"name": "剖析分配", "spec": spec_profile(), "rows": rows_profile(stages, report), "freeze": 2, "grain": "每行：一类题的一种候选分法（四类 × 35 种）。", "purpose": "四类能力干活时间、全部候选的目标值、选中哪个、扣限速等待后的对照"}] if report is not None else []),
        {"name": "出口与机器负载", "spec": spec_load(), "rows": rows_load(stages), "freeze": 2, "grain": "每行：阶段 × 块 × 配置。", "purpose": "出口在途、429、超时、重试、同时在跑配置数、OOM、宿主内存和 CPU"},
        {"name": "费用待确认", "spec": spec_pending(), "rows": rows_pending(stages), "freeze": 2, "grain": "每行：一笔未结算、可能已扣费的请求。", "purpose": "未知费用逐笔明细和用户确认状态"},
        {"name": "恢复与缺项", "spec": spec_gaps(), "rows": rows_gaps(stages), "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次。", "purpose": "尝试次数、补跑、没开始、中断、缺评分、资源采样达标与覆盖"},
    ]
    skipped = []
    if not multi_round:
        # T10: name the stages actually in this package (the reason used to say "阶段 2" whatever was packed).
        skipped.append("“逐轮结果”：本包的阶段（%s）每个配置只跑 1 轮，和“主结果”完全相同，不单列（跑三轮的阶段由同一脚本生成）" % "、".join(st.label for st in stages))
    else:
        sheets.insert(1, {"name": "逐轮结果", "spec": spec_main()[:7] + [col("round", "轮次", "轮", "第几轮。", "summary.round", "int")] + spec_main()[7:], "rows": [dict(merge_rows(st, *scope(st, cid, cat, rnd)), category=CATEGORY.get(cat, cat), round=rnd) for st in stages for cid in stage_configs(st) for cat in stage_categories(st) for rnd in st.rounds if scope(st, cid, cat, rnd)[0]], "freeze": 2, "grain": "每行：阶段 × 配置 × 题型 × 轮次。", "purpose": "主结果按轮拆开"})
    if report is None:
        # T10: without --profile-report the sheet used to come out empty (or without the rate-wait columns); it is left out instead.
        skipped.append("“剖析分配”：生成时没有给剖析依据报告（--profile-report），这张表不出%s" % ("；分法本身见运行根的 targeted-split.json" if any(st.split for st in stages) else ""))
    final_out, out = out, partial
    res = out / "01_论文结果"
    (res / "CSV").mkdir(parents=True)
    (res / "图").mkdir()
    (out / "02_实验设置").mkdir()
    wb = Workbook()
    wb.remove(wb.active)
    for s in sheets:
        write_sheet(wb, s["name"], s["spec"], s["rows"], s["freeze"])
        write_csv(res / "CSV" / (s["name"] + ".csv"), s["spec"], s["rows"])
    set_default_font(wb)
    wb.properties.creator = "build-release.py"
    wb.properties.created = dt.datetime(2026, 11, 7)
    wb.properties.modified = dt.datetime(2026, 11, 7)
    wb.save(res / "结果汇总.xlsx")
    figs = figures(stages, res / "图")
    docs = {
        "02_实验设置/数据字典.md": dictionary_md(args.title, sheets),
        "02_实验设置/实验记录阅读说明.md": reading_md(args.title, stages, sheets, args.export_command),
        "README.md": readme_md(args.title, stages, sheets, args.export_command, skipped, figs, args.script_path, args.code_version),
    }
    problems = ["%s: %s" % (name, hit) for name, text in docs.items() for hit in forbidden_hits(text)]
    for name, text in docs.items():
        (out / name).write_text(text, encoding="utf-8")
    # CSV and SVG text is checked too: none of these spellings belongs anywhere in the package.
    for p in sorted(out.rglob("*")):
        if p.is_file() and p.suffix.lower() in (".csv", ".svg"):
            problems += ["%s: %s" % (p.relative_to(out).as_posix(), hit) for hit in forbidden_hits(p.read_text(encoding="utf-8", errors="replace"))]
    if problems:
        print(json.dumps({"pathSelfCheck": "failed", "problems": problems, "left": str(out)}, ensure_ascii=False))
        sys.exit(3)
    os.rename(out, final_out)
    body = write_manifest(final_out, manifest, args.code_version)
    print(json.dumps({"out": str(final_out), "manifest": str(manifest), "files": body["files"], "treeSha256": body["treeSha256"], "pathSelfCheck": "passed",
                      "sheets": {s["name"]: len(s["rows"]) for s in sheets}, "figures": figs, "skipped": skipped}, ensure_ascii=False))


if __name__ == "__main__":
    main()
