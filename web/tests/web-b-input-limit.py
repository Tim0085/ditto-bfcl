"""Check an actual fake-HTTP DeepSeek 400 terminal through the normal scorer."""
import copy
import json
import runpy
import sys
from pathlib import Path
from tempfile import mkdtemp

terminal_path = Path(sys.argv[1])
task = json.loads(terminal_path.read_text(encoding="utf-8"))
config = json.loads(Path("config/egress.offline.json").read_text(encoding="utf-8"))
sys.path.insert(0, str(Path('scripts').resolve()))
verify = runpy.run_path("scripts/verify_run.py")["validate_termination"]
assert verify(task, config) == "input_limit"
for field, invalid in (
    ("maxContextTokens", 1048577),
    ("inputBytes", 0),
    ("inputBytes", 1887437),
    ("maxRequestBytes", 8388608),
):
    bad = copy.deepcopy(task)
    bad["termination"][field] = invalid
    try:
        verify(bad, config)
    except (AssertionError, ValueError):
        pass
    else:
        raise AssertionError(f"accepted malformed provider terminal field: {field}")

score = Path(mkdtemp(prefix="wb-provider-score-")) / "score.json"
sys.path.insert(0, str(Path("src/python").resolve()))
sys.argv = ["src/python/score.py", "--input", str(terminal_path), "--output", str(score)]
runpy.run_path(sys.argv[0], run_name="__main__")
result = json.loads(score.read_text(encoding="utf-8"))
assert result["valid"] is False
assert result["officialScoring"] is False
assert result["scoringStatus"] == "not_evaluated_incomplete"
assert result["executionOutcome"] == "input_limit"
assert result["termination"] == task["termination"]
print("provider input-limit scoring artifact:", score)
