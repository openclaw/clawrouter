"""Length-framed JSON for the isolated pure-function benchmark, version 1."""
import json
import os
import select
import struct
import time

FRAME_LIMIT = 2 * 1024**2
DEADLINE_SECONDS = 2


def encode_frame(value):
    body = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode()
    if not 0 < len(body) <= FRAME_LIMIT:
        raise ValueError('frame_size')
    return struct.pack('!I', len(body)) + body


def read_frame(fd):
    end = time.monotonic() + DEADLINE_SECONDS

    def exact(size):
        result = bytearray()
        while len(result) < size:
            remaining = end - time.monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError('frame_read_deadline')
            chunk = os.read(fd, min(65536, size - len(result)))
            if not chunk:
                raise EOFError('truncated_frame')
            result.extend(chunk)
        return result

    size, = struct.unpack('!I', exact(4))
    if not 0 < size <= FRAME_LIMIT:
        raise ValueError('frame_size')
    # JSON excludes Python expressions, executable reducers and custom objects.
    return json.loads(exact(size))


def write_frame(fd, value):
    remaining = memoryview(encode_frame(value))
    end = time.monotonic() + DEADLINE_SECONDS
    os.set_blocking(fd, False)
    while remaining:
        seconds = end - time.monotonic()
        if seconds <= 0 or not select.select([], [fd], [], seconds)[1]:
            raise TimeoutError('frame_write_deadline')
        try:
            written = os.write(fd, remaining)
        except BlockingIOError:
            continue
        if written <= 0:
            raise EOFError('frame_pipe_closed')
        remaining = remaining[written:]


def literal(value):
    """Admit only the benchmark's JSON scalar/list values, with bounded nesting."""
    pending, count = [(value, 0)], 0
    while pending:
        current, depth = pending.pop()
        count += 1
        if count > 500000 or depth > 24:
            raise ValueError('literal_complexity')
        if type(current) is list:
            pending.extend((item, depth + 1) for item in current)
        elif type(current) not in (str, int, bool):
            raise ValueError('literal_type')
    return value
