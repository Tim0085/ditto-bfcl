import copy
import json
import os
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
from compare import cross_requests, read_json
from compare_web import WHITELIST, boundary, cross_terminations, web_request_differences

CASE = 'web_search_no_snippet_38'


class RequestComparison(unittest.TestCase):
    def test_whitelist_exact_and_cross_deployment_strict(self):
        root = Path(os.environ['WEB_C_TEST_ROOT'])
        with (root / 'egress/requests.jsonl').open(encoding='utf-8') as stream:
            row = next(value for value in map(json.loads, stream) if value['caseId'] == CASE)
        old = read_json(ROOT / 'data/replay/models/model-records' / row['source']['file'])['requestBody']
        new = row['requestBody']
        rules = read_json(WHITELIST)
        self.assertEqual(web_request_differences(old, new, rules), [])
        for key, value in [('tool_choice', 'none'), ('parallel_tool_calls', 0), ('temperature', 0)]:
            with self.subTest(key=key):
                self.assertTrue(web_request_differences(old, {**new, key: value}, rules))
        self.assertTrue(web_request_differences({**old, 'tool_choice': 'auto'}, new, rules))
        key = (CASE, row['turn'], row['step'])
        for mutation in [{'tool_choice': 'none'}, {'parallel_tool_calls': True},
                         {'messages': new['messages'][:-1]}, {'tools': new['tools'][:-1]}]:
            with self.subTest(mutation=next(iter(mutation))):
                configs = {
                    name: {key: {'requestBody': new}} for name in ('Direct', 'Monolithic', 'Uniform', 'Targeted')
                }
                self.assertFalse(cross_requests(configs, [CASE]))
                configs['Targeted'][key] = {'requestBody': {**new, **mutation}}
                self.assertEqual(len(cross_requests(configs, [CASE])), 3)


class InputLimitComparison(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(os.environ['WEB_C_TEST_ROOT'])
        cls.task = read_json(root / 'configs/direct-c1/tasks' / (CASE + '.r1.json'))
        data = read_json(Path(os.environ['WEB_C_COMPARE_ROOT']) / 'reference.json')
        cls.reference = data['byCase'][CASE]

    def check(self, task, sent=((1, 1), (1, 2))):
        return boundary(task, self.reference, sent, {}, 1000000, 1887436)

    def test_real_long_observation(self):
        n, m, design = self.check(self.task)
        self.assertEqual((n, m), (2, 4))
        self.assertEqual(design['inputBytes'], 6131086)
        self.assertEqual((design['oldExtraRequests'], design['oldExtraToolCalls']), (1, 1))
        self.assertTrue(design['oldModelEnd']['providerContext'])
        self.assertEqual(design['oldModelEnd']['step'], 3)

    def test_early_late_wrong_byte_count_and_source_fail(self):
        for mutation in [dict(step=1), dict(step=3), dict(inputBytes=6131085), dict(source='provider_context'),
                         dict(source='local_request_body'), dict(toolCallId=self.reference['tools'][2]['id']),
                         dict(toolCallId=self.reference['tools'][4]['id'])]:
            with self.subTest(mutation=mutation):
                task = copy.deepcopy(self.task)
                task['termination'].update(mutation)
                with self.assertRaises(ValueError):
                    self.check(task)
                changes = cross_terminations({('Direct', CASE): self.task, ('Targeted', CASE): task},
                                             ['Direct', 'Targeted'], [CASE])
                self.assertTrue(changes)
        for sent in [((1, 1),), ((1, 1), (1, 2), (1, 3))]:
            with self.assertRaises(ValueError):
                self.check(self.task, sent)

    def test_local_request_rejection_requires_measured_next_request_and_egress_record(self):
        detail = dict(inputBytes=1887437, maxRequestBytes=1887436)
        events = [{'kind': 'infer', 'action': 'sample', 'status': 'failed',
                   'error': 'BFCL_INPUT_LIMIT:' + json.dumps(detail)}]
        task = dict(status='terminated', executionOutcome='input_limit',
                    termination=dict(reason='input_limit', turn=1, step=2, **detail),
                    completed=[], workerEvents=[], inputLimitEvents=events)
        reference = dict(requests=[dict(turn=1, step=1, bytes=500), dict(turn=1, step=2, bytes=1887437)],
                         tools=[], oldEnd=None)
        seen = {(1, 2): dict(ok=False, error=dict(kind='input_limit', details=detail))}
        self.assertEqual(boundary(task, reference, [(1, 1)], seen, 1000000, 1887436)[:2], (1, 0))
        with self.assertRaises(ValueError):
            boundary(task, reference, [(1, 1)], {}, 1000000, 1887436)
        for length in (1887436, 1887438):
            changed = copy.deepcopy(reference)
            changed['requests'][1]['bytes'] = length
            with self.assertRaises(ValueError):
                boundary(task, changed, [(1, 1)], seen, 1000000, 1887436)


if __name__ == '__main__':
    unittest.main(verbosity=2)
