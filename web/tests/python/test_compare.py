"""比对器抓错验收；临时文件全部在系统临时目录，真实材料只读。"""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('t6_compare', ROOT / 'scripts/compare.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
CASE = 'multi_turn_base_0'


def world():
    root = {'type': 'Directory', 'attributes': {'name': '/', 'parent': None, 'contents': {
        'a.txt': {'type': 'File', 'attributes': {'name': 'a.txt', 'content': 'before',
                  '_last_modified': {'type': 'datetime', 'value': '2026-01-01'}}}}}}
    return {'caseId': CASE, 'involvedClasses': ['GorillaFileSystem'], 'snapshot': {
        'version': 1, 'kind': 'diagnostic-not-resume', 'caseId': CASE, 'classes': {
            'GorillaFileSystem': {'type': 'GorillaFileSystem', 'attributes': {
                'root': root, '_current_dir': {'ref': 'GorillaFileSystem/attributes/root'}}}}}}


def score():
    return {'caseId': CASE, 'valid': True, 'official_result': {'valid': True},
            'irrelevance_result': {'valid': True}, 'officialScoring': True,
            'scoringStatus': 'evaluated', 'executionOutcome': 'completed'}


class CompareTests(unittest.TestCase):
    def setUp(self):
        self.key = (CASE, 1, 2)
        self.old = {self.key: {'requestBody': {'messages': [{'role': 'user', 'content': 'hello'}],
                                              'temperature': 0}, 'source': {'file': 'x', 'sha256': 'y'}}}
        self.new = copy.deepcopy(self.old)
        self.new[self.key]['differences'] = []

    def test_identical_request(self):
        self.assertEqual(c.compare_requests(self.old, self.new, 'a', [CASE]), [])

    def test_request_change_even_when_egress_says_equal(self):
        self.new[self.key]['requestBody']['messages'][0]['content'] = 'changed'
        d = c.compare_requests(self.old, self.new, 'a', [CASE])[0]
        self.assertEqual((d['configId'], d['caseId'], d['turn'], d['step']), ('a', CASE, 1, 2))
        self.assertEqual((d['path'], d['old'], d['new']), ('$.requestBody.messages[0].content', 'hello', 'changed'))

    def test_egress_report_is_read(self):
        self.new[self.key]['differences'] = [{'path': '$.temperature', 'old': 1, 'new': 0}]
        self.assertEqual(c.compare_requests(self.old, self.new, 'a', [CASE])[0]['origin'], 'egress')

    def test_missing_step(self):
        d = c.compare_requests(self.old, {}, 'a', [CASE])[0]
        self.assertEqual((d['step'], d['newMissing']), (2, True))

    def test_extra_step(self):
        self.new[(CASE, 1, 3)] = self.new[self.key]
        d = c.compare_requests(self.old, self.new, 'a', [CASE])[0]
        self.assertEqual((d['step'], d['oldMissing']), (3, True))

    def test_wrong_source(self):
        self.new[self.key]['source']['sha256'] = 'wrong'
        self.assertEqual(c.compare_requests(self.old, self.new, 'a', [CASE])[0]['path'], '$.source.sha256')

    def test_cross_deployment(self):
        self.new[self.key]['requestBody']['temperature'] = 1
        d = c.cross_requests({'a': self.old, 'b': self.new}, [CASE])[0]
        self.assertEqual((d['oldConfigId'], d['newConfigId'], d['path']), ('a', 'b', '$.requestBody.temperature'))

    def test_cross_missing_position(self):
        self.assertTrue(c.cross_requests({'a': self.old, 'b': {}}, [CASE])[0]['newMissing'])

    def test_json_missing_not_null_and_bool_not_number(self):
        self.assertTrue(c.diff_fields({}, {'x': None})[0]['oldMissing'])
        self.assertTrue(c.diff_fields(True, 1))
        self.assertFalse(c.diff_fields(1, 1.0))

    def test_json_ambiguous_values_rejected(self):
        for text in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(ValueError): c.parse_json(text)

    def tools(self):
        return {'completed': [{'tool': 'cat', 'arguments': {'file': 'a'}, 'turn': 2, 'step': 3},
                              {'tool': 'ls', 'arguments': {}, 'turn': 2, 'step': 3}]}

    def test_identical_tools_same_model_step(self):
        self.assertEqual(c.compare_tools(self.tools(), self.tools(), 'a', CASE), [])

    def test_tool_argument(self):
        b = self.tools(); b['completed'][0]['arguments']['file'] = 'b'
        d = c.compare_tools(self.tools(), b, 'a', CASE)[0]
        self.assertEqual((d['path'], d['turn'], d['step'], d['old'], d['new']),
                         ('$.completed[0].arguments.file', 2, 3, 'a', 'b'))

    def test_tool_order(self):
        b = self.tools(); b['completed'].reverse()
        self.assertTrue(any(d['path'] == '$.completed[0].tool' for d in c.compare_tools(self.tools(), b, 'a', CASE)))

    def test_tool_step_not_tool_ordinal(self):
        b = self.tools(); b['completed'][1]['step'] = 4
        self.assertEqual(c.compare_tools(self.tools(), b, 'a', CASE)[0]['path'], '$.completed[1].step')

    def test_tool_missing(self):
        b = self.tools(); b['completed'].pop()
        self.assertTrue(c.compare_tools(self.tools(), b, 'a', CASE)[0]['newMissing'])

    def test_world_content(self):
        b = world(); b['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents']['a.txt']['attributes']['content'] = 'after'
        ds, _ = c.compare_worlds(world(), b, 'a', CASE)
        self.assertTrue(any(d['path'].endswith('.content') and d['old'] == 'before' and d['new'] == 'after' for d in ds))
        self.assertEqual(ds[0]['environmentClass'], 'GorillaFileSystem')
        self.assertEqual(ds[0]['classification'], '状态真的不同')

    def test_world_ref_export_relocation(self):
        b = world(); attrs = b['snapshot']['classes']['GorillaFileSystem']['attributes']
        root = attrs['root']
        attrs.clear()
        attrs['_current_dir'] = root
        attrs['root'] = {'ref': 'GorillaFileSystem/attributes/_current_dir'}
        ds, exports = c.compare_worlds(world(), b, 'a', CASE)
        self.assertEqual(ds, [])
        self.assertTrue(exports)
        self.assertEqual(exports[0]['classification'], '导出写法不同')

    def test_world_timestamp_is_diagnostic(self):
        b = world(); b['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents']['a.txt']['attributes']['_last_modified']['value'] = 'later'
        ds, exports = c.compare_worlds(world(), b, 'a', CASE)
        self.assertFalse(ds); self.assertTrue(exports)

    def test_world_current_dir_is_state(self):
        b = world(); b['snapshot']['classes']['GorillaFileSystem']['attributes']['_current_dir'] = None
        self.assertTrue(c.compare_worlds(world(), b, 'a', CASE)[0])

    def test_world_unresolved_ref_is_business_data(self):
        b = world(); b['snapshot']['classes']['GorillaFileSystem']['attributes']['_current_dir'] = {'ref': 'bad'}
        result = c.normalize_world(b['snapshot'])
        self.assertEqual(result['GorillaFileSystem']['attributes']['_current_dir'], {'ref': 'bad'})
        self.assertTrue(c.compare_worlds(world(), b, 'a', CASE)[0])

    def test_world_invalid_snapshot_fails_cleanly(self):
        for value in (None, [], False):
            b = world(); b['snapshot'] = value
            with self.assertRaisesRegex(ValueError, 'snapshot必须是对象'):
                c.compare_worlds(world(), b, 'a', CASE)

    def test_world_cycles_and_parent_change(self):
        a = world(); attrs = a['snapshot']['classes']['GorillaFileSystem']['attributes']
        attrs['root']['attributes']['contents']['sub'] = {'type': 'Directory', 'attributes': {
            'name': 'sub', 'contents': {}, 'parent': {'ref': 'GorillaFileSystem/attributes/root'}}}
        b = copy.deepcopy(a)
        self.assertFalse(c.compare_worlds(a, b, 'a', CASE)[0])
        b['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents']['sub']['attributes']['parent'] = None
        self.assertTrue(c.compare_worlds(a, b, 'a', CASE)[0])

    def test_world_set_order_but_list_order_matters(self):
        a = world()
        a['involvedClasses'].append('MessageAPI')
        a['snapshot']['classes']['MessageAPI'] = {'type': 'MessageAPI', 'attributes': {
            'generated_ids': {'type': 'set', 'items': ['a', 'b']}}}
        attrs = a['snapshot']['classes']['MessageAPI']['attributes']
        b = copy.deepcopy(a); b['snapshot']['classes']['MessageAPI']['attributes']['generated_ids']['items'].reverse()
        self.assertFalse(c.compare_worlds(a, b, 'a', CASE)[0])
        attrs['testList'] = ['a', 'b']; b = copy.deepcopy(a)
        b['snapshot']['classes']['MessageAPI']['attributes']['testList'].reverse()
        self.assertTrue(c.compare_worlds(a, b, 'a', CASE)[0])

    def test_world_random_state_and_private_physics(self):
        a = {'version': 1, 'kind': 'diagnostic-not-resume', 'classes': {'VehicleControlAPI': {
            'type': 'VehicleControlAPI', 'attributes': {'_random': {'type': 'random-state', 'value': [1]}, '_slopeAngle': 1}}}}
        b = copy.deepcopy(a); b['classes']['VehicleControlAPI']['attributes']['_random']['value'] = [2]
        self.assertEqual(c.normalize_world(a), c.normalize_world(b))
        b['classes']['VehicleControlAPI']['attributes']['_slopeAngle'] = 2
        self.assertNotEqual(c.normalize_world(a), c.normalize_world(b))

    def test_score_flip(self):
        b = score(); b['official_result']['valid'] = False
        d = c.compare_scores(score(), b, 'a', CASE)[0]
        self.assertEqual((d['path'], d['old'], d['new']), ('$.official_result.valid', True, False))

    def check_filenames(self, names):
        a = world()
        contents = a['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents']
        sample = contents.pop('a.txt')
        for name in names:
            contents[name] = copy.deepcopy(sample)
            contents[name]['attributes']['name'] = name
        self.assertEqual(c.compare_worlds(a, copy.deepcopy(a), 'a', CASE), ([], []))
        for name in names:
            b = copy.deepcopy(a)
            b['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents'][name]['attributes']['content'] = 'after'
            ds, es = c.compare_worlds(a, b, 'a', CASE)
            self.assertTrue(ds)
            self.assertFalse(es)
            self.assertTrue(all(d['path'].endswith('.contents.' + name + '.attributes.content') for d in ds), ds)
            self.assertTrue(all(d['old'] == 'before' and d['new'] == 'after' for d in ds))

    def test_filename_ref(self): self.check_filenames(['ref'])
    def test_filenames_type_attributes(self): self.check_filenames(['type', 'attributes'])
    def test_filenames_type_repr(self): self.check_filenames(['type', 'repr'])
    def test_filenames_type_items(self): self.check_filenames(['type', 'items'])
    def test_filenames_type_value(self): self.check_filenames(['type', 'value'])

    def test_review_three_filename_controls_with_real_tools(self):
        # A/cross_B_manual.py 的输入与工具期望；只导入当前包工具，不导入旧包。
        sys.path.insert(0, str(ROOT / 'vendor'))
        from bfcl_eval.eval_checker.multi_turn_eval.func_source_code.gorilla_file_system import GorillaFileSystem
        for names in (['ref'], ['type', 'attributes'], ['type', 'repr']):
            fs = GorillaFileSystem(); fs._load_scenario({})
            for name in names:
                self.assertTrue(fs._validate_file_or_directory_name(name))
                self.assertIsNone(fs.touch(name))
                self.assertIsNone(fs.echo('A-manual-' + name, file_name=name))
                self.assertEqual(fs.cat(name), {'file_content': 'A-manual-' + name})
            self.check_filenames(names)

    def test_ref_requires_earlier_container(self):
        for target in ('missing', 'GorillaFileSystem/attributes/later',
                       'GorillaFileSystem/attributes/scalar', 'GorillaFileSystem/attributes/data'):
            a = world(); attrs = a['snapshot']['classes']['GorillaFileSystem']['attributes']
            attrs.update(scalar=4, data={'ref': target}, later={})
            normalized = c.normalize_world(a['snapshot'])['GorillaFileSystem']['attributes']
            self.assertEqual(normalized['data'], {'ref': target})

    def test_marker_shape_and_type_required(self):
        for data in ({'type': [], 'items': []}, {'type': 'set', 'items': 3},
                     {'type': 'File', 'attributes': 3}, {'type': 'float', 'value': []},
                     {'type': 'File', 'attributes': {}, 'business': True}):
            a = world(); a['snapshot']['classes']['GorillaFileSystem']['attributes']['data'] = data
            self.assertEqual(c.normalize_world(a['snapshot'])['GorillaFileSystem']['attributes']['data'], data)

    def test_ambiguity_is_local_report_and_identical_class_passes(self):
        for data in ({'type': 'UnknownObject', 'attributes': {}}, {'type': 'object', 'repr': '<opaque>'},
                     {'type': 'File', 'attributes': {'_last_modified': 'business-v1'}}):
            a = world(); a['snapshot']['classes']['GorillaFileSystem']['attributes']['opaque'] = data
            self.assertFalse(c.compare_worlds(a, copy.deepcopy(a), 'a', CASE)[0])
            b = copy.deepcopy(a); b['snapshot']['classes']['GorillaFileSystem']['attributes']['extra'] = 1
            ds, _ = c.compare_worlds(a, b, 'a', CASE)
            self.assertEqual(ds[0]['classification'], '无法判断内部标记')
            self.assertTrue(ds[0]['path'].endswith('.opaque'))
            self.assertIn('无法判断这里是内部标记还是业务数据', ds[0]['error'])

    def test_business_file_shape_does_not_hide_change(self):
        a = world()
        data = {'type': 'File', 'attributes': {'name': 'x', 'content': 'x', '_last_modified': 'business-v1'}}
        a['snapshot']['classes']['GorillaFileSystem']['attributes']['business'] = data
        b = copy.deepcopy(a)
        b['snapshot']['classes']['GorillaFileSystem']['attributes']['business']['attributes']['_last_modified'] = 'business-v2'
        ds, exports = c.compare_worlds(a, b, 'a', CASE)
        self.assertEqual(ds[0]['classification'], '无法判断内部标记')
        self.assertTrue(ds[0]['path'].endswith('.business'))
        self.assertFalse(exports)

    def test_world_mixed_state_and_export_changes(self):
        a = world(); b = copy.deepcopy(a)
        attrs = b['snapshot']['classes']['GorillaFileSystem']['attributes']['root']['attributes']['contents']['a.txt']['attributes']
        attrs['content'] = 'after'
        attrs['_last_modified']['value'] = 'later'
        ds, exports = c.compare_worlds(a, b, 'a', CASE)
        self.assertTrue(ds); self.assertTrue(exports)
        self.assertTrue(all(d['path'].endswith('.content') for d in ds))
        self.assertTrue(all(d['path'].endswith('._last_modified.value') for d in exports))

    def test_world_mixed_state_set_order_and_reference_location(self):
        a = world()
        a['involvedClasses'].append('MessageAPI')
        a['snapshot']['classes']['MessageAPI'] = {'type': 'MessageAPI', 'attributes': {
            'generated_ids': {'type': 'set', 'items': ['a', 'b']}, 'message_count': 1}}
        b = copy.deepcopy(a); attrs = b['snapshot']['classes']['GorillaFileSystem']['attributes']
        root = attrs['root']
        root['attributes']['contents']['a.txt']['attributes']['content'] = 'after'
        attrs.clear()
        attrs.update(_current_dir=root, root={'ref': 'GorillaFileSystem/attributes/_current_dir'})
        msg = b['snapshot']['classes']['MessageAPI']['attributes']
        msg['generated_ids']['items'].reverse(); msg['message_count'] = 2
        ds, exports = c.compare_worlds(a, b, 'a', CASE)
        self.assertTrue(ds)
        self.assertTrue(any('.$representation.' in d['path'] for d in exports))
        self.assertTrue(any('.generated_ids.items[' in d['path'] for d in exports))

    def test_business_set_shape_does_not_hide_list_order(self):
        a = world()
        a['snapshot']['classes']['GorillaFileSystem']['attributes']['business'] = {'type': 'set', 'items': ['a', 'b']}
        b = copy.deepcopy(a)
        b['snapshot']['classes']['GorillaFileSystem']['attributes']['business']['items'].reverse()
        ds, exports = c.compare_worlds(a, b, 'a', CASE)
        self.assertEqual(ds[0]['classification'], '无法判断内部标记')
        self.assertFalse(exports)

    def test_skipped_configs_counts_are_per_config_and_deduplicated_by_file(self):
        with tempfile.TemporaryDirectory(prefix='t6-skip-') as raw:
            p = Path(raw) / 'requests.jsonl'
            rows = [{'configId': x, 'caseId': CASE} for x in ('other-a', 'other-b', 'other-a')]
            p.write_text(''.join(json.dumps(r) + '\n' for r in rows), encoding='utf8')
            _, errors, skipped = c.load_requests([p, p], ['a'], [CASE])
            self.assertFalse(errors)
            self.assertEqual(skipped, {'other-a': 2, 'other-b': 1})

    def test_score_identical(self):
        self.assertFalse(c.compare_scores(score(), score(), 'a', CASE))

    def test_score_missing_is_failure(self):
        b = score(); del b['official_result']
        with self.assertRaises(ValueError): c.compare_scores(score(), b, 'a', CASE)

    def test_real_scorer_error_is_failure_and_logged(self):
        with tempfile.TemporaryDirectory(prefix='t6-score-') as raw:
            p = Path(raw); c.write_json(p / 'bad.json', {'caseId': CASE})
            with self.assertRaisesRegex(ValueError, '评分器报错'): c.score_task(p / 'bad.json', p / 'score.json')
            log = c.read_json(p / 'score.process.json')
            self.assertNotEqual(log['exitCode'], 0)
            self.assertIn('Traceback', log['stderr'])

    def test_output_existing_or_protected_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix='t6-path-') as raw:
            with self.assertRaises(FileExistsError): c.prepare_output(raw, [])
            with self.assertRaises(ValueError): c.prepare_output(Path(raw) / 'output', [Path(raw)])
        with self.assertRaises(ValueError): c.prepare_output(ROOT / 'runs/offline/replay-index/new', [])

    def test_secret_path_refused_without_read(self):
        with self.assertRaises(ValueError): c.safe_path(ROOT / '.env-test')
        with self.assertRaises(ValueError): c.safe_path(ROOT.parents[1] / 'private/never-open')

    def test_duplicate_requests_fail(self):
        with tempfile.TemporaryDirectory(prefix='t6-jsonl-') as raw:
            p = Path(raw) / 'requests.jsonl'
            row = {'configId': 'a', 'caseId': CASE, 'turn': 1, 'step': 1, 'position': CASE + '/1/1', 'requestBody': {}}
            p.write_text((json.dumps(row) + '\n') * 2, encoding='utf8')
            rows, errors, skipped = c.load_requests([p], ['a'], [CASE])
            self.assertEqual(skipped, {})
            self.assertEqual(len(rows['a']), 1); self.assertIn('重复', errors[0]['error'])
            self.assertEqual((errors[0]['configId'], errors[0]['caseId'], errors[0]['turn'], errors[0]['step']), ('a', CASE, 1, 1))
            self.assertEqual((errors[0]['old'], errors[0]['new'], errors[0]['sourceLine']), ({}, {}, 2))

    def test_cli_each_gate_and_serial_failure(self):
        with tempfile.TemporaryDirectory(prefix='t6-cli-') as raw:
            p = Path(raw); old = p / 'old'; new = p / 'config-a'; new.mkdir()
            task = world(); task['completed'] = []
            op = c.legacy_task(old, 'monolithic', CASE); op.parent.mkdir(parents=True)
            c.write_json(op, task); (new / 'tasks').mkdir(); c.write_json(new / 'tasks' / (CASE + '.json'), task)
            c.write_json(p / 'cases.json', [CASE])
            record = {'caseId': CASE, 'logicalTurn': 1, 'logicalStep': 1,
                      'taskId': f'full/multi_turn_base/monolithic/monolithic-c1/{CASE}', 'requestBody': {'a': 1}}
            (old / 'model-records').mkdir(); filename = '00000000-0000-0000-0000-000000000000.json'
            c.write_json(old / 'model-records' / filename, record)
            source = {'file': filename, 'sha256': hashlib.sha256((old / 'model-records' / filename).read_bytes()).hexdigest()}
            c.write_json(p / 'index.json', {'version': 1, 'records': {CASE + '/1/1': source}})
            row = {'configId': 'config-a', 'caseId': CASE, 'turn': 1, 'step': 1, 'position': CASE + '/1/1',
                   'requestBody': record['requestBody'], 'source': source, 'differences': []}
            extra = dict(row, configId='not-selected')
            (new / 'requests.jsonl').write_text('\n'.join(map(json.dumps, [row, extra, extra])) + '\n', encoding='utf8')
            base = [sys.executable, '-B', '-X', 'utf8', str(ROOT / 'scripts/compare.py'), '--new-run', str(new),
                    '--old-run', str(old), '--index', str(p / 'index.json'), '--cases', str(p / 'cases.json')]
            for gate in c.GATES:
                run = subprocess.run(base + ['--gates', gate, '--output', str(p / gate)], capture_output=True, text=True, encoding='utf8')
                summary = json.loads(run.stdout)
                self.assertEqual(summary['gates'], {gate: '不通过' if gate == 'score' else '通过'})
                self.assertEqual(run.returncode, 1 if gate == 'score' else 0)
                if gate == 'request':
                    self.assertEqual(summary['skippedConfigs'], {'not-selected': 2})
                    self.assertEqual(c.read_json(p / gate / 'comparison/request-diff.json')['skippedConfigs'], {'not-selected': 2})
            row['requestBody'] = {'a': 2}
            (new / 'requests.jsonl').write_text(json.dumps(row) + '\n', encoding='utf8')
            run = subprocess.run(base + ['--output', str(p / 'all')], capture_output=True, text=True, encoding='utf8')
            summary = json.loads(run.stdout)
            self.assertEqual(set(summary['gates'].values()), {'不通过'})
            self.assertEqual(summary['status'], '不通过'); self.assertEqual(run.returncode, 1)
            # CLI也必须报告跨配置差异，而不只是单独函数测试。
            second = p / 'config-b'; second.mkdir()
            row['configId'] = 'config-b'; row['requestBody'] = {'a': 1}
            (second / 'requests.jsonl').write_text(json.dumps(row) + '\n', encoding='utf8')
            run = subprocess.run(base + ['--new-run', str(second), '--gates', 'request', '--output', str(p / 'cross')], capture_output=True, text=True, encoding='utf8')
            self.assertEqual(run.returncode, 1)
            report = c.read_json(p / 'cross/comparison/request-diff.json')
            self.assertTrue(any(d.get('origin') == 'cross-deployment' and d['oldConfigId'] == 'config-a' and d['newConfigId'] == 'config-b' for d in report['differences']))
            task['snapshot'] = None
            (new / 'tasks' / (CASE + '.json')).write_text(json.dumps(task), encoding='utf8')
            run = subprocess.run(base + ['--gates', 'world', '--output', str(p / 'null-world')], capture_output=True, text=True, encoding='utf8')
            self.assertEqual(run.returncode, 1)
            self.assertEqual(c.read_json(p / 'null-world/summary.json')['gates'], {'world': '不通过'})


if __name__ == '__main__':
    unittest.main()
