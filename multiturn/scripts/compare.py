"""阶段1四关比对器；标准库、离线、所有产物只写 --output 的新目录。

例：python -B scripts/compare.py --new-run RUN --old-run OLD --cases cases.json
    --output NEW_OUTPUT [--gates request tools world score]
旧数据自检：--legacy-new monolithic（或 direct），无需伪造 requests.jsonl。
"""
import argparse
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
GATES = ('request', 'tools', 'world', 'score')
FILES = dict(zip(GATES, ('request-diff.json', 'tool-diff.json', 'world-diff.json', 'score-diff.json')))
MISSING = object()
CLASSES = {'GorillaFileSystem', 'TwitterAPI', 'TradingBot', 'MessageAPI',
           'TicketAPI', 'MathAPI', 'TravelAPI', 'VehicleControlAPI'}


def safe_path(path):
    path = Path(path).resolve()
    if any(p.lower() == 'private' or p.lower().startswith('.env') or
           'credentials' in p.lower() for p in path.parts):
        raise ValueError('拒绝读取凭据路径')
    return path


def read_json(path):
    return parse_json(safe_path(path).read_text(encoding='utf-8-sig'))


def parse_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError(f'JSON重复键：{key}')
            result[key] = value
        return result
    def invalid(value):
        raise ValueError(f'非JSON数值：{value}')
    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid)


def write_json(path, value):
    with Path(path).open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write('\n')


def field_path(path, key):
    if isinstance(key, int):
        return f'{path}[{key}]'
    return f'{path}.{key}' if re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key) else f'{path}[{json.dumps(key, ensure_ascii=False)}]'


def diff_fields(old, new, path='$'):
    """递归按字段比；对象键不计顺序，数组计顺序，缺失与null不同。"""
    if type(old) is type(new) and isinstance(old, dict):
        return [d for k in sorted(old.keys() | new.keys())
                for d in diff_fields(old.get(k, MISSING), new.get(k, MISSING), field_path(path, k))]
    if type(old) is type(new) and isinstance(old, list):
        return [d for i in range(max(len(old), len(new)))
                for d in diff_fields(old[i] if i < len(old) else MISSING,
                                     new[i] if i < len(new) else MISSING, field_path(path, i))]
    # JSON数字1与1.0表示同一个数；bool不能冒充整数。
    numeric = type(old) in (int, float) and type(new) in (int, float)
    if old is new or ((type(old) is type(new) or numeric) and old == new):
        return []
    return [{'path': path, 'old': None if old is MISSING else old,
             'new': None if new is MISSING else new,
             'oldMissing': old is MISSING, 'newMissing': new is MISSING}]


def located(diffs, config, case, turn=None, step=None, **extra):
    return [dict(configId=config, caseId=case, turn=turn, step=step, **d, **extra) for d in diffs]


def problem(config, case, message, path='$', turn=None, step=None, **extra):
    return dict(configId=config, caseId=case, turn=turn, step=step, path=path,
                old=None, new=None, error=message, **extra)


def position(row):
    case, turn, step = row['caseId'], row['turn'], row['step']
    if not isinstance(case, str) or any(type(v) is not int or v < 1 for v in (turn, step)):
        raise ValueError('题/轮/步格式无效')
    return case, turn, step


