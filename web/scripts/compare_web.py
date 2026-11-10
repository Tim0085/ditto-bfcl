"""Web 四关。新旧终态边界独立验证，部署之间使用未经放宽的比较。"""
import copy
import hashlib
import itertools
import json
from pathlib import Path
import re
import subprocess

from compare import (ROOT, MISSING, comparison_env, cross_requests, diff_fields, field_path, load_requests,
                     located, parse_json, prepare_output, problem, read_json, safe_path,
                     score_task, write_json)

GATES = ('request', 'tools', 'replay', 'score')
REPORTS = ('request-diff.json', 'tool-diff.json', 'replay-check.json', 'score-diff.json')
WHITELIST = ROOT / 'src/ts/egress/backends/web-replay-request-differences.json'


def web_request_differences(old, new, rules):
    """Require the five exact transitions, then independently compare every other field."""
    expected = copy.deepcopy(old)
    errors = []
    for rule in rules:
        parent, path = expected, '$.requestBody'
        try:
            for key in rule['path'][:-1]:
                path = field_path(path, key)
                parent = parent[key]
            key = rule['path'][-1]
            path = field_path(path, key)
            if not isinstance(parent, dict):
                raise TypeError('白名单父字段不是对象')
        except (KeyError, IndexError, TypeError):
            errors.append({'path': path, 'error': '旧请求缺白名单父字段'})
            continue
        before, after = rule['old'], rule['new']
        value = MISSING if before.get('missing') else before['value']
        delta = diff_fields(value, parent.get(key, MISSING), path)
        if delta:
            errors.extend(dict(d, error='旧请求白名单值不符') for d in delta)
        if after.get('missing'):
            parent.pop(key, None)
        else:
            parent[key] = after['value']
    return errors + diff_fields(expected, new, '$.requestBody')


def rows(path):
    with safe_path(path).open(encoding='utf-8-sig') as stream:
        for line in stream:
            if not line.endswith('\n'):
                raise ValueError(f'不完整的 JSONL 行：{path}')
            yield parse_json(line)


def web_cases(value):
    if isinstance(value, dict):
        if value.get('status') != 'frozen':
            raise ValueError('需要冻结的 Web 题单')
        value = [row['caseId'] for row in value['cases']]
    if not isinstance(value, list) or not value or any(not isinstance(c, str) or not re.fullmatch(r'web_search_no_snippet_(0|[1-9][0-9]?)', c)
                        for c in value) or len(set(value)) != len(value):
        raise ValueError('无效或重复的 Web 题号')
    return value


