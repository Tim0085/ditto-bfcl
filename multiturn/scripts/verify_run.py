"""独立核对全轮覆盖、真实IPC调用、逐题官方评分及合成/真实账本。"""
import argparse
import hashlib
import json
import math
import re
import sys
from functools import lru_cache
from pathlib import Path
from check_runtime import verify_runtime_identity
from research_exclusions import load_sidecars, accounting_view, accounting_summary


def require_verification_enabled():
    """禁止在会移除 assert 的解释器模式下声明验收通过。"""
    # sys.flags 记录启动模式；运行中清除环境变量也不会重新启用 assert。
    if sys.flags.optimize != 0:
        raise RuntimeError('验收拒绝 Python 优化模式；请移除 -O/-OO 并在启动前清除 PYTHONOPTIMIZE。')


require_verification_enabled()

ROOT = Path(__file__).resolve().parents[1]
CATEGORIES = ('multi_turn_base', 'multi_turn_miss_func', 'multi_turn_miss_param', 'multi_turn_long_context')


def valid_case_id(value):
    return bool(isinstance(value, str) and re.fullmatch(r'multi_turn_(?:base|miss_func|miss_param|long_context)_(?:0|[1-9]\d{0,2})', value)
                and int(value.rsplit('_', 1)[1]) < 200)


def category_file(category, kind):
    require(category in CATEGORIES, 'multi-turn 类别无效')
    return ROOT / 'data' / (f'{kind}.jsonl' if category == 'multi_turn_base' and kind != 'fixtures'
                            else 'fixtures.json' if category == 'multi_turn_base'
                            else f'{category}.{kind}.json' + ('l' if kind != 'fixtures' else ''))


def configured_ids(config):
    categories = config.get('categories', ['multi_turn_base'])
    require(isinstance(categories, list) and bool(categories) and len(set(categories)) == len(categories)
            and all(category in CATEGORIES for category in categories), 'multi-turn 类别配置无效')
    return [task['id'] for category in categories for task in jsonl(category_file(category, 'tasks'))]


def ledger_folder(folder, meta):
    """旧运行读本地账本；组合实验由叶节点指向同一个根账本。"""
    folder = Path(folder).resolve()
    fields = ('ledgerRelativePath', 'ledgerConfigHash', 'taskIdPrefix')
    if not any(key in meta for key in fields):
        return folder
    require(all(isinstance(meta.get(key), str) and meta[key] for key in fields), '共享账本元数据不完整')
    relative = Path(meta['ledgerRelativePath'])
    require(not relative.is_absolute() and not relative.drive, '共享账本必须使用相对路径')
    root = (folder / relative).resolve()
    require(root != folder and folder.is_relative_to(root), '共享账本根目录必须是当前运行的父目录')
    campaign = read(root / 'campaign.json')
    require(campaign.get('configHash') == meta['ledgerConfigHash']
            and campaign.get('config', {}).get('mode') == meta['config']['mode']
            and campaign['config'].get('settings') == meta['config']['settings'], '共享账本与整轮实验配置不一致')
    require(meta['taskIdPrefix'] == folder.relative_to(root).as_posix() + '/', '共享账本任务前缀与目录不一致')
    return root


def run_identifier(folder, meta):
    return meta.get('taskIdPrefix', '').rstrip('/') or Path(folder).name


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def jsonl(path):
    content = path.read_text(encoding='utf-8')
    if content and not content.endswith('\n'):
        raise ValueError('JSONL 尾部不完整：' + path.name)
    return [json.loads(line) for line in content.splitlines()]


def verify_journal(batch, ids, rows):
    started, completed = set(), set()
    row_map = {row['caseId']: row for row in rows}
    assert set(row_map) == set(ids) and len(rows) == len(ids)
    for event in jsonl(batch / 'journal.jsonl'):
        case = event['caseId']
        assert case in row_map
        if event['kind'] == 'started':
            assert case not in started and event['taskId'] == row_map[case]['taskId']
            started.add(case)
        elif event['kind'] == 'completed':
            assert case in started and case not in completed
            assert event['sha256'] == row_map[case]['sha256'] and event['summary'] == row_map[case]
            completed.add(case)
        else:
            raise ValueError('journal事件类型无效')
    assert started == completed == set(ids), 'journal缺少任务开始或完成记录'


def verify_selection(selection, config, service):
    assert selection['source'] == config['mode'] + '-profile'
    assert selection['cases'] == config['profileCases'] and selection['frozen'] is True
    assert set(selection['serviceMs']) == set(service)
    for kind, measured in service.items():
        recorded = selection['serviceMs'][kind]
        assert type(recorded) in (int, float) and math.isfinite(recorded) and recorded >= 0
        assert math.isclose(recorded, measured, rel_tol=1e-9, abs_tol=1e-9), '剖析服务时间与实际轨迹不一致'
    total = sum(service.values())
    infer = max(1, min(3, math.floor(4 * service['infer'] / total + .5))) if total else 2
    assert selection['inferWorkers'] == infer and selection['toolWorkers'] == 4 - infer


def verify_report(report, config, groups, profile_tasks, selection):
    assert report['status'] == 'completed' and report['source'] == config['mode']
    assert report['profileTasks'] == profile_tasks
    assert report['evaluationTasks'] == sum(group['taskCount'] for group in groups)
    assert report['groups'] == groups, '整轮报告与逐批官方评分不一致'
    assert report['selection'] == selection, '整轮报告与冻结分配不一致'
    assert report.get('backend', 'ditto') == config.get('backend', 'ditto'), '整轮报告后端不一致'
    expected_calls = 0 if config['mode'] == 'offline-reference' else None
    assert report['realModelCalls'] == expected_calls and report['actualApiCostUsd'] == expected_calls


