"""Verify the workbook columns using the synthetic TS export, without a formal run."""
import csv
import json
import runpy
import sys
from pathlib import Path
from tempfile import mkdtemp
from types import SimpleNamespace

from openpyxl import Workbook, load_workbook

run_root = Path(sys.argv[1])
export = run_root / "export"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


builder = runpy.run_path("scripts/build-release.py")
checker = runpy.run_path("scripts/check-release.py")
plan = read_json(run_root / "plan.json")
stage = SimpleNamespace(label="离线假数据", plan=plan, configs={c["id"]: c for c in plan["stage"]["configs"]},
                        summary=read_json(export / "summary.json"), tasks=read_json(export / "tasks.json"), requests=[])
out = Path(mkdtemp(prefix="wb-release-"))
paper = out / "01_论文结果"
(paper / "CSV").mkdir(parents=True)
wb = Workbook()
wb.remove(wb.active)
builder["set_default_font"](wb)
main = builder["rows_main"]([stage])
tasks = builder["rows_tasks"]([stage])
costs = builder["rows_costs"]([stage])
assert (main[0]["searchAttempts"], main[0]["searchCny"], main[0]["searchUnknownHeldCny"]) == (4, 0.005, 0.01)
assert (tasks[0]["searchAttempts"], tasks[0]["searchCny"], tasks[0]["searchUnknownHeldCny"]) == (4, 0.005, 0.01)
assert tasks[1]["searchAttempts"] is None and tasks[1]["searchCny"] is None and tasks[1]["searchUnknownHeldCny"] is None
assert tasks[2]["searchUnknownHeldCny"] == 0
assert (costs[-1]["searchAttempts"], costs[-1]["searchCny"], costs[-1]["searchUnknownHeldCny"], costs[-1]["pending"]) == (4, 0.005, 0.01, True)
assert costs[-1]["valleyCny"] is None and costs[-1]["peakCny"] is None
for name, spec, rows in (
    ("主结果", builder["spec_main"](), main),
    ("正式逐题", builder["spec_tasks"](), tasks),
    ("费用与用量", builder["spec_costs"](), costs),
):
    builder["write_sheet"](wb, name, spec, rows, 2)
    builder["write_csv"](paper / "CSV" / (name + ".csv"), spec, rows)

path = paper / "结果汇总.xlsx"
wb.save(path)
manifest = out.with_name(out.name + "-manifest.json")
builder["write_manifest"](out, manifest, "0" * 64)
assert checker["main"](out, manifest) == 0
wb = load_workbook(path, rich_text=True)
for name in wb.sheetnames:
    sheet = wb[name]
    names = [str(cell.value) for cell in sheet[1]]
    a, b, u = [names.index(name) + 1 for name in ("搜索次数", "搜索费用（元）", "搜索未知预留（元）")]
    assert sheet.cell(2, a).value == 4 and sheet.cell(2, b).value == 0.005
    assert sheet.cell(2, u).value == 0.01
    assert sheet.cell(2, b).font.name == sheet.cell(2, u).font.name == "Times New Roman"
    assert sheet.freeze_panes == "C1" and sheet.sheet_view.showGridLines is not False
    if name == "正式逐题":
        assert all(sheet.cell(3, col).value is None for col in (a, b, u))
        assert sheet.cell(4, u).value == 0
        with (paper / "CSV" / (name + ".csv")).open(encoding="utf-8-sig", newline="") as stream:
            data = list(csv.reader(stream))
            assert [data[2][col - 1] for col in (a, b, u)] == ["", "", ""]
            assert float(data[3][u - 1]) == 0.0
print("synthetic workbook and manifest validated:", out)
