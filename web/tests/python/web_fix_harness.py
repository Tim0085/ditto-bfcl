"""tests/web-fix-channel.test.ts 用的启动器：运行真实的 bridge.py serve() 和真实工具路径
（common.call_tool、WebBackend.call、官方 WebSearchAPI、wire），只替换网络这一层：
- fetch_url_content 的正文取自 WEB_FIX_PAYLOADS/<网址最后一段>，按 UTF-8 字节解码，不改换行；
- search_engine_query 的关键词为 fail-plain / fail-429-once / payload-429-once 时抛错或回错误，
  让官方模块走到它会 print 的分支（web_search.py 第 156、166、177 行）；其他关键词用原 fixture 结果。
用法：python -B -X utf8 tests/python/web_fix_harness.py --web-mode fixture
"""
import argparse
import importlib.util
import os
import sys
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src/python"))
import common  # noqa: E402,F401  加载时把 vendor/python 放进 sys.path
import web_backend  # noqa: E402

payloads = Path(os.environ.get("WEB_FIX_PAYLOADS", "."))
answered_once = set()
fixture_search = web_backend.WebBackend._search


def fetch(self, url, **kwargs):
    text = (payloads / url.rsplit("/", 1)[-1]).read_bytes().decode("utf-8")
    return SimpleNamespace(text=text, raise_for_status=lambda: None)


def search(self):
    keywords = self._query["keywords"]
    if keywords == "fail-plain":
        raise Exception("simulated search failure")
    if keywords in ("fail-429-once", "payload-429-once") and keywords not in answered_once:
        answered_once.add(keywords)
        if keywords == "fail-429-once":
            raise Exception("simulated HTTP 429")
        return {"error": "simulated 429 in payload"}
    return fixture_search(self)


web_backend.WebBackend._fetch = fetch
web_backend.WebBackend._search = search
spec = importlib.util.spec_from_file_location("bridge_under_test", ROOT / "src/python/bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--web-mode", choices=("fixture", "replay", "live"), required=True)
    bridge.serve(parser.parse_args().web_mode)
