"""将正常结束题目的最终助手文字交给固定版本的官方检查器；每题一次独立进程，不调用模型。"""
import argparse
import inspect
import json
import math
from pathlib import Path
import sys

from common import ROOT, load_answers, file_hash, write_new
sys.path.insert(0, str(ROOT / "scripts"))
from verify_run import validate_termination
from bfcl_eval.eval_checker.agentic_eval.agentic_checker import agentic_checker


CHECKER = ROOT / "vendor/bfcl_eval/eval_checker/agentic_eval/agentic_checker.py"


def evaluate(case_id, final_response):
    if Path(inspect.getfile(agentic_checker)).resolve() != CHECKER.resolve():
        raise ValueError("加载的评分器不是包内固定版本")
    if final_response is not None and not isinstance(final_response, str):
        raise ValueError("评分输入须为最终助手回答的原始字符串")
    result = agentic_checker(final_response, load_answers(case_id)[case_id])
    return {"caseId": case_id, "valid": result["valid"], "official_result": result,
            "bfclCommit": "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8", "checkerSha256": file_hash(CHECKER)}


def final_assistant_content(task):
    output = task["modelSteps"][-1]["output"]
    message = output["message"]
    if output["finishReason"] != "stop" or message["role"] != "assistant":
        raise ValueError("正常结束的题缺少最终助手回答")
    raw = message.get("metadata", {}).get("chatMessage")
    if raw is not None and "content" not in raw:
        raise ValueError("最终助手消息缺少 content")
    content = message["content"] if raw is None else raw["content"]
    recorded = message["content"]
    if ((content is not None and (not isinstance(content, str) or content != recorded))
            or (content is None and recorded not in (None, ""))):
        raise ValueError("最终助手原文与模型步骤不一致")
    if task.get("transcriptFormat") == "full":
        final = next((m for m in reversed(task["messages"]) if m["role"] == "assistant"), None)
        if final is None or final["content"] != recorded:
            raise ValueError("最终助手原文与完整对话不一致")
    return content


def verify_trace(task):
    validate_termination(task)
    completed, steps, events = task["completed"], task["modelSteps"], task["workerEvents"]
    calls = [e for e in events if e["kind"] == "tool" and e["action"] == "call"]
    inferences = [e for e in events if e["kind"] == "infer"]
    if len(calls) != len(completed) or len(inferences) != len(steps):
        raise ValueError("真实 Worker 轨迹与任务步骤数量不一致")
    for event in calls + inferences:
        # 旧记录保留完整 input/result；精简记录必须明确记录成功状态。
        status = event.get("status", event.get("result", {}).get("status", "success" if "result" in event else None))
        if event.get("error") or status != "success":
            raise ValueError("Worker 事件未成功执行")
    for event, done in zip(calls, completed):
        if "input" in event and "result" in event:
            request = event["input"]["call"]["arguments"]["request"]
            actual = (request["tool_name"], request["arguments"], event["result"]["structuredContent"]["data"])
            if actual != (done["tool"], done["arguments"], done["result"]):
                raise ValueError("真实工具轨迹与已完成记录不一致")
        elif event.get("toolCallId") != done["id"]:
            raise ValueError("工具事件与已完成调用 ID 不一致")
    expected_calls = []
    for event, step in zip(inferences, steps):
        if "result" in event:
            if event["result"]["output"] != step["output"]:
                raise ValueError("推理记录与实际 Worker 返回不一致")
        elif event.get("actionRequestIds") != [call["id"] for call in step["output"].get("actionRequests", [])]:
            raise ValueError("推理事件与模型调用 ID 不一致")
        for call in step["output"].get("actionRequests", []):
            expected_calls.append((step["turn"], step["step"], call["id"], call["name"], call["arguments"]))
    actual_calls = [(c["turn"], c["step"], c["id"], c["tool"], c["arguments"]) for c in completed]
    terminal = task.get("termination", {})
    if terminal.get("source") == "context":
        expected_calls = expected_calls[:len(actual_calls)]
    if actual_calls != expected_calls:
        raise ValueError("工具执行记录与模型请求不一致")


def terminated_result(task):
    """只记录限额终态；没有调用官方评分器，不能冒充官方判错。"""
    # 已结算的model_output答题错误也记录为未完成，单独统计而不是模型限额。
    outcome = validate_termination(task)
    if outcome is None:
        raise ValueError("不是模型限额终态")
    return {"caseId": task["caseId"], "taskId": task["taskId"], "valid": False,
            "officialScoring": False, "scoringStatus": "not_evaluated_incomplete",
            "executionOutcome": outcome, "termination": task["termination"],
            "official_result": None, "irrelevance_result": None}


def normalize_score_diagnostics(result):
    """官方判分不变；极端工具状态的Inf/NaN诊断用合法JSON保存，避免答错变成评分异常。"""
    paths = []

    def encode(value, path):
        if isinstance(value, float) and not math.isfinite(value):
            paths.append(path)
            return {"type": "non-finite-float", "value": "NaN" if math.isnan(value) else "Infinity" if value > 0 else "-Infinity"}
        if isinstance(value, dict):
            return {key: encode(item, path + "/" + str(key)) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [encode(item, path + "/" + str(index)) for index, item in enumerate(value)]
        return value

    normalized = encode(result, "")
    if paths:
        normalized["diagnosticNormalization"] = {"nonFiniteNumbers": paths, "representation": "tagged JSON values"}
    return normalized


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=str)
    parser.add_argument("--output", type=str)
    parser.add_argument("--candidate", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.candidate:
        task = json.load(sys.stdin)
        result = evaluate(task["caseId"], final_assistant_content(task))
        print(json.dumps(result, ensure_ascii=False, default=str))
        return
    if not args.input or not args.output:
        parser.error("需要 --input 和 --output")
    with open(args.input, encoding="utf-8") as file:
        task = json.load(file)
    verify_trace(task)
    if task.get("status") == "terminated":
        result = terminated_result(task)
    else:
        result = evaluate(task["caseId"], final_assistant_content(task))
        result.update(taskId=task["taskId"], officialScoring=True, scoringStatus="evaluated", executionOutcome="completed")
    result.update(inputSha256=file_hash(args.input), backend=task.get("backend", "ditto"))
    write_new(args.output, normalize_score_diagnostics(result))
    print(json.dumps({"caseId": task["caseId"], "valid": result["valid"]}))


if __name__ == "__main__":
    main()
