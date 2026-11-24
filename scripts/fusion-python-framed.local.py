"""Separate bounded JSON transport for pure-function LCB cases.

Historical RPC is unchanged. This version admits 2 MiB messages and 8 MiB
trusted fixtures, with the same cached image, UID, CPU, memory and network
limits. Candidate processes see code and actual arguments only, never expected
values or assertion source. No mutation-copyback or arbitrary Python objects.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import uuid

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('fusion_frame', HERE / 'fusion-json-frame.local.py')
frame = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frame)
CODE_LIMIT = 32768
PAYLOAD_LIMIT = 8 * 1024**2
IMAGE = 'sha256:fd95fa221297a88e1cf49c55ec1828edd7c5a428187e67b5d1805692d11588db'
CODEC = (HERE / 'fusion-json-frame.local.py').read_text()

WORKER = CODEC + r'''
import contextlib, resource, sys
resource.setrlimit(resource.RLIMIT_CPU, (5, 5))
resource.setrlimit(resource.RLIMIT_AS, (160 * 1024**2, 160 * 1024**2))
def run():
    receive, send, validate = read_frame, write_frame, literal
    config = receive(0)
    scope = {"__name__": "candidate"}
    # Discard printing without accumulating it in candidate memory.
    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        exec(compile(config["code"], "<candidate>", "exec"), scope)
    function = scope["solve"]
    send(1, {"ready": True})
    while True:
        request = receive(0)
        args = validate(request["args"])
        try:
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                value = validate(function(*args))
            result = {"value": value}
        except BaseException as error:
            result = {"error": type(error).__name__}
        result["nonce"] = request["nonce"]
        send(1, result)
run()
'''

CONTROLLER = CODEC + r'''
import secrets, subprocess, sys
payload = json.load(sys.stdin)
worker = subprocess.Popen([sys.executable, "-I", "-B", "-c", payload.pop("worker")],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    user=65534, group=65534, extra_groups=[], cwd="/tmp",
    env={"PATH": "/usr/local/bin:/usr/bin:/bin"}, bufsize=0)
out = {"valid": False, "passed": False}
try:
    write_frame(worker.stdin.fileno(), {"code": payload["code"]})
    if read_frame(worker.stdout.fileno()) != {"ready": True}:
        raise ValueError("worker_startup")
    failures, errors = 0, 0
    for case in payload["cases"]:
        nonce = secrets.token_hex(16)
        write_frame(worker.stdin.fileno(), {"nonce": nonce, "args": case["args"]})
        answer = read_frame(worker.stdout.fileno())
        if type(answer) is not dict or answer.get("nonce") != nonce:
            raise ValueError("worker_identity")
        if set(answer) == {"nonce", "error"} and type(answer["error"]) is str:
            errors += 1
        elif set(answer) == {"nonce", "value"}:
            value = literal(answer["value"])
            # Preserve the existing unittest equality contract for JSON values.
            failures += int(value != case["expected"])
        else:
            raise ValueError("worker_shape")
    out = {"valid": True, "passed": failures == errors == 0, "tests": len(payload["cases"]),
        "failures": failures, "errors": errors, "skipped": 0}
except BaseException as error:
    out["failure"] = type(error).__name__
finally:
    worker.stdin.close()
    try: worker.wait(timeout=0.5)
    except subprocess.TimeoutExpired: pass
    worker.stdout.close()
print(json.dumps(out))
'''


def prepare(code, cases):
    if type(code) is not str or not 0 < len(json.dumps(code).encode()) <= CODE_LIMIT:
        raise ValueError('code_bound')
    if type(cases) is not list or not 1 <= len(cases) <= 24:
        raise ValueError('case_count')
    normalized = []
    for case in cases:
        if type(case) is not dict or set(case) != {'args', 'expected'}:
            raise ValueError('case_shape')
        if type(case['args']) not in (tuple, list):
            raise ValueError('argument_shape')
        args, expected = frame.literal(list(case['args'])), frame.literal(case['expected'])
        frame.encode_frame({'nonce': '0' * 32, 'args': args})
        frame.encode_frame({'nonce': '0' * 32, 'value': expected})
        normalized.append({'args': args, 'expected': expected})
    payload = json.dumps({'code': code, 'cases': normalized, 'worker': WORKER}).encode()
    if len(payload) > PAYLOAD_LIMIT:
        raise ValueError('payload_bound')
    return payload


def grade(code, cases):
    payload = prepare(code, cases)
    name = 'fusion-python-framed-' + uuid.uuid4().hex
    command = ['docker', 'run', '--pull=never', '--rm', '--name', name, '-i', '--network', 'none', '--read-only',
        '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges',
        '--pids-limit', '32', '--memory', '256m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        IMAGE, 'python', '-I', '-B', '-c', CONTROLLER]
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = process.communicate(payload, timeout=25)
        if process.returncode or len(stdout) > 4096 or len(stderr) > 65536:
            return {'valid': False, 'passed': False, 'failure': 'grader_process'}
        result = json.loads(stdout)
        if type(result) is not dict or type(result.get('valid')) is not bool or type(result.get('passed')) is not bool:
            raise ValueError('grader_shape')
        if result['valid'] and (result.get('tests') != len(cases)
                or any(type(result.get(key)) is not int or result[key] < 0 for key in ('failures', 'errors', 'skipped'))
                or result['skipped'] != 0 or result['failures'] + result['errors'] > len(cases)
                or result['passed'] != (result['failures'] == result['errors'] == 0)):
            raise ValueError('grader_counts')
        return result
    except (ValueError, RecursionError):
        return {'valid': False, 'passed': False, 'failure': 'grader_output'}
    except subprocess.TimeoutExpired:
        return {'valid': False, 'passed': False, 'failure': 'grader_timeout'}
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if process.poll() is None:
            process.kill(); process.wait()


if __name__ == '__main__':
    import sys
    request = json.load(sys.stdin)
    print(json.dumps(grade(request['code'], request['cases'])))