def index_requests(old_root, index_path, cases):
    """用T5位置索引读取原请求，独立核对哈希、题/轮/步和旧配置身份。"""
    index = read_json(index_path)
    if index.get('version') != 1 or not isinstance(index.get('records'), dict):
        raise ValueError('回放索引格式无效')
    rows = {}
    for key, entry in index['records'].items():
        case, turn, step = key.split('/')
        if case not in cases:
            continue
        if not re.fullmatch(r'[a-f0-9-]{36}\.json', entry['file']):
            raise ValueError('索引文件名无效')
        raw = safe_path(old_root / 'model-records' / entry['file']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError(f'索引哈希不符：{key}')
        record = parse_json(raw)
        expected = (case, int(turn), int(step))
        actual = (record['caseId'], record['logicalTurn'], record['logicalStep'])
        if actual != expected or record['taskId'] != f'full/{category(case)}/monolithic/monolithic-c1/{case}':
            raise ValueError(f'索引身份不符：{key}')
        rows[expected] = {'requestBody': record['requestBody'], 'source': entry}
    for case in cases:
        if not any(k[0] == case for k in rows):
            raise ValueError(f'索引缺题：{case}')
    return rows


def compare_requests(old, new, config, cases, check_egress=True):
    """位置取并集抓少步/多步；出口自报差异与独立重算分别留证。"""
    diffs = []
    for key in sorted(old.keys() | new.keys()):
        case, turn, step = key
        if case not in cases:
            continue
        a, b = old.get(key), new.get(key)
        if a is None or b is None:
            diffs += located(diff_fields(a if a is not None else MISSING,
                                        b if b is not None else MISSING, '$.position'), config, case, turn, step)
            continue
        diffs += located(diff_fields(a['requestBody'], b['requestBody'], '$.requestBody'),
                         config, case, turn, step, origin='independent')
        if check_egress:
            if b.get('source') != a['source']:
                diffs += located(diff_fields(a['source'], b.get('source', MISSING), '$.source'), config, case, turn, step)
            recorded = b.get('differences')
            if not isinstance(recorded, list):
                diffs.append(problem(config, case, '缺少出口differences数组', '$.differences', turn, step))
            else:
                for d in recorded:
                    if not isinstance(d, dict) or 'path' not in d:
                        diffs.append(problem(config, case, '出口差异格式无效', '$.differences', turn, step))
                    else:
                        diffs += located([{'path': d['path'], 'old': d.get('old'), 'new': d.get('new'),
                                           'oldMissing': d.get('oldMissing', False), 'newMissing': d.get('newMissing', False)}],
                                         config, case, turn, step, origin='egress')
    return diffs


def cross_requests(configs, cases):
    """每对配置按同一位置比较；每个不同位置报告第一个字段差异。"""
    diffs = []
    for (ca, a), (cb, b) in itertools.combinations(sorted(configs.items()), 2):
        for key in sorted(a.keys() | b.keys()):
            case, turn, step = key
            if case not in cases:
                continue
            delta = diff_fields(a[key]['requestBody'] if key in a else MISSING,
                                b[key]['requestBody'] if key in b else MISSING, '$.requestBody')
            diffs += located(delta[:1], cb, case, turn, step, oldConfigId=ca, newConfigId=cb, origin='cross-deployment')
    return diffs


def compare_tools(old, new, config, case):
    """step原样保留模型步骤编号；同一步可以含多个工具，绝不重编号。"""
    diffs = []
    a, b = old['completed'], new['completed']
    if not isinstance(a, list) or not isinstance(b, list):
        raise ValueError('completed必须是数组')
    for i in range(max(len(a), len(b))):
        left, right = a[i] if i < len(a) else None, b[i] if i < len(b) else None
        for item in (left, right):
            if item is not None and (not all(k in item for k in ('tool', 'arguments', 'turn', 'step')) or
                                     any(type(item[k]) is not int or item[k] < 1 for k in ('turn', 'step'))):
                raise ValueError(f'completed[{i}]缺字段或位置无效')
        def select(x):
            return {k: x[k] for k in ('tool', 'arguments', 'turn', 'step')} if x is not None else MISSING
        anchor = right if right is not None else left
        diffs += located(diff_fields(select(left), select(right), f'$.completed[{i}]'), config, case,
                         anchor['turn'], anchor['step'], oldTurn=left['turn'] if left else None,
                         oldStep=left['step'] if left else None)
    return diffs


class SnapshotAmbiguity(ValueError):
    def __init__(self, path, detail):
        self.path = path
        super().__init__('无法判断这里是内部标记还是业务数据：' + detail)


def snapshot_classes(snapshot):
    if not isinstance(snapshot, dict):
        raise ValueError('snapshot必须是对象')
    if snapshot.get('kind') != 'diagnostic-not-resume' or snapshot.get('version') != 1:
        raise ValueError('不支持的快照格式')
    classes = snapshot['classes']
    if not isinstance(classes, dict) or not classes or classes.keys() - CLASSES:
        raise ValueError('未知或空环境类，需明确语义后再比较')
    return classes


def normalize_world(snapshot, selected=None, include_diagnostics=False, representations=None):
    """解析诊断图，不执行类/代码。只移除已确认的导出诊断字段。

    ref先定位原始节点，再按排序后的语义路径展开；循环记回边。
    set排序而普通list不排序；保留_current_dir及车辆私有物理状态。
    _random是生成器续跑状态；不是本关比较的可见末态，但原始差异仍报告。
    """
    classes = snapshot_classes(snapshot)
    nodes, references, markers, collisions = {}, {}, {}, set()

    def marker(value):
        if not isinstance(value, dict) or not isinstance(value.get('type'), str):
            return None
        kind, keys = value['type'], set(value)
        if keys == {'type', 'items'} and kind == 'set' and isinstance(value['items'], list):
            return 'set'
        if keys == {'type', 'value'}:
            v = value['value']
            if kind == 'random-state' and isinstance(v, list): return 'random-state'
            if kind == 'datetime' and isinstance(v, str): return 'scalar'
            if kind == 'float' and isinstance(v, str) and v in {'nan', 'inf', '-inf'}: return 'scalar'
        if keys == {'type', 'attributes'} and isinstance(value['attributes'], dict):
            return 'object' if kind in CLASSES | {'File', 'Directory'} else 'ambiguous'
        if keys == {'type', 'repr'} and isinstance(value['repr'], str) and kind.isidentifier():
            return 'ambiguous'
        return None

    def register(value, path, plain=False, owner=None, contents=False, expected_object=None, expected_set=False):
        # bridge.py在set.items的导出路径中省略items，random-state中使用/state。
        if not isinstance(value, (dict, list)):
            return
        # 引用只指向原始遍历顺序中已出现的容器，不能指向自身、未来或基本值。
        if isinstance(value, dict) and set(value) == {'ref'} and not plain:
            ref = value['ref']
            if isinstance(ref, str) and ref in nodes and ref != path:
                references[id(value)] = (nodes[ref], ref)
                return
        if path in nodes:
            collisions.add(path)
        else:
            nodes[path] = value
        tag = None if plain else marker(value)
        if tag == 'object' and value['type'] not in (expected_object or set()):
            # 已知类名也可能是普通字典里的字符串；只有工具结构确定的对象位置才可信。
            tag = 'ambiguous'
        if tag == 'set' and not expected_set:
            tag = 'ambiguous'
        markers[id(value)] = tag
        if isinstance(value, list):
            for i, v in enumerate(value): register(v, f'{path}/{i}')
        elif tag == 'set':
            for i, v in enumerate(value['items']): register(v, f'{path}/{i}')
        elif tag == 'random-state':
            register(value['value'], path + '/state')
        else:
            for k, v in value.items():
                # vars(obj) 和 Directory.contents 明确是业务字典，不是对象包装。
                is_attrs = tag == 'object' and k == 'attributes'
                is_contents = owner == 'Directory' and k == 'contents'
                expected = None
                if contents: expected = {'File', 'Directory'}
                elif owner == 'GorillaFileSystem' and k in {'root', '_current_dir'}: expected = {'Directory'}
                elif owner == 'Directory' and k == 'parent': expected = {'Directory'}
                register(v, path + '/' + k, plain=is_attrs or is_contents,
                         owner=value['type'] if is_attrs else None, contents=is_contents,
                         expected_object=expected, expected_set=owner == 'MessageAPI' and k == 'generated_ids')
    for name, value in classes.items(): register(value, name, expected_object={name})

    def resolve(value, path):
        seen = set()
        while id(value) in references:
            if id(value) in seen:
                raise SnapshotAmbiguity(path, '引用循环')
            seen.add(id(value))
            value, ref = references[id(value)]
            if ref in collisions:
                raise SnapshotAmbiguity(path, '引用路径有多个目标：' + ref)
        return value

    def encode(value, path, active):
        if representations is not None and isinstance(value, (dict, list)):
            # 引用首次定义位置可以与内容一起变化，单独留其导出形式。
            form = {'ref': references[id(value)][1]} if id(value) in references else {'inline': True}
            representations[path] = {'form': form}
        value = resolve(value, path)
        if not isinstance(value, (dict, list)):
            return value
        if id(value) in active:
            return {'cycleTo': active[id(value)]}
        active = {**active, id(value): path}
        if isinstance(value, list):
            return [encode(v, field_path(path, i), active) for i, v in enumerate(value)]
        tag = markers.get(id(value))
        if tag == 'set':
            items = [encode(v, path + '.member', active) for v in value['items']]
            ordered = sorted(items, key=lambda x: json.dumps(x, sort_keys=True, ensure_ascii=False))
            if representations is not None:
                representations[path].update(items=items, ordered=ordered)
            return {'type': 'set', 'items': ordered}
        if tag == 'ambiguous':
            raise SnapshotAmbiguity(path, '未知对象类型或只有repr的快照')
        if tag == 'object':
            kind = value['type']
            attrs = resolve(value['attributes'], path + '.attributes')
            if not isinstance(attrs, dict): raise ValueError(f'attributes无效：{path}')
            ignored = {'_api_description'} if kind in CLASSES else set()
            if kind in {'MessageAPI', 'TradingBot', 'TravelAPI', 'VehicleControlAPI'}:
                ignored.add('_random')
            if kind == 'File': ignored.add('_last_modified')
            if include_diagnostics: ignored.clear()
            return {'type': kind, 'attributes': {k: encode(attrs[k], field_path(path + '.attributes', k), active)
                                               for k in sorted(attrs) if k not in ignored}}
        return {k: encode(value[k], field_path(path, k), active) for k in sorted(value)}
    return {name: encode(value, field_path('$.classes', name), {}) for name, value in sorted(classes.items())
            if selected is None or name in selected}


def compare_worlds(old, new, config, case):
    a, b = old['snapshot'], new['snapshot']
    if not isinstance(a, dict) or not isinstance(b, dict):
        raise ValueError('snapshot必须是对象')
    if a.get('caseId') != case or b.get('caseId') != case:
        raise ValueError('快照题号不符')
    ca, cb = snapshot_classes(a), snapshot_classes(b)
    diffs, exports = [], []
    expected = set(old['involvedClasses'])
    if set(ca) != expected: raise ValueError('旧快照环境类与involvedClasses不符')
    if set(cb) != expected:
        diffs += located(diff_fields(sorted(expected), sorted(cb), '$.classes'), config, case)
    for name in sorted(ca.keys() | cb.keys()):
        path = field_path('$.snapshot.classes', name)
        raw = diff_fields(ca.get(name, MISSING), cb.get(name, MISSING), path)
        # 先核对快照身份/格式/类集合；相同原始类不必解释内部标记。
        if not raw: continue
        try:
            forms_a, forms_b = {}, {}
            na = normalize_world(a, {name}, representations=forms_a).get(name, MISSING)
            nb = normalize_world(b, {name}, representations=forms_b).get(name, MISSING)
            delta = diff_fields(na, nb, path)
            diffs += located(delta, config, case, environmentClass=name, classification='状态真的不同')
            if not delta:
                export_delta = raw
            else:
                # 同类混合变化时，保留规范路径上的诊断变化，不把业务变化重复算作导出变化。
                full_a = normalize_world(a, {name}, True).get(name, MISSING)
                full_b = normalize_world(b, {name}, True).get(name, MISSING)
                def overlaps(p, q):
                    return p == q or p.startswith(q + '.') or p.startswith(q + '[') or q.startswith(p + '.') or q.startswith(p + '[')
                export_delta = [d for d in diff_fields(full_a, full_b, path)
                                if not any(overlaps(d['path'], x['path']) for x in delta)]
                for p in sorted(forms_a.keys() & forms_b.keys()):
                    fa, fb = forms_a[p], forms_b[p]
                    source_path = p.replace('$.classes', '$.snapshot.classes', 1)
                    export_delta += diff_fields(fa['form'], fb['form'], source_path + '.$representation')
                    if 'ordered' in fa and 'ordered' in fb and not diff_fields(fa['ordered'], fb['ordered']):
                        export_delta += diff_fields(fa['items'], fb['items'], source_path + '.items')
            exports += located(export_delta, config, case, environmentClass=name, classification='导出写法不同')
        except SnapshotAmbiguity as exc:
            diffs.append(problem(config, case, str(exc), exc.path.replace('$.classes', '$.snapshot.classes', 1), environmentClass=name,
                                 classification='无法判断内部标记', rawDifferences=raw))
    return diffs, exports


def score_task(task_path, output, timeout=120):
    """正规CLI评分，保留命令、完整stdout/stderr和退出码；失败不跳过。"""
    command = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'src/python/score.py'),
               '--input', str(task_path), '--output', str(output)]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
    try:
        run = subprocess.run(command, cwd=output.parent, env=env, capture_output=True,
                             text=True, encoding='utf-8', timeout=timeout)
        log = {'command': command, 'exitCode': run.returncode, 'stdout': run.stdout, 'stderr': run.stderr}
    except subprocess.TimeoutExpired as exc:
        log = {'command': command, 'exitCode': None, 'stdout': str(exc.stdout or ''),
               'stderr': str(exc.stderr or ''), 'error': '评分超时'}
    write_json(output.with_suffix('.process.json'), log)
    if log['exitCode'] != 0:
        raise ValueError(f'评分器报错（退出码{log["exitCode"]}），完整输出：{output.with_suffix(".process.json")}')
    return read_json(output)


