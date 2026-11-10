"""四类共800题的JSON行入口；一条进程连接只持有一道题的独立环境。"""
import datetime
import json
import math
import random
import sys

from common import load_case, create_environment, call_tool, set_turn


def snapshot(environment):
    """导出诊断状态；批次恢复复用已完成结果，不把此快照当作题内恢复协议。"""
    seen = {}

    def encode(value, path):
        if isinstance(value, float) and not math.isfinite(value):
            return {"type": "float", "value": str(value)}
        if value is None or isinstance(value, (str, bool, int, float)):
            return value
        if isinstance(value, datetime.datetime):
            return {"type": "datetime", "value": value.isoformat()}
        if isinstance(value, random.Random):
            return {"type": "random-state", "value": encode(value.getstate(), path + "/state")}
        identity = id(value)
        if identity in seen:
            return {"ref": seen[identity]}
        seen[identity] = path
        if isinstance(value, dict):
            return {str(k): encode(v, path + "/" + str(k)) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [encode(v, path + "/" + str(i)) for i, v in enumerate(value)]
        if isinstance(value, set):
            return {"type": "set", "items": [encode(v, path + "/" + str(i)) for i, v in enumerate(sorted(value, key=repr))]}
        if hasattr(value, "__dict__"):
            return {"type": type(value).__name__, "attributes": encode(vars(value), path + "/attributes")}
        return {"type": type(value).__name__, "repr": repr(value)}

    return {"version": 1, "kind": "diagnostic-not-resume", "caseId": environment["case"]["id"],
            "classes": {name: encode(instance, name) for name, instance in environment["instances"].items()}}


def handle_request(request, environment):
    if not isinstance(request, dict):
        raise ValueError("请求必须是 JSON 对象")
    action = request.get("action")
    if action == "init":
        if environment is not None:
            raise ValueError("同一进程不能重复初始化题目")
        case = load_case(request["case_id"])
        environment = create_environment(case)
        return {"case_id": case["id"], "involved_classes": case["involved_classes"]}, environment
    if environment is None:
        raise ValueError("请先初始化题目")
    if action == "turn":
        return set_turn(environment, request["turn"]), environment
    if action == "call":
        return call_tool(environment, request["tool_name"], request["arguments"]), environment
    if action == "snapshot":
        return snapshot(environment), environment
    raise ValueError(f"未知请求类型：{action}")


def serve():
    environment = None
    for line in sys.stdin:
        try:
            result, environment = handle_request(json.loads(line), environment)
            response = {"ok": True, "result": result}
            payload = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except Exception as error:
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            payload = json.dumps(response, ensure_ascii=False, allow_nan=False)
        print(payload, flush=True)


if __name__ == "__main__":
    serve()
