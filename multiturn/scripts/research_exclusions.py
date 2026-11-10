"""研究汇总可排除获准重跑的旧请求；原账费用、未知保护和请求上限始终不改。"""
from datetime import datetime
import json
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def authorized_time(value):
    require(isinstance(value, str) and bool(value), '研究排除缺少授权时间')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('研究排除授权时间无效') from error
    require(parsed.tzinfo is not None, '研究排除授权时间须包含时区')


def load_sidecars(root, reservations, retained, pending):
    """先校验整轮ID和原始归属，再让调用方按leaf缩小范围；不按题号或时间猜测排除。"""
    root = Path(root).resolve()
    excluded, entries, confirmations = set(), [], []
    path = root / 'research-exclusions.json'
    if path.exists():
        document = json.loads(path.read_text(encoding='utf-8-sig'))
        require(isinstance(document, dict) and document.get('version') == 1
                and isinstance(document.get('entries'), list), '研究排除清单格式无效')
        identifiers = set()
        for entry in document['entries']:
            require(isinstance(entry, dict) and isinstance(entry.get('id'), str) and bool(entry['id'])
                    and entry['id'] not in identifiers, '研究排除条目ID为空或重复')
            identifiers.add(entry['id'])
            require(entry.get('authorizedBy') == 'user' and isinstance(entry.get('authorization'), str)
                    and bool(entry['authorization'].strip()) and isinstance(entry.get('reason'), str)
                    and bool(entry['reason'].strip()) and entry.get('unknownFeesRetained') is True,
                    '研究排除缺少明确授权或未知费用保留声明')
            authorized_time(entry.get('authorizedAt'))
            archive = entry.get('archivePath')
            require(isinstance(archive, str) and bool(archive) and not Path(archive).is_absolute()
                    and not Path(archive).drive and (root / archive).resolve().is_relative_to(root)
                    and (root / archive).resolve() != root, '研究排除归档路径无效')
            task, ids = entry.get('taskId'), entry.get('requestIds')
            require(isinstance(task, str) and bool(task) and isinstance(ids, list) and bool(ids)
                    and all(isinstance(key, str) and bool(key) for key in ids)
                    and len(set(ids)) == len(ids) and not excluded.intersection(ids), '研究排除请求ID为空或重复')
            require(all(key in reservations and reservations[key].get('taskId') == task for key in ids),
                    '研究排除请求不存在或不属于授权taskId')
            excluded.update(ids); entries.append(entry)
    path = root / 'billing-confirmations.jsonl'
    if path.exists():
        text = path.read_text(encoding='utf-8-sig')
        require(not text or text.endswith('\n'), '未扣费确认JSONL尾部不完整')
        seen = set()
        for line in text.splitlines():
            if not line.strip():
                continue
            row = json.loads(line); key = row.get('requestId')
            require(isinstance(key, str) and key not in seen and key in reservations, '未扣费确认请求不存在或重复')
            seen.add(key)
            held = retained.get(key)
            require(row.get('kind') == 'confirmed_unbilled' and row.get('confirmedBy') == 'user'
                    and type(row.get('billedAmountCny')) in (int, float) and row['billedAmountCny'] == 0
                    and row.get('tokenUsageKnown') is False and row.get('basis') and row.get('confirmedAtUtc')
                    and row.get('taskId') == reservations[key].get('taskId') and (held or key in pending),
                    '未扣费确认与原失败请求不匹配')
            original_usd = held['heldMicroUsd'] if held else reservations[key]['microUsd']
            original_cny = held.get('heldMicroCny') if held else reservations[key].get('microCny')
            require(row.get('originalHeldMicroUsd') == original_usd and row.get('originalHeldMicroCny') == original_cny,
                    '未扣费确认与原保护金额不一致')
            confirmations.append(row)
    return {'excludedRequestIds': excluded, 'exclusionEntries': entries,
            'confirmedUnbilledRequestIds': {row['requestId'] for row in confirmations},
            'billingConfirmations': confirmations}


def accounting_view(accounts, view='research'):
    """建立只读投影视图；gross始终包含全账，excluded仅展示旧attempt，均不改变原对象。"""
    require(view in ('gross', 'research', 'excluded'), '未知研究费用视图')
    excluded = set(accounts.get('excludedRequestIds', ()))
    ids = set(accounts['reservations'])
    require(all(set(accounts.get(name, {})) <= ids for name in ('settlements', 'pending', 'retained')),
            '费用视图存在缺少预留归属的记录')
    selected = ids if view == 'gross' else ids & excluded if view == 'excluded' else ids - excluded
    result = dict(accounts)
    for name in ('reservations', 'settlements', 'pending', 'retained'):
        result[name] = {key: value for key, value in accounts.get(name, {}).items() if key in selected}
    result['uncertain'] = sorted(set(accounts.get('uncertain', ())) & selected)
    result['confirmedUnbilledRequestIds'] = set(accounts.get('confirmedUnbilledRequestIds', ())) & selected
    result['spentMicroUsd'] = sum(event['microUsd'] for event in result['settlements'].values())
    result['retainedMicroUsd'] = sum(event['heldMicroUsd'] for event in result['retained'].values())
    if 'spentMicroCny' in accounts:
        result['spentMicroCny'] = sum(event['microCny'] for event in result['settlements'].values())
        result['reservedMicroCny'] = sum(result['reservations'][key]['microCny'] for key in result['pending'])
        result['retainedMicroCny'] = sum(event['heldMicroCny'] for event in result['retained'].values())
    return result


def accounting_summary(accounts):
    """费用已知程度和执行器原保护单列；确认免费不补造token，也不冒称预算已释放。"""
    confirmed = set(accounts.get('confirmedUnbilledRequestIds', ()))
    pending, retained = accounts['pending'], accounts['retained']
    unknown = (set(pending) | set(retained) | set(accounts.get('uncertain', ()))) - confirmed
    return {'physicalRequests': len(accounts['reservations']), 'settledRequests': len(accounts['settlements']),
            'pendingRequests': len(set(pending) - confirmed), 'unknownFailedRequests': len(set(retained) - confirmed),
            'unknownRequests': len(unknown), 'confirmedUnbilledRequests': len(confirmed),
            'referenceUsd': accounts['spentMicroUsd'] / 1e6,
            'protectionCny': accounts['spentMicroCny'] / 1e6 if 'spentMicroCny' in accounts else None,
            'runtimePendingRequests': len(pending), 'runtimeRetainedRequests': len(retained),
            'runtimeHeldReferenceUsd': (sum(pending.values()) + sum(e['heldMicroUsd'] for e in retained.values())) / 1e6,
            'runtimeHeldPeakCny': (sum(accounts['reservations'][key].get('microCny', 0) for key in pending)
                                  + sum(e.get('heldMicroCny', 0) for e in retained.values())) / 1e6}