def compare_scores(old, new, config, case):
    """比较官方/无关调用两项判定及评分状态；诊断正文和decoded_calls另留原评分。"""
    diffs = []
    for side in (old, new):
        if side.get('caseId') != case or type(side.get('valid')) is not bool:
            raise ValueError('评分缺题号或valid判定')
        for key in ('official_result', 'irrelevance_result'):
            value = side.get(key, MISSING)
            if value is MISSING or (value is not None and (not isinstance(value, dict) or type(value.get('valid')) is not bool)):
                raise ValueError(f'评分缺判定：{key}')
    for key in ('valid', 'officialScoring', 'scoringStatus', 'executionOutcome'):
        diffs += located(diff_fields(old.get(key, MISSING), new.get(key, MISSING), '$.' + key), config, case)
    for key in ('official_result', 'irrelevance_result'):
        a, b = old[key], new[key]
        diffs += located(diff_fields(a['valid'] if a is not None else None,
                                    b['valid'] if b is not None else None, '$.' + key + '.valid'), config, case)
    return diffs


def category(case):
    if not re.fullmatch(r'multi_turn_(base|miss_func|miss_param|long_context)_\d+', case):
        raise ValueError(f'题号格式无效：{case}')
    return case.rsplit('_', 1)[0]


def legacy_task(root, group, case):
    return root / 'full' / category(case) / group / (group + '-c1') / 'tasks' / (case + '.json')