def reference_counts(fixture, ids):
    assert fixture['source'] == 'offline-reference'
    cases = {case['id']: case for case in fixture['cases']}
    tools = sum(len(turn) for case_id in ids for turn in cases[case_id]['turns'])
    requests = tools + sum(len(cases[case_id]['turns']) for case_id in ids)
    return len(ids), tools, requests


def require(condition, message):
    if not condition:
        raise ValueError(message)


def nonnegative(value, label):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0, label + '无效')
    return value


LIMIT_OUTCOMES = ('output_limit', 'request_limit', 'input_limit', 'model_output')
MODEL_OUTPUT_CODES = {'refusal', 'content_filter', 'invalid_arguments_json', 'arguments_not_object'}


def outcome_counts_match(recorded, expected):
    """旧汇总没有新增零值类别时仍可只读复用。"""
    names = {'completed', *LIMIT_OUTCOMES}
    return (isinstance(recorded, dict) and set(recorded) <= names
            and all(type(value) is int and value >= 0 for value in recorded.values())
            and all(recorded.get(name, 0) == expected.get(name, 0) for name in names))


@lru_cache(maxsize=1)
def task_turn_counts():
    return {task['id']: len(task['question']) for category in CATEGORIES
            if category_file(category, 'tasks').exists() for task in jsonl(category_file(category, 'tasks'))}


def validate_termination(task, config=None):
    """模型限额是有证据的单题终态，不能用任意状态跳过官方评分。"""
    outcome = task.get('executionOutcome')
    if task.get('status') != 'terminated':
        require(task.get('status') == 'completed' and outcome in (None, 'completed'), '任务身份或状态异常')
        return None
    terminal = task.get('termination', {})
    require(outcome in LIMIT_OUTCOMES and terminal.get('reason') == outcome, '限额终态原因不一致')
    total_turns = task_turn_counts().get(task.get('caseId'))
    require(total_turns is not None, '限额终态题号无效')
    steps, calls, completed_turns = task.get('modelSteps', []), [], 0
    turn, number = 1, 1
    sums = dict(inputTokens=0, outputTokens=0, totalTokens=0)
    for index, step in enumerate(steps):
        require((step.get('turn'), step.get('step')) == (turn, number) and turn <= total_turns, '限额终态模型轮次或步骤不连续')
        output = step['output']
        finish = output.get('finishReason')
        require(finish in ('stop', 'action_request', 'length', 'error'), '限额终态含未知模型结束状态')
        actions = output.get('actionRequests', [])
        require(isinstance(actions, list) and bool(actions) == (finish == 'action_request'), '限额终态包含不应执行的工具调用')
        for action in actions:
            calls.append((turn, number, action['id'], action['name'], action['arguments']))
        for key in sums:
            value = output.get('usage', {}).get(key)
            require(type(value) is int and value >= 0, '限额终态模型用量缺失')
            sums[key] += value
        require(output['usage']['totalTokens'] == output['usage']['inputTokens'] + output['usage']['outputTokens'],
                '限额终态模型总用量不一致')
        if finish == 'stop':
            completed_turns += 1
            turn, number = turn + 1, 1
        elif finish == 'action_request':
            number += 1
        elif finish == 'length':
            require(index == len(steps) - 1 and outcome == 'output_limit', '截断之后不能继续记录模型步骤')
        else:
            require(index == len(steps) - 1 and outcome == 'model_output', '模型输出失败之后不能继续记录模型步骤')
    actual = [(call['turn'], call['step'], call['id'], call['tool'], call['arguments']) for call in task.get('completed', [])]
    require(actual == calls, '限额终态的已执行工具与模型请求不一致')
    require(type(task.get('completedTurns')) is int and task['completedTurns'] == completed_turns < total_turns,
            '限额终态不能冒充全部用户轮次完成')
    require((terminal.get('turn'), terminal.get('step')) == (turn, number), '限额发生位置与轨迹不一致')
    usage = task.get('usage', {})
    require(usage.get('requests') == len(steps) and all(usage.get(key) == value for key, value in sums.items()),
            '限额终态汇总用量与模型步骤不一致')
    if outcome == 'model_output':
        require(bool(steps) and steps[-1]['output'].get('finishReason') == 'error', '模型输出失败缺少已结算错误步骤')
        marker = steps[-1]['output'].get('message', {}).get('metadata', {}).get('bfclTaskFailure', {})
        require(terminal.get('code') in MODEL_OUTPUT_CODES and marker == {'reason': outcome, 'code': terminal['code']},
                '模型输出失败原因码不一致')
        return outcome
    if outcome == 'input_limit':
        size, limit = terminal.get('inputBytes'), terminal.get('maxRequestBytes')
        require(type(size) is int and type(limit) is int and 0 < limit < size <= 9007199254740991,
                '输入限额缺少有效请求字节边界')
        if config is not None:
            require(limit == config['settings']['model'].get('maxRequestBytes', 8 * 1024 * 1024), '输入限额与本轮上限不一致')
        return outcome
    key = 'maxOutputTokens' if outcome == 'output_limit' else 'perTaskRequests'
    limit = terminal.get(key)
    require(type(limit) is int and limit > 0, '限额终态缺少有效上限')
    if config is not None:
        expected = config['settings']['model']['maxOutputTokens'] if outcome == 'output_limit' else config['perTaskRequests']
        require(limit == expected, '限额终态与本轮上限不一致')
    if outcome == 'output_limit':
        require(bool(steps) and steps[-1]['output'].get('finishReason') == 'length', '输出限额缺少截断模型响应')
        metadata = steps[-1]['output'].get('message', {}).get('metadata', {})
        chat = metadata.get('rawFinishReason') == 'length'
        responses = metadata.get('responseStatus') == 'incomplete' and metadata.get('incompleteDetails', {}).get('reason') == 'max_output_tokens'
        require(chat or responses, '输出限额缺少原始结束原因')
    else:
        physical = len(steps) + len(task.get('failedModelAttempts', []))
        require(physical == limit and all(step['output'].get('finishReason') != 'length' for step in steps),
                '请求限额未达到或与输出限额混淆')
        if task.get('failedModelAttempts'):
            require(task.get('physicalModelRequests') == physical, '请求限额缺少实际尝试次数')
    return outcome


