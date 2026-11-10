"""将实际工具轨迹交给原版官方评分器；每题一次独立进程，不调用模型。"""
import argparse
import inspect
import json
import math
from pathlib import Path
import sys
import uuid

from common import ROOT, load_case, load_answers, category_of, create_environment, call_text, invocation_issue, file_hash, write_new
sys.path.insert(0, str(ROOT / "scripts"))
from verify_run import validate_termination
from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_checker import (
    multi_turn_checker, multi_turn_irrelevance_checker,
)


def decoded_calls(completed, model_steps, case):
    known = create_environment(case)["methods"]
    decoded = [[] for _ in case["question"]]
    if model_steps is not None:
        previous_turn = 1
        for step in model_steps:
            turn, number = step["turn"], step["step"]
            if type(turn) is not int or not previous_turn <= turn <= len(decoded) or number != len(decoded[turn - 1]) + 1:
                raise ValueError("模型轮次或步骤不连续")
            decoded[turn - 1].append([])
            previous_turn = turn
        if any(not steps for steps in decoded):
            raise ValueError("缺少用户轮次的模型记录")
    previous_turn = 1
    for done in completed:
        turn, name, arguments = done["turn"], done["tool"], done["arguments"]
        if type(turn) is not int or not previous_turn <= turn <= len(decoded):
            raise ValueError("工具题目、轮次或允许范围不正确")
        # 未知名字不能交给官方eval碰巧调用Python内置函数；保存原始尝试，评分用无定义标记。
        issue = invocation_issue(name, arguments, known)
        call = "bfcl_unknown_tool()" if issue else call_text(name, arguments)
        if model_steps is None:
            decoded[turn - 1].append([call])
        else:
            number = done["step"]
            if type(number) is not int or not 1 <= number <= len(decoded[turn - 1]):
                raise ValueError("工具调用没有对应模型步骤")
            decoded[turn - 1][number - 1].append(call)
        previous_turn = turn
    return decoded


def evaluate(case_id, completed, model_steps=None):
    checker = ROOT / "vendor/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py"
    if Path(inspect.getfile(multi_turn_checker)).resolve() != checker.resolve():
        raise ValueError("加载的评分器不是包内固定版本")
    case = load_case(case_id)
    answers = load_answers(case_id)
    reference = answers[case_id]
    decoded = decoded_calls(completed, model_steps, case)
    if len(reference) != len(decoded):
        raise ValueError("题目与答案轮数不匹配")
    model_name = "ditto_multiturn_" + uuid.uuid4().hex
    try:
        result = multi_turn_checker(decoded, reference, case, category_of(case_id), model_name)
    finally:
        # 官方工具把题内实例放在模块全局；只清理本次唯一名字，供连续离线验证复用进程。
        from bfcl_eval.eval_checker.multi_turn_eval.multi_turn_utils import execute_multi_turn_func_call
        namespace = execute_multi_turn_func_call.__globals__
        for name in list(namespace):
            if name.startswith(model_name + "_") and name.endswith("_instance"):
                del namespace[name]
    irrelevant = multi_turn_irrelevance_checker(decoded, reference)
    known = create_environment(case)["methods"]
    invalid = [{"turn": call["turn"], "step": call["step"], "tool": call["tool"], "arguments": call["arguments"],
                "reason": invocation_issue(call["tool"], call["arguments"], known)}
               for call in completed if invocation_issue(call["tool"], call["arguments"], known)]
    unknown = [{key: value for key, value in call.items() if key != "reason"}
               for call in invalid if call["reason"] == "unknown_tool"]
    return {"caseId": case_id, "valid": result["valid"] and irrelevant["valid"],
            "official_result": result, "irrelevance_result": irrelevant, "decoded_calls": decoded,
            **({"sanitizedInvalidInvocations": True, "invalidToolCalls": invalid} if invalid else {}),
            **({"unknownToolCalls": unknown} if unknown else {}),
            "bfclCommit": "6ea57973c7a6097fd7c5915698c54c17c5b1b6c8", "checkerSha256": file_hash(checker)}


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
        result = evaluate(task["caseId"], task["completed"], task.get("modelSteps"))
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
        result = evaluate(task["caseId"], task["completed"], task["modelSteps"])
        result.update(taskId=task["taskId"], officialScoring=True, scoringStatus="evaluated", executionOutcome="completed")
    result.update(inputSha256=file_hash(args.input), backend=task.get("backend", "ditto"))
    write_new(args.output, normalize_score_diagnostics(result))
    print(json.dumps({"caseId": task["caseId"], "valid": result["valid"]}))


if __name__ == "__main__":
    main()
