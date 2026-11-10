"""Web 题目的 JSON 行入口；一条进程连接只持有一道题的独立环境。"""
import argparse
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


def handle_request(request, environment, web_mode=None):
    if not isinstance(request, dict):
        raise ValueError("请求必须是 JSON 对象")
    action = request.get("action")
    if action == "init":
        if environment is not None:
            raise ValueError("同一进程不能重复初始化题目")
        case = load_case(request["case_id"])
        web_settings = dict(request.get("web") or {})
        if web_settings.pop("mode", web_mode) != web_mode:
            raise ValueError("Web 工具初始化与启动模式不一致")
        environment = create_environment(case, {**web_settings, "mode": web_mode})
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


def serve(web_mode):
    # stdout 只给协议行：真实 stdout 留作协议通道，进程里其余输出（官方 web_search.py 出错时的 print、
    # 工具线程里的打印等）一律改写到 stderr，不会混进 Node 按行读取的响应。
    protocol, sys.stdout = sys.stdout, sys.stderr
    environment = None
    for line in sys.stdin:
        try:
            result, environment = handle_request(json.loads(line), environment, web_mode)
            response = {"ok": True, "result": result}
            payload = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except Exception as error:
            response = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            payload = json.dumps(response, ensure_ascii=False, allow_nan=False)
        # Node readline 也把 U+2028、U+2029 当作行结束；转义后 JSON.parse 还原原字符，正文逐字不变。
        print(payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029"), file=protocol, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--web-mode", choices=("fixture", "replay", "live"), required=True)
    serve(parser.parse_args().web_mode)