def score_counts(results):
    outcomes = {'completed': 0, 'output_limit': 0, 'request_limit': 0}
    for result in results:
        outcome = result.get('executionOutcome', 'completed')
        require(outcome in ('completed', *LIMIT_OUTCOMES), '评分结果含未知执行终态')
        outcomes[outcome] = outcomes.get(outcome, 0) + 1
    return {'officialScoredCount': outcomes['completed'],
            'modelLimitFailures': outcomes['output_limit'] + outcomes['request_limit'] + outcomes.get('input_limit', 0),
            'modelOutputFailures': outcomes.get('model_output', 0), 'outcomeCounts': outcomes}


def read_ledger(folder, meta, allow_pending=False):
    """重放每一笔原始金额；运行参数调整不能改变历史预留和费用。"""
    root = ledger_folder(folder, meta)
    entries = jsonl(root / 'ledger.jsonl')
    require(bool(entries), '账本为空')
    header, *events = entries
    require(header.get('kind') == 'header' and header.get('configHash') == meta.get('ledgerConfigHash', meta['configHash'])
            and header.get('source') == meta['config']['mode'], '账本与运行配置不一致')
    limit, maximum = header.get('referenceLimitMicroUsd'), header.get('maxRequests')
    require(type(limit) is int and limit > 0 and type(maximum) is int and maximum > 0, '账本缺少有效总额度')
    price = meta['config']['settings']['model']['referencePrice']
    for value in price.values():
        nonnegative(value, '参考单价')
    reservations, settlements, pending, retained, uncertain = {}, {}, {}, {}, set()
    spent = 0
    budget = meta['config']['settings'].get('budget', {})
    cny_limit, cny_price = header.get('referenceLimitMicroCny'), header.get('peakCnyPerMillion')
    cny_enabled = cny_limit is not None or cny_price is not None or 'referenceCny' in budget or 'peakCnyPerMillion' in budget
    if cny_enabled:
        require(type(cny_limit) is int and cny_limit > 0 and isinstance(cny_price, dict)
                and set(cny_price) == {'cachedInput', 'uncachedInput', 'output'}
                and cny_price == budget.get('peakCnyPerMillion')
                and type(budget.get('referenceCny')) in (int, float)
                and cny_limit == math.floor(budget['referenceCny'] * 1e6), '人民币账本与预算配置不一致')
        for value in cny_price.values():
            nonnegative(value, '人民币峰价')
        require(cny_price['uncachedInput'] > 0 and cny_price['output'] > 0
                and cny_price['cachedInput'] <= cny_price['uncachedInput'], '人民币峰价无效')
    spent_cny, pending_cny, retained_cny = 0, {}, {}
    for event in events:
        key, kind = event.get('id'), event.get('kind')
        require(isinstance(key, str) and bool(key), '账本请求 ID 无效')
        if kind == 'reserve':
            amount = event.get('microUsd')
            require(key not in reservations and type(amount) is int and amount > 0
                    and isinstance(event.get('taskId'), str) and bool(event['taskId']), '账本预留重复或金额无效')
            if 'reservedInputTokens' in event or 'reservedOutputTokens' in event:
                inp, out = event.get('reservedInputTokens'), event.get('reservedOutputTokens')
                require(type(inp) is int and inp > 0 and type(out) is int and out > 0, '请求预留界限无效')
                require(amount == math.ceil(inp * price['inputPerMillion'] + out * price['outputPerMillion']), '请求预留金额不一致')
            reservations[key] = event
            pending[key] = amount
            if cny_enabled:
                require(type(event.get('reservedInputTokens')) is int and type(event.get('reservedOutputTokens')) is int,
                        '人民币预留缺少 token 上限')
                expected_cny = math.ceil(event['reservedInputTokens'] * cny_price['uncachedInput']
                                         + event['reservedOutputTokens'] * cny_price['output'])
                require(type(event.get('microCny')) is int and event['microCny'] == expected_cny, '人民币预留金额不一致')
                pending_cny[key] = expected_cny
            else:
                require('microCny' not in event, '旧账本不能混入人民币预留')
        elif kind == 'settle':
            require(key in pending and key not in settlements, '账本缺少预留或重复结算')
            usage = event.get('usage', {})
            require(all(type(usage.get(k)) is int and usage[k] >= 0 for k in ['inputTokens', 'outputTokens', 'totalTokens'])
                    and usage['totalTokens'] == usage['inputTokens'] + usage['outputTokens'], '账本模型用量无效')
            for sub, total in [('cachedInputTokens', 'inputTokens'), ('reasoningTokens', 'outputTokens')]:
                if sub in usage:
                    require(type(usage[sub]) is int and 0 <= usage[sub] <= usage[total], '账本模型用量子项无效')
            amount = math.ceil(usage['inputTokens'] * price['inputPerMillion'] + usage['outputTokens'] * price['outputPerMillion'])
            require(type(event.get('microUsd')) is int and event['microUsd'] == amount
                    and type(event.get('overrun')) is bool, '账本结算费用或超限标志不一致')
            reserve = reservations[key]
            if 'reservedInputTokens' in reserve:
                overrun = usage['inputTokens'] > reserve['reservedInputTokens'] or usage['outputTokens'] > reserve['reservedOutputTokens']
                require(event['overrun'] == overrun, '结算超限标志与该笔预留不一致')
            else:
                require(amount <= reserve['microUsd'] or event['overrun'], '历史结算缺少超限标志')
            spent += amount
            settlements[key] = event
            del pending[key]
            if cny_enabled:
                cached = usage.get('cachedInputTokens', 0)
                expected_cny = math.ceil((usage['inputTokens'] - cached) * cny_price['uncachedInput']
                                        + cached * cny_price['cachedInput'] + usage['outputTokens'] * cny_price['output'])
                require(type(event.get('microCny')) is int and event['microCny'] == expected_cny, '人民币结算金额不一致')
                spent_cny += expected_cny
                del pending_cny[key]
            else:
                require('microCny' not in event, '旧账本不能混入人民币结算')
        elif kind == 'uncertain':
            require(key in pending and key not in uncertain, '未知费用请求缺少预留或重复标记')
            uncertain.add(key)
        elif kind == 'retain_failed':
            require(key in pending and key not in retained and event.get('reason') == 'transport_unknown'
                    and type(event.get('heldMicroUsd')) is int and event['heldMicroUsd'] == pending[key],
                    '失败请求保留金额与原预留不一致')
            retained[key] = event
            del pending[key]
            uncertain.discard(key)
            if cny_enabled:
                require(type(event.get('heldMicroCny')) is int and event['heldMicroCny'] == pending_cny[key],
                        '失败请求人民币保留金额不一致')
                retained_cny[key] = pending_cny.pop(key)
            else:
                require('heldMicroCny' not in event, '旧账本不能混入人民币保留金额')
        else:
            raise ValueError('账本存在未知事件')
        require(spent + sum(pending.values()) + sum(item['heldMicroUsd'] for item in retained.values()) <= limit
                and len(reservations) <= maximum, '账本超过原总预算或请求上限')
        require(not cny_enabled or spent_cny + sum(pending_cny.values()) + sum(retained_cny.values()) <= cny_limit,
                '账本超过人民币峰价总预算')
    sidecars = load_sidecars(root, reservations, retained, pending)
    global_spent, global_ids = spent, set(reservations)
    global_spent_cny = spent_cny
    prefix = meta.get('taskIdPrefix', '')
    if prefix:
        ids = {key for key, value in reservations.items() if value['taskId'].startswith(prefix)}
        reservations = {key: value for key, value in reservations.items() if key in ids}
        settlements = {key: value for key, value in settlements.items() if key in ids}
        pending = {key: value for key, value in pending.items() if key in ids}
        retained = {key: value for key, value in retained.items() if key in ids}
        uncertain.intersection_update(ids)
        for key in ('excludedRequestIds', 'confirmedUnbilledRequestIds'):
            sidecars[key].intersection_update(ids)
        sidecars['exclusionEntries'] = [entry for entry in sidecars['exclusionEntries'] if entry['taskId'].startswith(prefix)]
        sidecars['billingConfirmations'] = [entry for entry in sidecars['billingConfirmations'] if entry['requestId'] in ids]
        spent = sum(value['microUsd'] for value in settlements.values())
        if cny_enabled:
            spent_cny = sum(value['microCny'] for value in settlements.values())
            pending_cny = {key: value for key, value in pending_cny.items() if key in ids}
            retained_cny = {key: value for key, value in retained_cny.items() if key in ids}
    historical = sidecars['excludedRequestIds'] | sidecars['confirmedUnbilledRequestIds']
    require(allow_pending or (not (set(pending) - historical) and not (uncertain - historical)), '账本存在未结算或费用未知请求')
    return {'header': header, 'reservations': reservations, 'settlements': settlements,
            'pending': pending, 'retained': retained, 'uncertain': sorted(uncertain), 'spentMicroUsd': spent,
            'retainedMicroUsd': sum(item['heldMicroUsd'] for item in retained.values()),
            'ledgerRoot': root, 'globalSpentMicroUsd': global_spent, 'globalRequestCount': len(global_ids),
            'globalReservationIds': global_ids, **sidecars,
            **({'limitMicroCny': cny_limit, 'spentMicroCny': spent_cny,
                'reservedMicroCny': sum(pending_cny.values()), 'retainedMicroCny': sum(retained_cny.values()),
                'globalSpentMicroCny': global_spent_cny} if cny_enabled else {})}