def load_requests(paths, configs, cases):
    result = {config: {} for config in configs}
    errors, skipped = [], {}
    for path in dict.fromkeys(paths):
        with safe_path(path).open(encoding='utf-8-sig') as stream:
            for number, line in enumerate(stream, 1):
                row = {}
                try:
                    row = parse_json(line)
                    if not isinstance(row, dict):
                        row = {}
                        raise ValueError('请求记录必须是对象')
                    config = row['configId']
                    if config not in result:
                        skipped[config] = skipped.get(config, 0) + 1
                        continue
                    if row.get('caseId') not in cases:
                        continue
                    key = position(row)
                    if row.get('position') != '/'.join(map(str, key)) or not isinstance(row.get('requestBody'), dict):
                        raise ValueError('位置或requestBody无效')
                    if key in result[config]:
                        errors.append(problem(config, key[0], '重复请求位置（不能静默覆盖）',
                                              '$.position', key[1], key[2], sourceFile=str(path), sourceLine=number))
                        errors[-1].update(old=result[config][key]['requestBody'], new=row['requestBody'])
                        continue
                    result[config][key] = row
                except (ValueError, KeyError, TypeError) as exc:
                    errors.append(problem(row.get('configId'), row.get('caseId'), str(exc), '$.requests',
                                          row.get('turn'), row.get('step'), sourceFile=str(path), sourceLine=number))
    return result, errors, skipped