def load_old_requests(source, index, cases):
    data = read_json(index)
    if data.get('version') != 1 or not set(cases) <= set(data['tasks']):
        raise ValueError('Web 回放索引缺少题目或版本无效')
    requests = {case: {} for case in cases}
    for key, entry in data['records'].items():
        case, turn, step = key.split('/')
        if case not in requests:
            continue
        if not re.fullmatch(r'[a-f0-9-]{36}\.json', entry['file']):
            raise ValueError('回放记录文件名无效')
        raw = safe_path(source / 'model-records' / entry['file']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError(f'回放记录哈希不符：{key}')
        record = parse_json(raw)
        position = (int(turn), int(step))
        if (record['caseId'], record['logicalTurn'], record['logicalStep']) != (case, *position):
            raise ValueError(f'回放记录位置不符：{key}')
        requests[case][position] = {'requestBody': record['requestBody'], 'source': entry}
    return requests


def load_old_scores(root, cases):
    data = read_json(root / 'web_search_no_snippet/r1-direct-c1/score.json')
    result = {}
    for row in data['tasks']:
        case = row['case_id']
        if case not in cases:
            continue
        if case in result or row['taskId'] != f'{case}-r1-direct-c1-copy1':
            raise ValueError(f'旧评分题号重复或身份不符：{case}')
        if row.get('status') == 'terminated' and row['official_scoring'] is False:
            result[case] = dict(valid=False, officialScoring=False, official_result=None)
        elif (row['official_scoring'] is True and type(row['valid']) is bool and
              row['official_result']['valid'] is row['valid']):
            result[case] = dict(valid=row['valid'], officialScoring=True, official_result=row['official_result'])
        else:
            raise ValueError(f'旧评分无效：{case}')
        result[case]['oldStatus'] = row.get('status', 'completed')
        result[case]['oldTerminationReason'] = row.get('terminationReason')
    if set(result) != set(cases):
        raise ValueError(f'旧评分缺题：{sorted(set(cases) - result.keys())}')
    return result


def measure_reference(source, index, tools, cases, settings, output):
    reference = output / 'reference.json'
    command = ['node', '--import', (ROOT / 'scripts/egress-offline-guard.mjs').as_uri(),
               '--experimental-transform-types', str(ROOT / 'src/ts/egress/backends/replay-reference.ts'), str(reference)]
    inputs = dict(source=str(source), index=str(index), tools=str(tools), cases=cases, settings=settings)
    run = subprocess.run(command, input=json.dumps(inputs), encoding='utf-8', capture_output=True,
                         cwd=ROOT, env=comparison_env(), timeout=120)
    write_json(output / 'reference-process.json',
               dict(command=command, exitCode=run.returncode, stderr=run.stderr, stdout=run.stdout))
    if run.returncode:
        raise ValueError('冻结回放参照重建失败，见 reference-process.json')
    return read_json(reference)


def run_files(roots, cases, settings):
    configs, task_files, request_files, call_files = set(), {}, [], []
    for root in roots:
        plan = root / 'plan.json'
        if plan.is_file():
            stage = read_json(plan)['stage']
            egress = stage['egress']
            if (egress['backend'] != 'replay' or egress['replay']['failOnDifference'] is not True or
                    diff_fields(settings, egress['settings'])):
                raise ValueError(f'阶段模型设置或严格回放模式不符：{plan}')
            ids = {cfg['id'] for cfg in stage['configs']}
            dirs = root.glob('blocks/*/*/r*/attempt-*/output/configs/*')
        else:
            dirs = list((root / 'configs').iterdir())
            ids = {d.name for d in dirs if d.is_dir()}
        if not ids or configs & ids:
            raise ValueError('运行根配置缺失或重复')
        configs.update(ids)
        request_files.append(root / 'egress/requests.jsonl')
        call_files.append(root / 'egress/calls.jsonl')
        for directory in dirs:
            if directory.name not in ids:
                raise ValueError(f'配置不在冻结计划中：{directory}')
            for kind in ('tasks', 'failures'):
                for file in (directory / kind).glob('*.json'):
                    case = file.name.split('.', 1)[0]
                    if case not in cases:
                        continue
                    key = (directory.name, case, kind)
                    if key in task_files:
                        raise ValueError(f'同一配置题目结果重复：{file}')
                    task_files[key] = safe_path(file)
    return sorted(configs), task_files, request_files, call_files


def attempts(task):
    """The input-limit tool event is separated from successful scoring events."""
    completed = [e for e in task['workerEvents'] if e['kind'] == 'tool' and e['action'] == 'call']
    if len(completed) != len(task['completed']):
        raise ValueError('工具成功事件与单题结果数量不同')
    result = []
    for event, item in zip(completed, task['completed']):
        call = dict(name=item['tool'], arguments=item['arguments'])
        if (event.get('status') != 'success' or event.get('error') or event['toolCallId'] != item['id']
                or diff_fields(call, event['webReplayCall'])):
            raise ValueError('工具成功事件与已完成调用不一致')
        result.append(dict(id=item['id'], turn=item['turn'], step=item['step'], **call))
    for event in task['inputLimitEvents']:
        if event['kind'] == 'tool' and event['action'] == 'call':
            terminal = task['termination']
            result.append(dict(id=event['toolCallId'], turn=terminal['turn'], step=terminal['step'],
                               **event['webReplayCall']))
    return result


def event_limit(event, kind, details):
    marker = 'BFCL_INPUT_LIMIT:'
    text = event.get('error', '')
    return (event.get('kind') == kind and event.get('status') == 'failed' and marker in text and
            not diff_fields(details, parse_json(text.split(marker, 1)[1])))


def boundary(task, reference, requests, calls, context_limit, request_limit):
    """Return the exact prefix lengths. An unproven input-limit reason always fails."""
    sent = sorted(requests)
    old_positions = [(r['turn'], r['step']) for r in reference['requests']]
    tools = reference['tools']
    end = task.get('termination')
    events = task['inputLimitEvents']
    if task['executionOutcome'] != 'input_limit':
        if events:
            raise ValueError('非输入超限终态包含输入超限事件')
        return len(old_positions), len(tools), None
    if task['status'] != 'terminated' or not isinstance(end, dict) or end.get('reason') != 'input_limit':
        raise ValueError('输入超限终态标记不完整')
    if len(events) != 1:
        raise ValueError('必须存在唯一输入超限事件')
    event, = events
    source = end.get('source', MISSING)
    position = (end['turn'], end['step'])
    first_big_tool = next((i for i, tool in enumerate(tools) if tool['bytes'] > context_limit), None)
    first_big_request = next((i for i, req in enumerate(reference['requests']) if req['bytes'] > request_limit), None)
    if source == 'context':
        if first_big_tool is None:
            raise ValueError('旧工具结果中没有超限项')
        tool = tools[first_big_tool]
        expected = (tool['turn'], tool['step'])
        n = old_positions.index(expected) + 1
        detail = dict(inputBytes=tool['bytes'], maxRequestBytes=context_limit)
        if (position != expected or end.get('toolCallId') != tool['id'] or len(task['completed']) != first_big_tool
                or event.get('toolCallId') != tool['id'] or event.get('action') != 'call'
                or not event_limit(event, 'tool', detail)):
            raise ValueError('context结束点不在第一个超限工具结果')
        m = first_big_tool + 1
    elif source is MISSING:  # The existing local request-size termination carries no source field.
        if first_big_request is None:
            raise ValueError('按新拼法重建的旧请求均未超限')
        n = first_big_request
        expected = old_positions[n]
        detail = dict(inputBytes=reference['requests'][n]['bytes'], maxRequestBytes=request_limit)
        m = sum((tool['turn'], tool['step']) < expected for tool in tools)
        if (position != expected or first_big_tool is not None and first_big_tool < m
                or not event_limit(event, 'infer', detail) or event.get('action') != 'sample'):
            raise ValueError('请求体结束点不在第一个本地超限请求')
    else:
        raise ValueError('不接受的输入超限source')
    if (diff_fields(detail['inputBytes'], end.get('inputBytes')) or
            diff_fields(detail['maxRequestBytes'], end.get('maxRequestBytes'))):
        raise ValueError('终态 inputBytes 或上限与运行时计量不一致')
    if sent != old_positions[:n] or len(attempts(task)) != m:
        raise ValueError('新请求或工具调用没有到达规定结束点')
    if any(r['bytes'] > request_limit for r in reference['requests'][:n]):
        raise ValueError('结束点前有超限的请求体')
    if source is MISSING:
        rejected = calls.get(position)
        if (not rejected or rejected.get('ok') is not False or rejected['error'].get('kind') != 'input_limit'
                or diff_fields(detail, rejected['error']['details'])):
            raise ValueError('缺少同一位置的本地出口拒绝记录')
    return n, m, dict(source='local_request_body' if source is MISSING else source, turn=position[0],
                      step=position[1], **detail, oldExtraRequests=len(old_positions)-n,
                      oldExtraToolCalls=len(tools)-m, oldModelEnd=reference['oldEnd'])


def request_differences(old, new, allowed_positions, rules):
    diffs = []
    for pos in sorted(set(allowed_positions) | new.keys()):
        turn, step = pos
        if pos not in allowed_positions or pos not in new:
            diffs.append(dict(path='$.position', turn=turn, step=step, error='请求位置缺失或多出'))
            continue
        a, b = old[pos], new[pos]
        deltas = web_request_differences(a['requestBody'], b['requestBody'], rules)
        deltas += diff_fields(a['source'], b.get('source', MISSING), '$.source')
        if b.get('differences') != []:
            deltas.append(dict(path='$.differences', error='出口报告请求差异或缺少差异记录'))
        diffs.extend(dict(d, turn=turn, step=step) for d in deltas)
    return diffs


def observed_calls(files, configs, cases):
    result = {}
    for file in files:
        for row in rows(file):
            cid, case = row.get('configId'), row.get('caseId')
            if cid not in configs or case not in cases:
                continue
            key = (row['turn'], row['step'])
            group = result.setdefault((cid, case), {})
            if key in group:
                raise ValueError(f'模型出口位置重复：{cid}/{case}/{key}')
            group[key] = row
    return result


def cross_terminations(tasks, configs, cases):
    diffs = []
    for case in cases:
        for ca, cb in itertools.combinations(configs, 2):
            a, b = tasks.get((ca, case)), tasks.get((cb, case))
            if a is not None and b is not None:
                for key in ('status', 'executionOutcome', 'termination'):
                    diffs.extend(located(diff_fields(a.get(key, MISSING), b.get(key, MISSING), '$.' + key),
                                         cb, case, oldConfigId=ca, origin='cross-deployment'))
    return diffs


def run_web_comparison(args, selection):
    if args.legacy_new:
        raise ValueError('Web 比对只接收新的运行记录')
    cases = web_cases(selection)
    if not args.new_run:
        raise ValueError('至少指定一个运行根')
    roots = [safe_path(root) for root in args.new_run]
    old_root, index = safe_path(args.old_run), safe_path(args.index)
    source, tools = index.parent, safe_path(ROOT / 'data/replay/tools')
    output = prepare_output(args.output, [*roots, old_root, index, Path(args.cases), tools, source])
    requested = set('replay' if g == 'world' else g for g in (args.gates or GATES))
    try:
        return compare_web_runs(args, cases, roots, old_root, index, source, tools, output, requested)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        summary = dict(status='不通过', gates={g: '不通过' for g in GATES if g in requested},
                       error=str(exc), replayChecks=None, designDifferences=[], output=str(output))
        write_json(output / 'summary.json', summary)
        return summary


def compare_web_runs(args, cases, roots, old_root, index, source, tools, output, requested):
    reports = {g: {'status': '通过', 'differences': []} for g in GATES if g in requested}
    settings = read_json(ROOT / 'config/egress.offline.json')['settings']
    configs, files, request_files, call_files = run_files(roots, cases, settings)
    old = load_old_requests(source, index, cases)
    scores = load_old_scores(old_root, cases)
    measure = measure_reference(source, index, tools, cases, settings, output)
    old_observations = {case: [c['observation'] for c in read_json(tools / (case + '.json'))['calls']]
                        for case in cases}
    rules = read_json(WHITELIST)
    all_requests, request_errors, _ = load_requests(request_files, configs, cases)
    calls = observed_calls(call_files, configs, cases)
    tasks, boundaries, design_differences = {}, {}, []
    grouped_requests = {cid: {case: {} for case in cases} for cid in configs}
    for cid, records in all_requests.items():
        for (case, turn, step), row in records.items():
            grouped_requests[cid][case][(turn, step)] = row
    for cid, case in itertools.product(configs, cases):
        key = (cid, case)
        try:
            task = read_json(files[cid, case, 'tasks'])
            if task['caseId'] != case or task['configId'] != cid:
                raise ValueError('单题结果题号或配置不符')
            new = grouped_requests[cid][case]
            seen = calls.get(key, {})
            if any(row['taskId'] != task['taskId'] for row in [*seen.values(), *new.values()]):
                raise ValueError('出口记录与单题任务身份不一致')
            if set(new) != {pos for pos, row in seen.items() if row.get('ok') is True}:
                raise ValueError('实际发出的请求与成功出口记录不一致')
            tasks[key] = task
            ref = measure['byCase'][case]
            n, m, design = boundary(task, ref, new, seen, measure['contextLimit'], measure['requestLimit'])
            allowed = {(r['turn'], r['step']) for r in ref['requests'][:n]}
            expected_seen = set(allowed)
            if design and design['source'] == 'local_request_body':
                expected_seen.add((design['turn'], design['step']))
            if set(seen) != expected_seen:
                raise ValueError('出口请求位置与预期边界不一致')
            boundaries[key] = (allowed, m)
            if design:
                design_differences.append(dict(classification='设计内差异', configId=cid, caseId=case, **design,
                    oldStatus=scores[case]['oldStatus'], oldTerminationReason=scores[case]['oldTerminationReason']))
        except (OSError, ValueError, KeyError, TypeError) as exc:
            failure = files.get((cid, case, 'failures'))
            error = str(exc)
            if failure:
                error += '；' + read_json(failure).get('error', '')
            for gate in ('request', 'tools'):
                if gate in reports:
                    reports[gate]['differences'].append(problem(cid, case, error, '$.termination'))

    failed = False
    replay_counts = None
    for gate, filename in zip(GATES, REPORTS):
        if gate not in reports:
            continue
        report = reports[gate]
        diffs = report['differences']
        if failed:
            diffs.append(problem(None, None, '前一关不通过；按串行规则未运行本关'))
        elif gate == 'request':
            diffs.extend(request_errors)
            diffs.extend(cross_requests(all_requests, cases))
            for (cid, case), (allowed, _) in boundaries.items():
                diffs.extend(dict(d, configId=cid, caseId=case) for d in request_differences(
                    old[case], grouped_requests[cid][case], allowed, rules))
            diffs.extend(cross_terminations(tasks, configs, cases))
            report['positions'] = {cid: len(all_requests[cid]) for cid in configs}
        elif gate in ('tools', 'replay'):
            counts = {cid: dict(checks=0, mismatches=0) for cid in configs}
            for cid, case in itertools.product(configs, cases):
                key = (cid, case)
                try:
                    got = attempts(tasks[key])
                    _, count = boundaries[key]
                    expected = [{k: v for k, v in tool.items() if k != 'bytes'}
                                for tool in measure['byCase'][case]['tools'][:count]]
                    if len(got) != len(expected):
                        diffs.append(problem(cid, case, '工具调用次数不同', '$.tools'))
                    for i, call in enumerate(got):
                        delta = diff_fields(expected[i] if i < len(expected) else MISSING, call, f'$.tools[{i}]')
                        done = tasks[key]['completed']
                        if gate == 'replay' and i < len(done):
                            actual = done[i]['result']['observation']
                            if i >= len(old_observations[case]) or actual != old_observations[case][i]:
                                delta.append({'path': f'$.tools[{i}].observation', 'error': '回放观察字符串不一致'})
                        counts[cid]['checks'] += 1
                        counts[cid]['mismatches'] += bool(delta)
                        diffs.extend(located(delta, cid, case, call['turn'], call['step']))
                except (ValueError, KeyError, TypeError) as exc:
                    failure = files.get((cid, case, 'failures'))
                    error = read_json(failure).get('error', '') if failure else ''
                    if '回放错误：' in error:
                        counts[cid]['checks'] += 1
                        counts[cid]['mismatches'] += 1
                    diffs.append(problem(cid, case, '缺少完整回放证据：' + str(exc) + ' ' + error, '$.tools'))
            if gate == 'replay':
                replay_counts = dict(checks=sum(c['checks'] for c in counts.values()),
                    mismatches=sum(c['mismatches'] for c in counts.values()), byConfig=counts)
                report['replayChecks'] = replay_counts
        else:
            for cid, case in itertools.product(configs, cases):
                try:
                    task_path = files[cid, case, 'tasks']
                    score_dir = output / 'scores' / cid
                    score_dir.mkdir(parents=True, exist_ok=True)
                    got = score_task(task_path, score_dir / (case + '.json'), args.score_timeout)
                    if got['caseId'] != case:
                        raise ValueError('新评分题号不符')
                    for field in ('valid', 'officialScoring', 'official_result'):
                        diffs.extend(located(diff_fields(scores[case][field], got[field], '$.' + field), cid, case))
                except (OSError, ValueError, KeyError, TypeError) as exc:
                    diffs.append(problem(cid, case, str(exc), '$.score'))
        if diffs:
            report['status'] = '不通过'
            failed = True
        write_json(output / 'comparison' / filename, report)
    summary = dict(status='不通过' if failed else '通过', gates={g: r['status'] for g, r in reports.items()},
                   differenceCounts={g: len(r['differences']) for g, r in reports.items()}, caseCount=len(cases),
                   configs=configs, replayChecks=replay_counts, designDifferences=design_differences, output=str(output))
    write_json(output / 'summary.json', summary)
    return summary