def compact_task(task):
    """完整检查后只保留汇总字段；完整对话、工具结果与快照仍保存在原任务文件。"""
    fields = ('caseId', 'taskId', 'status', 'backend', 'segmentId', 'sojournSeconds', 'elapsedSeconds',
              'performanceComparable', 'executionOutcome', 'usage', 'termination', 'completedTurns')
    result = {key: task[key] for key in fields if key in task}
    if 'recovery' in task:
        result['recovery'] = bool(task['recovery'])
    result['completed'] = [{'id': call.get('id')} for call in task.get('completed', [])]
    result['modelSteps'] = []
    for step in task['modelSteps']:
        output = step['output']
        metadata = output['message']['metadata']
        result['modelSteps'].append({key: step[key] for key in ('turn', 'step') if key in step} | {
            'output': {key: output[key] for key in ('usage', 'finishReason') if key in output} | {
                'message': {'metadata': {key: metadata[key] for key in ('budgetReceipt', 'modelTiming') if key in metadata}}}})
    event_fields = ('taskId', 'workerId', 'nodePid', 'processId', 'runtimeId', 'backend', 'kind', 'action',
                    'queueMs', 'serviceMs', 'dispatchMs', 'rateWaitMs', 'budgetWaitMs', 'retryApiMs',
                    'retryRateWaitMs', 'physicalAttempts', 'status')
    for field in ('workerEvents', 'requestLimitEvents', 'inputLimitEvents'):
        if field not in task:
            continue
        result[field] = []
        for event in task[field]:
            compact = {key: event[key] for key in event_fields if key in event}
            if 'status' not in compact and 'status' in event.get('result', {}):
                compact['status'] = event['result']['status']
            if 'error' in event:
                compact['error'] = bool(event['error'])
            result[field].append(compact)
    if 'failedModelAttempts' in task:
        result['failedModelAttempts'] = task['failedModelAttempts']
    return result