def legacy_requests(root, group, cases):
    rows = {}
    for case in cases:
        task = read_json(legacy_task(root, group, case))
        for step in task['modelSteps']:
            receipt = step['output']['message']['metadata']['budgetReceipt']['id']
            if not re.fullmatch(r'[a-f0-9-]{36}', receipt): raise ValueError('旧receipt格式无效')
            record = read_json(root / 'model-records' / (receipt + '.json'))
            key = (case, step['turn'], step['step'])
            if (record['caseId'], record['logicalTurn'], record['logicalStep']) != key or record['taskId'] != task['taskId']:
                raise ValueError('旧新侧请求身份不符')
            if key in rows: raise ValueError('旧新侧重复位置')
            rows[key] = {'requestBody': record['requestBody']}
    return rows


def task_path(directory, case):
    candidates = list((directory / 'tasks').glob(case + '.r*.json'))
    plain = directory / 'tasks' / (case + '.json')
    if plain.is_file(): candidates.append(plain)
    if len(candidates) != 1:
        raise ValueError(f'需要唯一单题结果，实际{len(candidates)}份：{case}；多次重复实验请拆目录')
    return safe_path(candidates[0])


def prepare_output(output, inputs):
    output = safe_path(output)
    protected = [ROOT.parents[1] / name for name in ('bfcl', 'bfcl_direct', 'bfcl_base', 'bfcl_web', 'math')]
    protected += [ROOT / 'runs/offline/replay-index', ROOT / 'src', ROOT / 'vendor', ROOT / 'data', ROOT / 'scripts', ROOT / 'tests']
    for p in protected + inputs:
        p = safe_path(p)
        if output == p or output.is_relative_to(p) or p.is_relative_to(output):
            raise ValueError(f'输出与只读输入/受保护目录重叠：{p}')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'comparison').mkdir()
    return output


