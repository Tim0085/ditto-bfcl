"""Test-only response stall after a real BFCL tool action; never fabricates errors."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

cfg = FIX5
bridge_path = Path(cfg['bridge'])
sys.path.insert(0, str(bridge_path.parent))
spec = importlib.util.spec_from_file_location('fix5_bridge', bridge_path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
original_call = bridge.call_tool

def held_response(environment, tool_name, arguments):
    # Execute the real operation before holding its response. This leaves a real
    # request in flight in the unmodified TypeScript PythonBridge implementation.
    result = original_call(environment, tool_name, arguments)
    case_id = environment['case']['id']
    if case_id in cfg['cases']:
        event = {'event': 'tool-executed-response-held', 'pid': os.getpid(),
                 'caseId': case_id, 'tool': tool_name, 'arguments': arguments}
        path = Path(cfg['directory']) / ('python-' + str(os.getpid()) + '.json')
        with path.open('x', encoding='utf-8') as output:
            json.dump(event, output, ensure_ascii=False)
        time.sleep(60)
    return result

bridge.call_tool = held_response
bridge.serve()