def validate_batch(batch, meta, accounts, strict=False, compact=False):
    """检查可解释成绩所需的任务、官方结果和费用；原始调试日志仅严格模式检查。"""
    execution, score = read(batch / 'execution.json'), read(batch / 'score.json')
    config = meta['config']
    ids, rows = execution['taskOrder'], execution['rows']
    require(execution.get('status') == 'completed' and execution.get('configHash') == meta['configHash']
            and execution.get('mode') == config['mode'], '批次状态或配置不一致')
    group, concurrency = execution['group'], execution['concurrency']
    require(group in ['monolithic', 'uniform', 'targeted'] and concurrency in [1, 4], '批次条件无效')
    workers = execution.get('workers', [])
    require(len(workers) == config['workerCount'] == 4 and len({w['id'] for w in workers}) == 4, 'Worker 数量或身份不一致')
    infer = 2 if group == 'uniform' else execution.get('targetedInfer')
    require(group != 'targeted' or (type(infer) is int and 1 <= infer <= 3), '定向 Worker 比例无效')
    roles = ['both'] * 4 if group == 'monolithic' else ['infer'] * infer + ['tool'] * (4 - infer)
    require([w['role'] for w in workers] == roles and execution.get('roles', roles) == roles, 'Worker 角色与实验条件不一致')
    backend = config.get('backend', 'ditto')
    require(backend in ('direct', 'ditto'), '执行后端无效')
    require(execution.get('backend', 'ditto') == backend, '批次后端与配置不一致')
    expected_name = 'profile' if batch.name == 'profile' else f"{config.get('condition', config.get('backend', execution['group']))}-c{execution['concurrency']}"
    require(batch.name == expected_name, '批次身份不一致')
    require(bool(ids) and len(set(ids)) == len(ids) and [row['caseId'] for row in rows] == ids
            and execution['taskCount'] == len(ids), '执行任务清单不完整或重复')
    configured = config.get('profileCases') if batch.name == 'profile' else config.get('caseIds')
    if configured == 'all':
        configured = configured_ids(config)
    require(configured is None or configured == ids, '批次题目与冻结配置不一致')
    scores = {item['caseId']: item for item in score['results']}
    require(set(scores) == set(ids) and len(score['results']) == len(ids), '官方评分缺少或重复题目')
    if strict:
        require(score.get('executionSha256') == sha(batch / 'execution.json'), '评分与执行摘要不一致')
        try:
            verify_journal(batch, ids, rows)
        except AssertionError as error:
            raise ValueError('journal 完成记录不一致') from error
    tasks, receipts, warnings = [], set(), []
    excluded = set(accounts.get('excludedRequestIds', ()))
    for row in rows:
        case = row['caseId']
        require(valid_case_id(case) and row['file'] == f'tasks/{case}.json', '任务路径不合法')
        path = batch / row['file']
        require(path.resolve().is_relative_to(batch.resolve()), '任务路径超出批次目录')
        task, result = read(path), scores[case]
        outcome = validate_termination(task, config)
        require(task['caseId'] == case
                and task['taskId'] == row['taskId'] == f"{meta.get('taskIdPrefix', '')}{batch.name}/{case}"
                and task['configHash'] == meta['configHash'] and task.get('backend', 'ditto') == backend, '任务身份、后端或状态不一致')
        for event in task.get('workerEvents', []):
            require(event.get('backend', 'ditto') == backend, '执行事件后端不一致')
            if backend == 'direct':
                require(not event.get('runtimeId') and isinstance(event.get('processId'), str), 'Direct事件不能伪装成Ditto Runtime')
        if 'status' in row:
            require(row['status'] == task['status'], '任务汇总状态不一致')
        if 'executionOutcome' in row:
            require(row['executionOutcome'] == task.get('executionOutcome', 'completed'), '任务汇总终态不一致')
        require(result == read(batch / 'scores' / (case + '.json')) and result.get('caseId') == case
                and result.get('taskId') == task['taskId'] and result.get('backend', 'ditto') == backend, '官方评分来源不一致')
        if outcome is not None:
            require(result.get('officialScoring') is False and result.get('valid') is False
                    and result.get('scoringStatus') == 'not_evaluated_incomplete'
                    and result.get('executionOutcome') == outcome and result.get('termination') == task['termination']
                    and result.get('official_result', 'missing') is None and result.get('irrelevance_result', 'missing') is None,
                    '限额终态不能冒充官方评分')
        else:
            values = [result.get('valid'), (result.get('official_result') or {}).get('valid'), (result.get('irrelevance_result') or {}).get('valid')]
            require(result.get('officialScoring') is True and result.get('executionOutcome', 'completed') == 'completed'
                    and all(type(value) is bool for value in values) and values[0] == (values[1] and values[2]), '官方评分 valid 不一致')
        if strict:
            require(sha(path) == row['sha256'], '任务摘要不一致：' + case)
            require(result.get('inputSha256') == row['sha256'], '官方评分来源不一致')
            if outcome is None:
                require(result.get('checkerSha256') == sha(ROOT / 'vendor/bfcl_eval/eval_checker/multi_turn_eval/multi_turn_checker.py'), '官方评分器摘要不一致')
        task_receipts = set()
        for step in task['modelSteps']:
            output = step['output']
            receipt = output['message']['metadata']['budgetReceipt']
            key = receipt['id']
            reserved, settled = accounts['reservations'].get(key, {}), accounts['settlements'].get(key, {})
            require(key not in receipts and key not in excluded and reserved.get('taskId') == task['taskId'] and key not in accounts['uncertain']
                    and settled.get('usage') == output['usage'] and settled.get('microUsd') == receipt['referenceMicroUsd'], '任务用量与已结算账本不一致')
            require(outcome is None or settled.get('overrun') is False, '预算预留超限不能伪装成单题模型限额')
            receipts.add(key)
            task_receipts.add(key)
        require(len(task_receipts) == task['usage']['requests'], '任务请求数不完整')
        failures = task.get('failedModelAttempts', [])
        require(isinstance(failures, list), '失败请求记录无效')
        for failure in failures:
            key = failure.get('id')
            retained = accounts.get('retained', {}).get(key, {})
            require(isinstance(key, str) and key not in receipts and key not in excluded
                    and retained.get('reason') == failure.get('reason') == 'transport_unknown'
                    and type(failure.get('heldReferenceMicroUsd')) is int
                    and retained.get('heldMicroUsd') == failure['heldReferenceMicroUsd']
                    and accounts['reservations'].get(key, {}).get('taskId') == task['taskId'],
                    '任务失败请求与原保留账本不一致')
            receipts.add(key)
            task_receipts.add(key)
        require((not failures or task.get('physicalModelRequests') == len(task_receipts))
                and (task.get('physicalModelRequests') is None or task['physicalModelRequests'] == len(task_receipts))
                and task_receipts == {key for key, item in accounts['reservations'].items() if item['taskId'] == task['taskId'] and key not in excluded},
                '任务请求数不完整')
        require(row['usage'] == task['usage'], '逐题用量汇总不一致')
        for warning in task.get('recordingWarnings', []):
            warnings.append(case + ': ' + str(warning))
        for event in task.get('workerEvents', []):
            if event.get('kind') == 'tool' and event.get('action') == 'snapshot':
                if event.get('error') or event.get('status', event.get('result', {}).get('status')) != 'success':
                    warnings.append(case + ': 最终诊断快照未成功采集；任务执行与官方评分保留')
        if strict:
            require(row.get('sojournSeconds') == task.get('sojournSeconds'), '逐题时间汇总不一致')
            events = task['workerEvents']
            for event in events:
                if event.get('kind') == 'tool' and event.get('action') == 'snapshot':
                    continue  # 辅助诊断失败不能把已经完成的答题和评分改成失败。
                require(event['taskId'] == task['taskId'] and not event.get('error')
                        and event.get('status', event.get('result', {}).get('status')) == 'success', 'Worker 执行记录异常')
            inferences = [e for e in events if e.get('kind') == 'infer']
            calls = [e for e in events if e.get('kind') == 'tool' and e.get('action') == 'call']
            require(len(inferences) == len(task['modelSteps']) and len(calls) == len(task.get('completed', [])), 'Worker 步骤数量不一致')
            for event, step in zip(inferences, task['modelSteps']):
                if 'result' in event:
                    require(event['result']['output'] == step['output'], '推理返回与步骤记录不一致')
                else:
                    require(event.get('actionRequestIds') == [c['id'] for c in step['output'].get('actionRequests', [])], '推理调用 ID 不一致')
            for event, done in zip(calls, task.get('completed', [])):
                if 'input' in event and 'result' in event:
                    req = event['input']['call']['arguments']['request']
                    require((req['tool_name'], req['arguments'], event['result']['structuredContent']['data']) == (done['tool'], done['arguments'], done['result']), '工具轨迹不一致')
                else:
                    require(event.get('toolCallId') == done['id'], '工具调用 ID 不一致')
        tasks.append(compact_task(task) if compact else task)
    passed = sum(item['valid'] for item in scores.values())
    counts = score_counts(list(scores.values()))
    require(score.get('officialScoring') is (counts['officialScoredCount'] == len(ids)), '批次官方评分覆盖数不一致')
    for key, value in counts.items():
        absent_legacy = key not in score and ((key == 'modelOutputFailures' and value == 0)
                                            or (not counts['modelLimitFailures'] and not counts['modelOutputFailures']))
        matching = outcome_counts_match(score.get(key), value) if key == 'outcomeCounts' else score.get(key) == value
        require(absent_legacy or matching, '批次终态计数不一致')
        if key in execution:
            matching = outcome_counts_match(execution[key], value) if key == 'outcomeCounts' else execution[key] == value
            require(matching, '执行汇总与终态计数不一致')
    require(score['taskCount'] == len(ids) and score['passed'] == passed and score['allPassed'] == (passed == len(ids))
            and math.isclose(nonnegative(score['successRate'], '成功率'), passed / len(ids)), '评分统计与逐题结果不一致')
    batch_prefix = f"{meta.get('taskIdPrefix', '')}{batch.name}/"
    affected = {key for key in excluded if accounts['reservations'][key]['taskId'].startswith(batch_prefix)}
    return {'execution': execution, 'score': score, 'tasks': tasks, 'receipts': receipts, 'warnings': warnings,
            **({'excludedRequestIds': affected} if affected else {}), **counts}