def run_comparison(args):
    cases = read_json(args.cases)
    if not isinstance(cases, list) or not cases or len(cases) != len(set(cases)):
        raise ValueError('题单须为非空且不重复的JSON数组')
    for case in cases: category(case)
    old_root = safe_path(args.old_run)
    configs, paths, inputs = {}, [], [old_root, Path(args.index), Path(args.cases)]
    if args.legacy_new:
        new_root = safe_path(args.new_run[0] if args.new_run else args.old_run)
        if len(args.new_run or []) > 1: raise ValueError('旧数据模式只支持一个新运行目录')
        configs[args.legacy_new + '-c1'] = new_root
        inputs.append(new_root)
    else:
        for raw in args.new_run or []:
            root = safe_path(raw)
            inputs.append(root)
            dirs = sorted((root / 'configs').iterdir()) if (root / 'configs').is_dir() else [root]
            for directory in dirs:
                if not directory.is_dir(): continue
                config = directory.name
                if config in configs: raise ValueError(f'重复配置名：{config}')
                configs[config] = directory
                paths += [p for p in (directory / 'requests.jsonl', directory / 'egress/requests.jsonl') if p.is_file()]
            if (root / 'egress/requests.jsonl').is_file(): paths.append(root / 'egress/requests.jsonl')
    if not configs: raise ValueError('至少指定一个新运行配置')
    output = prepare_output(args.output, inputs)
    reports = {}
    failed = False
    for gate in GATES:
        if gate not in args.gates: continue
        report = {'gate': gate, 'status': '通过', 'differences': [], 'exportDifferences': []}
        if gate == 'request': report['skippedConfigs'] = {}
        reports[gate] = report
        diffs = report['differences']
        if failed:
            diffs.append(problem(None, None, '前一关不通过；按阶段1串行规则未运行本关'))
        else:
            try:
                if gate == 'request':
                    old_requests = index_requests(old_root, args.index, cases)
                    if args.legacy_new:
                        requests = {next(iter(configs)): legacy_requests(new_root, args.legacy_new, cases)}
                    else:
                        requests, errors, skipped = load_requests(paths, configs, cases)
                        report['skippedConfigs'] = skipped
                        diffs += errors
                    for config in configs:
                        diffs += compare_requests(old_requests, requests[config], config, cases, not args.legacy_new)
                    diffs += cross_requests(requests, cases)
                    report['positions'] = {c: len(r) for c, r in requests.items()}
                else:
                    for config, directory in configs.items():
                        for case in cases:
                            try:
                                old_path = legacy_task(old_root, 'monolithic', case)
                                new_path = legacy_task(directory, args.legacy_new, case) if args.legacy_new else task_path(directory, case)
                                old, new = read_json(old_path), read_json(new_path)
                                if not isinstance(old, dict) or not isinstance(new, dict): raise ValueError('单题结果必须是对象')
                                if old.get('caseId') != case or new.get('caseId') != case: raise ValueError('单题结果题号不符')
                                if gate == 'tools': diffs += compare_tools(old, new, config, case)
                                elif gate == 'world':
                                    delta, exports = compare_worlds(old, new, config, case)
                                    diffs += delta
                                    report['exportDifferences'] += exports
                                else:
                                    score_dir = output / 'scores' / config
                                    score_dir.mkdir(parents=True, exist_ok=True)
                                    new_score = score_task(new_path, score_dir / (case + '.json'), args.score_timeout)
                                    matches = [r for r in read_json(old_path.parent.parent / 'score.json')['results'] if r['caseId'] == case]
                                    if len(matches) != 1: raise ValueError('旧评分缺题或重复')
                                    diffs += compare_scores(matches[0], new_score, config, case)
                            except (OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
                                diffs.append(problem(config, case, str(exc), '$.' + gate))
            except (OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
                diffs.append(problem(None, None, str(exc), '$.' + gate))
        if diffs:
            report['status'] = '不通过'
            failed = True
        write_json(output / 'comparison' / FILES[gate], report)
    summary = {'status': '不通过' if failed else '通过', 'gates': {g: r['status'] for g, r in reports.items()},
               'caseCount': len(cases), 'configs': list(configs), 'requestedGates': args.gates,
               'differenceCounts': {g: len(r['differences']) for g, r in reports.items()},
               'skippedConfigs': reports.get('request', {}).get('skippedConfigs', {}),
               'output': str(output)}
    write_json(output / 'summary.json', summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--new-run', action='append', help='运行根目录或单配置目录，可重复')
    parser.add_argument('--old-run', required=True)
    parser.add_argument('--cases', required=True, help='题号JSON数组文件')
    parser.add_argument('--index', default=str(ROOT / 'runs/offline/replay-index/index.json'))
    parser.add_argument('--output', required=True, help='必须是尚不存在的输出目录')
    parser.add_argument('--gates', nargs='+', choices=GATES, default=list(GATES))
    parser.add_argument('--legacy-new', choices=['monolithic', 'direct'], help='只读旧数据自检适配')
    parser.add_argument('--score-timeout', type=int, default=120)
    args = parser.parse_args()
    try:
        summary = run_comparison(args)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(json.dumps({'status': '不通过', 'error': str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if summary['status'] == '通过' else 1


if __name__ == '__main__':
    sys.exit(main())
