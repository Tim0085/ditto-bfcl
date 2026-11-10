"""包内数据与官方环境装载；不读取凭据或调用模型。"""
import copy
import hashlib
import importlib
import inspect
import json
import keyword
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
CATEGORIES = ("multi_turn_base", "multi_turn_miss_func", "multi_turn_miss_param", "multi_turn_long_context")
sys.path.insert(0, str(ROOT / "vendor"))
sys.path.insert(0, str(ROOT / "vendor/python"))
from bfcl_eval.constants.executable_backend_config import (
    CLASS_FILE_PATH_MAPPING, MULTI_TURN_FUNC_DOC_FILE_MAPPING, STATELESS_CLASSES,
)


def read_jsonl(path):
    with Path(path).open(encoding="utf-8") as file:
        return [json.loads(line) for line in file if line.strip()]


def category_of(case_id):
    """题号决定官方类别；不接受任意路径或尚未接入的类别。"""
    if not isinstance(case_id, str) or not re.fullmatch(r"multi_turn_(base|miss_func|miss_param|long_context)_(0|[1-9][0-9]*)", case_id):
        raise ValueError(f"未知题目：{case_id}")
    category, number = case_id.rsplit("_", 1)
    if int(number) >= 200:
        raise ValueError(f"未知题目：{case_id}")
    return category


def data_path(category, kind="tasks"):
    if category not in CATEGORIES or kind not in {"tasks", "answers", "fixtures"}:
        raise ValueError("未知类别或数据类型")
    if category == "multi_turn_base":
        return ROOT / "data" / {"tasks": "tasks.jsonl", "answers": "answers.jsonl", "fixtures": "fixtures.json"}[kind]
    return ROOT / "data" / (category + "." + kind + (".json" if kind == "fixtures" else ".jsonl"))


def load_case(case_id):
    for case in read_jsonl(data_path(category_of(case_id))):
        if case["id"] == case_id:
            return case
    raise ValueError(f"未知题目：{case_id}")


def load_answers(category_or_case):
    category = category_or_case if category_or_case in CATEGORIES else category_of(category_or_case)
    return {item["id"]: item["ground_truth"] for item in read_jsonl(data_path(category, "answers"))}


def tool_documents(case, turn=1):
    if type(turn) is not int or not 1 <= turn <= len(case["question"]):
        raise ValueError("用户轮次超出题目范围")
    documents = []
    for name in case["involved_classes"]:
        path = ROOT / "data/tools" / MULTI_TURN_FUNC_DOC_FILE_MAPPING[name]
        documents.extend(read_jsonl(path))
    excluded = set(case.get("excluded_function", []))
    documents = [doc for doc in documents if doc["name"] not in excluded]
    # 官方先从初始列表移走全部缺失工具，再在指定的零起始轮次将其追加回来。
    missing = case.get("missed_function", {})
    withheld = {name for names in missing.values() for name in names}
    available = [doc for doc in documents if doc["name"] not in withheld]
    by_name = {doc["name"]: doc for doc in documents}
    for index, names in sorted(missing.items(), key=lambda item: int(item[0])):
        if int(index) < turn:
            for name in names:
                if name not in by_name:
                    raise ValueError("缺失工具不在本题官方工具集合中")
                available.append(by_name[name])
    return available


def set_turn(environment, turn):
    """只推进用户轮次，不重建工具实例或丢失此前状态。"""
    current = environment["turn"]
    if type(turn) is not int or turn not in {current, current + 1}:
        raise ValueError("用户轮次只能保持当前值或前进一步")
    documents = tool_documents(environment["case"], turn)
    environment["allowed"] = {doc["name"] for doc in documents}
    environment["turn"] = turn
    return {"turn": turn, "allowed_tools": [doc["name"] for doc in documents]}


def create_environment(case):
    """每题建立自己的全部官方实例；初始化参数深复制，避免跨题共享状态。"""
    long_context = category_of(case["id"]) == "multi_turn_long_context"
    instances = {}
    methods = {}
    for name in case["involved_classes"]:
        module_name = CLASS_FILE_PATH_MAPPING[name]
        module = importlib.import_module(module_name)
        if Path(inspect.getfile(module)).resolve() != (ROOT / "vendor" / (module_name.replace(".", "/") + ".py")).resolve():
            raise ValueError("加载的工具不是包内固定版本")
        cls = getattr(module, name)
        instance = cls()
        if name not in STATELESS_CLASSES:
            instance._load_scenario(copy.deepcopy(case["initial_config"].get(name, {})), long_context=long_context)
        instances[name] = instance
        for method_name, method in inspect.getmembers(instance, predicate=inspect.ismethod):
            if not method_name.startswith("_"):
                if method_name in methods:
                    raise ValueError(f"多个环境包含同名工具：{method_name}")
                methods[method_name] = method
    allowed = {doc["name"] for doc in tool_documents(case)}
    if not allowed <= methods.keys():
        raise ValueError("工具文档与官方环境方法不匹配")
    return {"case": case, "instances": instances, "methods": methods, "allowed": allowed, "turn": 1}


def call_text(name, arguments):
    if not isinstance(name, str) or not name.isidentifier() or name.startswith("_") or keyword.iskeyword(name):
        raise ValueError("工具名必须是公开标识符")
    if not isinstance(arguments, dict) or any(not isinstance(k, str) or not k.isidentifier() or keyword.iskeyword(k) for k in arguments):
        raise ValueError("工具参数必须为具名 JSON 对象")
    json.dumps(arguments, allow_nan=False)
    return name + "(" + ", ".join(f"{key}={value!r}" for key, value in arguments.items()) + ")"


def invocation_issue(name, arguments, methods):
    """区分传输格式错误与模型可纠正的工具错误；评分复用同一判断。"""
    if not isinstance(arguments, dict) or any(not isinstance(key, str) for key in arguments):
        raise ValueError("工具参数必须为 JSON 对象")
    json.dumps(arguments, allow_nan=False)
    if not isinstance(name, str) or name not in methods:
        return "unknown_tool"
    try:
        call_text(name, arguments)
    except ValueError:
        return "invalid_invocation"
    return None


def official_observation(value):
    """与官方 multi_turn_utils 的结果转字符串口径相同。"""
    if type(value) is str:
        return value
    if type(value) is dict:
        try:
            return json.dumps(value)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def call_tool(environment, name, arguments):
    issue = invocation_issue(name, arguments, environment["methods"])
    if issue == "unknown_tool":
        return {"observation": f"Error during execution: name '{name}' is not defined", "unknown_tool": True}
    if issue:
        return {"observation": "Error during execution: tool argument names must be valid named parameters", "invalid_invocation": True}
    # 官方隐藏的是模型可见文档；执行器仍查找涉及环境中的公开方法，不以文档集合作权限。
    try:
        # JSON 请求是值边界；官方方法可能保留列表引用，不能让后续操作改写历史参数。
        value = environment["methods"][name](**copy.deepcopy(arguments))
        return {"observation": official_observation(value)}
    except Exception as error:
        # 官方工具执行异常也是模型的观察；协议错误与未知工具在调用前拒绝。
        # 未知工具在上方以错误观察拒绝执行；不再将模型错误升级为整轮异常。
        return {"observation": f"Error during execution: {error}"}


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_new(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as file:
        json.dump(value, file, ensure_ascii=False, indent=2, allow_nan=False, default=str)
        file.write("\n")