def batch_names(config):
    groups, concurrencies = config.get('groups', ['monolithic', 'uniform', 'targeted']), config.get('concurrencies', [1, 4])
    require(bool(groups) and len(set(groups)) == len(groups) and all(g in ['monolithic', 'uniform', 'targeted'] for g in groups)
            and bool(concurrencies) and len(set(concurrencies)) == len(concurrencies) and all(c in [1, 4] for c in concurrencies), '冻结批次条件无效')
    profile_only = config.get('caseIds') == [] and bool(config.get('profileCases'))
    if 'backend' in config:
        require(config['backend'] in ('direct', 'ditto'), '执行后端无效')
        if config['backend'] == 'direct':
            require(groups == ['monolithic'] and not config.get('profileCases'), 'Direct对照布局或剖析配置错误')
        condition = config.get('condition')
        if condition is not None:
            require(condition in ('direct', 'monolithic', 'uniform', 'targeted')
                    and ((condition == 'direct' and config['backend'] == 'direct' and groups == ['monolithic'])
                         or (condition != 'direct' and config['backend'] == 'ditto' and groups == [condition])), '实验条件与后端或 Worker 配置不一致')
            return [] if profile_only else [f'{condition}-c{concurrency}' for concurrency in concurrencies]
        if groups == ['monolithic']:
            return [] if profile_only else [f"{config['backend']}-c{concurrency}" for concurrency in concurrencies]
    return [] if profile_only else [f'{group}-c{concurrency}' for concurrency in concurrencies for group in groups]


