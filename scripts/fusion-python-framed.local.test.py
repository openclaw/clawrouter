import importlib.util
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('framed', Path(__file__).with_name('fusion-python-framed.local.py'))
framed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(framed)
frame = framed.frame


class FrameTests(unittest.TestCase):
    def test_large_round_trip_and_frame_boundary(self):
        value = {'args': [[i for i in range(100000)]]}
        encoded = frame.encode_frame(value)
        self.assertGreater(len(encoded), 131072)
        with tempfile.TemporaryFile() as file:
            file.write(encoded + frame.encode_frame({'next': True})); file.seek(0)
            self.assertEqual(frame.read_frame(file.fileno()), value)
            self.assertEqual(frame.read_frame(file.fileno()), {'next': True})

    def test_malformed_truncated_and_oversized_frames(self):
        for data in (b'\0\0', struct.pack('!I', 5) + b'{}', struct.pack('!I', frame.FRAME_LIMIT + 1),
                     struct.pack('!I', 0), struct.pack('!I', 1) + b'!'):
            with self.subTest(data=data), tempfile.TemporaryFile() as file:
                file.write(data); file.seek(0)
                with self.assertRaises((EOFError, ValueError)):
                    frame.read_frame(file.fileno())
        with self.assertRaises(ValueError):
            frame.encode_frame('a' * frame.FRAME_LIMIT)

    def test_stalled_reader_and_writer_deadlines(self):
        read, write = os.pipe()
        try:
            with patch.object(frame, 'DEADLINE_SECONDS', 0.02):
                with self.assertRaises(TimeoutError): frame.read_frame(read)
                with self.assertRaises(TimeoutError): frame.write_frame(write, 'a' * 1000000)
        finally:
            os.close(read); os.close(write)

    def test_unsupported_shapes_fail_before_docker(self):
        with patch.object(framed.subprocess, 'Popen') as process:
            for cases in ([], [{'args': (), 'expected': None}], [{'args': ({'x': 1},), 'expected': 1}],
                          [{'args': ([0] * 500001,), 'expected': 1}],
                          [{'args': ('a' * frame.FRAME_LIMIT,), 'expected': 1}]):
                with self.assertRaises(ValueError): framed.grade('def solve(): return 1', cases)
            process.assert_not_called()

    def test_prepared_worker_never_receives_expected(self):
        payload = json.loads(framed.prepare('def solve(x): return x', [{'args': (1,), 'expected': 712391}]))
        self.assertNotIn('expected', framed.WORKER)
        self.assertNotIn('712391', framed.WORKER)
        self.assertIn('cases', payload)
        self.assertEqual(payload['cases'][0]['expected'], 712391)


class DockerSmoke(unittest.TestCase):
    @unittest.skipUnless(os.getenv('FUSION_FRAMED_SMOKE') == '1', 'explicit cached Docker smoke')
    def test_worker_exit_diagnostics_do_not_expose_candidate_text(self):
        for code, expected_stage, exit_code in (
            ('import os\nos._exit(23)', 'startup', 23),
            ('import os\ndef solve(): os._exit(37)', 'case', 37),
        ):
            result = framed.grade(code, [{'args': (), 'expected': 0}])
            self.assertFalse(result['valid'])
            self.assertFalse(result['passed'])
            self.assertEqual(result['failure'], 'EOFError')
            self.assertEqual(result['failureStage'], expected_stage)
            self.assertEqual(result['completedCases'], 0)
            self.assertEqual(result['workerReturnCode'], exit_code)
            self.assertGreaterEqual(result['workerCpuSeconds'], 0)
            self.assertNotIn('os._exit', json.dumps(result))

    @unittest.skipUnless(os.getenv('FUSION_FRAMED_SMOKE') == '1', 'explicit cached Docker smoke')
    def test_isolated_large_input_and_fail_closed(self):
        cases = [{'args': ([1] * 100000,), 'expected': 100000}]
        good = framed.grade('def solve(values): return sum(values)', cases)
        self.assertEqual(good, {'valid': True, 'passed': True, 'tests': 1, 'failures': 0, 'errors': 0, 'skipped': 0})
        wrong = framed.grade('def solve(values): return 0', cases)
        self.assertTrue(wrong['valid']); self.assertFalse(wrong['passed'])
        identity = framed.grade('import os\ndef solve(): return os.getuid()', [{'args': (), 'expected': 65534}])
        self.assertTrue(identity['passed'])
        for code in ('def solve(values):\n while True: pass',
                     'import os\ndef solve(values):\n os.write(1, b"\\xff\\xff\\xff\\xff"); return 0',
                     'import os, json, struct\ndef solve(values):\n'
                     ' data=json.dumps({"nonce":"wrong","value":100000}).encode()\n'
                     ' os.write(1, struct.pack("!I",len(data))+data); return 0'):
            result = framed.grade(code, cases)
            self.assertFalse(result['valid']); self.assertFalse(result['passed'])


if __name__ == '__main__':
    unittest.main()
