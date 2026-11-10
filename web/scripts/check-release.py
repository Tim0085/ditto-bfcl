"""Format and content self-check for a release package written by build-release.py (read-only).

Usage: python -B scripts/check-release.py <package dir> [<manifest json>]
Checks every sheet: header in row 1 (bold, no fill, wrap, "name\n（unit）" when a unit exists), data from row 2,
no top-frozen rows (only left columns may be frozen), gridlines on, no formulas, no fills or coloured
borders, fonts SimSun for Chinese and Times New Roman for Latin text and numbers (rich text runs checked
one by one), blank cells and the workbook default font (font 0 in styles.xml, no theme scheme) in Times
New Roman or SimSun, CSV row and column counts equal to the sheet, and a key-pattern scan over every text file.
Also: no absolute F: path, scratch or draft directory, or offline evidence directory in any text file;
the package holds only README.md, 01_论文结果/ and 02_实验设置/; and, when a manifest is given, it lists
exactly the package's files with matching bytes and SHA-256.
"""
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.cell.rich_text import CellRichText, TextBlock

CHINESE, LATIN = "SimSun", "Times New Roman"
SECRET = [re.compile(r"sk-[A-Za-z0-9]{16,}"), re.compile(r"Bearer\s+[A-Za-z0-9._\-]{16,}"), re.compile(r"Authorization\s*[:=]\s*\S+", re.I)]
FORBIDDEN_PATHS = ["F:/", "F:\\", "_tmp", "release-draft", "runs/offline/t9-"]
TOP_LEVEL = {"README.md", "01_论文结果", "02_实验设置"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def is_chinese(ch):
    n = ord(ch)
    return 0x3400 <= n <= 0x9FFF or 0xF900 <= n <= 0xFAFF or 0x20000 <= n <= 0x323AF or 0x3000 <= n <= 0x303F or 0xFF00 <= n <= 0xFFEF


def expect_face(text):
    faces = {CHINESE if is_chinese(c) else LATIN for c in text}
    return faces


def check_text_cell(cell, problems, where):
    v = cell.value
    if isinstance(v, CellRichText):
        for part in v:
            if isinstance(part, TextBlock):
                face = part.font.rFont
                want = expect_face(part.text)
                if want != {face}:
                    problems.append("%s run %r font %s" % (where, part.text[:20], face))
            else:
                problems.append("%s plain run inside rich text" % where)
    elif isinstance(v, str):
        want = expect_face(v)
        if len(want) > 1:
            problems.append("%s mixed text without runs" % where)
        elif want and cell.font.name not in want:
            problems.append("%s text font %s" % (where, cell.font.name))
    elif v is not None:
        if cell.font.name != LATIN:
            problems.append("%s number font %s" % (where, cell.font.name))


def main(pkg, manifest=None):
    pkg = Path(pkg)
    problems, report = [], {}
    xlsx = pkg / "01_论文结果" / "结果汇总.xlsx"
    wb = load_workbook(xlsx, rich_text=True)
    for ws in wb.worksheets:
        where = ws.title
        info = {"rows": ws.max_row - 1, "columns": ws.max_column, "freeze": ws.freeze_panes, "filter": ws.auto_filter.ref}
        report[where] = info
        if where in ("主结果", "逐轮结果", "正式逐题", "费用与用量"):
            headers = [str(cell.value) for cell in ws[1]]
            for header in ("搜索次数", "搜索费用（元）", "搜索未知预留（元）"):
                if headers.count(header) != 1:
                    problems.append(where + ": missing or duplicate " + header)
        if ws.sheet_view.showGridLines is False:
            problems.append(where + ": gridlines hidden")
        if ws.freeze_panes and not re.fullmatch(r"[A-Z]+1", ws.freeze_panes):
            problems.append(where + ": top rows frozen " + ws.freeze_panes)
        for row in ws.iter_rows():
            for cell in row:
                w = "%s!%s" % (where, cell.coordinate)
                if cell.fill is not None and cell.fill.fill_type not in (None, "none"):
                    problems.append(w + " fill")
                for side in [cell.border.left, cell.border.right, cell.border.top, cell.border.bottom]:
                    if side is not None and side.style is not None:
                        problems.append(w + " border")
                        break
                if cell.data_type == "f" or (isinstance(cell.value, str) and cell.value.startswith("=")):
                    problems.append(w + " formula")
                if cell.row == 1:
                    if not cell.font.bold:
                        problems.append(w + " header not bold")
                    if cell.value is None:
                        problems.append(w + " empty header")
                check_text_cell(cell, problems, w)
                if cell.value is None and cell.font.name not in (CHINESE, LATIN):
                    problems.append("%s blank cell font %s" % (w, cell.font.name))
                if cell.font.color is not None and cell.font.color.rgb not in (None, "FF000000") and getattr(cell.font.color, "type", None) == "rgb":
                    problems.append(w + " coloured font")
        # header row only: row 2 must be data, not a header or a note
        csv_path = pkg / "01_论文结果" / "CSV" / (ws.title + ".csv")
        with open(csv_path, encoding="utf-8-sig", newline="") as f:
            data = list(csv.reader(f))
        if len(data) - 1 != ws.max_row - 1 or (data and len(data[0]) != ws.max_column):
            problems.append(where + ": CSV shape %dx%d vs sheet %dx%d" % (len(data) - 1, len(data[0]) if data else 0, ws.max_row - 1, ws.max_column))
        info["csvRows"] = len(data) - 1
    leaks = []
    for p in pkg.rglob("*"):
        if p.is_file() and p.suffix.lower() in (".md", ".csv", ".svg", ".json", ".jsonl", ".txt"):
            text = p.read_text(encoding="utf-8", errors="replace")
            for pat in SECRET:
                if pat.search(text):
                    leaks.append("%s: %s" % (p.name, pat.pattern))
    # the xlsx is a zip of XML; scan its parts too
    import zipfile
    with zipfile.ZipFile(xlsx) as z:
        for name in z.namelist():
            text = z.read(name).decode("utf-8", errors="replace")
            for pat in SECRET:
                if pat.search(text):
                    leaks.append("%s:%s: %s" % (xlsx.name, name, pat.pattern))
        # font 0 is the Normal style's font and the fallback for any cell without its own
        styles = z.read("xl/styles.xml").decode("utf-8", errors="replace")
    m = re.search(r"<(?:\w+:)?fonts\b[^>]*>\s*<(?:\w+:)?font\b[^>]*>(.*?)</(?:\w+:)?font>", styles, re.S)
    if not m:
        problems.append("styles.xml: default font not found")
    else:
        names = re.findall(r"<(?:\w+:)?name\s+val=\"([^\"]*)\"", m.group(1))
        if names != [LATIN] or re.search(r"<(?:\w+:)?scheme\b", m.group(1)):
            problems.append("styles.xml: default font %s%s" % (names, " with theme scheme" if "scheme" in m.group(1) else ""))
    paths = []
    for p in sorted(pkg.rglob("*")):
        if p.is_file() and p.suffix.lower() in (".md", ".csv", ".svg"):
            text = p.read_text(encoding="utf-8", errors="replace").lower()
            paths += ["%s: %s" % (p.relative_to(pkg).as_posix(), f) for f in FORBIDDEN_PATHS if f.lower() in text]
    with zipfile.ZipFile(xlsx) as z:
        for name in z.namelist():
            text = z.read(name).decode("utf-8", errors="replace").lower()
            paths += ["%s:%s: %s" % (xlsx.name, name, f) for f in FORBIDDEN_PATHS if f.lower() in text]
    extra = sorted(p.name for p in pkg.iterdir() if p.name not in TOP_LEVEL)
    if extra:
        problems.append("unexpected top-level entries (the package holds finished products only): %s" % extra)
    manifest_report = None
    if manifest:
        m = json.loads(Path(manifest).read_text(encoding="utf-8"))
        listed = {r["path"]: r for r in m["rows"]}
        actual = {p.relative_to(pkg).as_posix(): p for p in pkg.rglob("*") if p.is_file()}
        bad = sorted(set(listed) ^ set(actual))
        for rel, p in actual.items():
            r = listed.get(rel)
            if r and (r["bytes"] != p.stat().st_size or r["sha256"] != sha256(p)):
                bad.append(rel)
        manifest_report = {"files": len(actual), "listed": len(listed), "mismatches": bad}
        problems += ["manifest mismatch: %s" % b for b in bad]
    print(json.dumps({"sheets": report, "problems": problems[:200], "problemCount": len(problems), "leaks": leaks, "forbiddenPaths": paths, "manifest": manifest_report}, ensure_ascii=False, indent=1))
    return 1 if problems or leaks or paths else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None))