def verify(folder, strict=False):
    folder = Path(folder)
    meta = read(folder / 'run.json')
    config = meta['config']
    accounts = read_ledger(folder, meta)
    warnings, summaries, incomplete, all_receipts, groups = [], [], [], set(), []
    requests = tools = total_tasks = official_scored = limit_failures = model_output_failures = 0
    profile_service = {'infer': 0.0, 'tool': 0.0}
    selection = read(folder / 'selection.json') if (folder / 'selection.json').exists() else None
    if strict:
        require(config == read(folder / 'config.json'), '初始配置不一致')
        for name, digest in meta.get('sourceFiles', meta.get('experimentFiles', {})).items():
            target = (ROOT / name).resolve()
            require(target.is_relative_to(ROOT.resolve()) and sha(target) == digest, '运行源码摘要不一致：' + name)
        if 'runtime' in config:
            verify_runtime_identity(config, read(folder / 'runtime-identity.json'))
    names = (['profile'] if config.get('profileCases') else []) + batch_names(config)
    for name in names:
        batch = folder / name
        if not (batch / 'execution.json').exists() or not (batch / 'score.json').exists():
            incomplete.append(name)
            continue
        if read(batch / 'execution.json').get('status') != 'completed':
            incomplete.append(name)
            continue
        checked = validate_batch(batch, meta, accounts, strict, compact=True)
        warnings.extend(checked['warnings'])
        execution, score = checked['execution'], checked['score']
        require(not all_receipts.intersection(checked['receipts']), '不同批次重复使用模型费用记录')
        all_receipts.update(checked['receipts'])
        total_tasks += len(checked['tasks'])
        official_scored += checked['officialScoredCount']
        limit_failures += checked['modelLimitFailures']
        model_output_failures += checked.get('modelOutputFailures', 0)
        requests += len(checked['receipts'])
        tools += sum(len(task.get('completed', [])) for task in checked['tasks'])
        group = execution['group']
        if group == 'targeted':
            infer = execution['targetedInfer']
            require(selection is not None and selection.get('frozen') is True
                    and infer == selection['inferWorkers'] and 4 - infer == selection['toolWorkers'], '定向角色与冻结配置不一致')
        if name == 'profile':
            if selection is not None:
                profile_counts = {'profileModelLimitFailures': checked['modelLimitFailures'],
                                  'profileCompletedTasks': checked['officialScoredCount'],
                                  'profileOutcomeCounts': checked['outcomeCounts']}
                for key, value in profile_counts.items():
                    require((key not in selection and not checked['modelLimitFailures']) or selection.get(key) == value,
                            '剖析终态与冻结分配记录不一致')
            for task in checked['tasks']:
                for event in task.get('workerEvents', []):
                    if event.get('kind') in profile_service and event.get('action') in ['sample', 'call']:
                        profile_service[event['kind']] += nonnegative(event['serviceMs'], '剖析服务时间')
        for segment in execution.get('segments', []):
            resource = segment.get('resources', {})
            if resource.get('available') is not True or any(key not in resource for key in ['cpuSeconds', 'memoryGiBSeconds']):
                warnings.append(name + ': 性能采样不完整，缺失指标记为 NA')
        if not execution.get('segments'):
            warnings.append(name + ': 缺少性能时段，性能指标记为 NA')
        summaries.append({'batch': name, 'tasks': len(checked['tasks']), 'officialPassed': score['passed'],
                          'officialScored': checked['officialScoredCount'], 'modelLimitFailures': checked['modelLimitFailures']})
        if name != 'profile':
            entry = {**({'backend': config['backend']} if 'backend' in config else {}), 'group': group, 'concurrency': execution['concurrency'],
                     **{key: score[key] for key in ['taskCount', 'passed', 'successRate', 'goodput', 'elapsedSeconds']}}
            entry.update({key: score[key] for key in ['officialScoredCount', 'modelLimitFailures', 'outcomeCounts'] if key in score})
            groups.append(entry)
    active = (folder / 'run.lock').exists()
    if active:
        warnings.append('运行锁仍存在：run.lock')
    if (folder / 'stopped.json').exists():
        warnings.append('保留历史停止记录：stopped.json')
    if (folder / 'report.json').exists() and not incomplete:
        verify_report(read(folder / 'report.json'), config, groups, len(config.get('profileCases', [])), selection)
    if strict:
        require(not incomplete and not active, '严格验收要求所有批次完成且无运行锁')
        require(all_receipts == set(accounts['reservations']) - set(accounts.get('excludedRequestIds', ())), '严格验收要求所有费用对应完整任务或获准排除的旧尝试')
        starts = jsonl(accounts['ledgerRoot'] / 'rate.jsonl')
        global_ids = accounts['globalReservationIds']
        require(len(starts) == len(global_ids) and {e['id'] for e in starts} == global_ids, '限流记录与请求不一致')
        policy = config.get('dispatchPolicy', {})
        interval, rpm = policy.get('minIntervalMs', 1000), policy.get('requestsPerMinute', 60)
        for i, event in enumerate(starts):
            require(not i or event['at'] - starts[i - 1]['at'] >= interval, '历史启动间隔不足')
            require(i < rpm or event['at'] - starts[i - rpm]['at'] >= 60000, '历史请求速率超限')
        if config.get('profileCases'):
            verify_selection(selection, config, profile_service)
            verify_report(read(folder / 'report.json'), config, groups, len(config['profileCases']), selection)
        if config['mode'] == 'offline-reference' and not limit_failures and not model_output_failures:
            ids = config['caseIds']
            if ids == 'all':
                ids = configured_ids(config)
            expected = config.get('profileCases', []) + ids * len(batch_names(config))
            cases = [case for category in config.get('categories', ['multi_turn_base'])
                     for case in read(category_file(category, 'fixtures'))['cases']]
            current_retained = set(accounts['retained']) - set(accounts.get('excludedRequestIds', ()))
            require((total_tasks, tools, requests - len(current_retained)) == reference_counts({'source': 'offline-reference', 'cases': cases}, expected), '离线任务或调用总数不一致')
    extra = set(accounts['reservations']) - all_receipts - set(accounts.get('excludedRequestIds', ()))
    if extra:
        warnings.append(f'{len(extra)} 笔请求尚不属于已完成且已评分批次，费用与未知预留仍全部保留')
    unknown_retained = set(accounts['retained']) - set(accounts.get('confirmedUnbilledRequestIds', ()))
    if unknown_retained:
        warnings.append(f"{len(unknown_retained)} 笔失败请求仍保留原预算额度，实际费用未知，未伪造结算")
    if accounts.get('confirmedUnbilledRequestIds'):
        warnings.append('已确认未扣费请求的实际费用为0；token仍未知，原执行保护不改')
    if accounts.get('excludedRequestIds'):
        warnings.append('获准重跑的旧请求只从研究汇总排除；原始花费和未知保护仍保留')
    status = 'partial' if incomplete or active or extra else 'completed'
    case_ids = config.get('caseIds', [])
    return {'verified': True, 'strict': strict, 'status': status, 'source': config['mode'], 'backend': config.get('backend', 'ditto'),
            'evaluationCases': len(configured_ids(config)) if case_ids == 'all' else len(case_ids), 'taskExecutions': total_tasks,
            'officialScoredCount': official_scored, 'modelLimitFailures': limit_failures,
            **({'modelOutputFailures': model_output_failures} if model_output_failures else {}),
            'toolCalls': tools, 'modelRequestsIncludingSimulated': len(accounts['reservations']),
            'realModelCalls': 0 if config['mode'] == 'offline-reference' else len(accounts['reservations']),
            'referenceMicroUsd': accounts['spentMicroUsd'], 'retainedRequests': len(accounts['retained']),
            'retainedReferenceMicroUsd': accounts['retainedMicroUsd'], 'batches': summaries, 'incompleteBatches': incomplete,
            **({'researchAccounting': accounting_summary(accounting_view(accounts)),
                'grossAccounting': accounting_summary(accounts),
                'excludedAccounting': accounting_summary(accounting_view(accounts, 'excluded'))}
               if accounts.get('excludedRequestIds') or accounts.get('confirmedUnbilledRequestIds') else {}),
            'warnings': warnings, 'note': '离线响应不代表模型能力或真实性能' if config['mode'] == 'offline-reference' else '参考费用，实际账单另行核对'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--strict', '--strict-check', action='store_true', help='同时核对源码摘要、完整日志和历史限流记录')
    args = parser.parse_args()
    result = verify(args.folder, strict=args.strict)
    with args.output.open('x', encoding='utf-8') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False))
