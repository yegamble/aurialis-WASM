"""Pure source controls for private attention ownership, never launches a process."""
from observed_process import known_group_survivors, union_rows

GIB = 1024 ** 3
MAX_OUTPUT = 64 * 1024 ** 2
MAX_WALL = 60
MAX_LIVE = 256
MAX_KNOWN = 4096


def node_command(node, launcher, mode, control):
    if mode not in ('normal', 'crash', 'metadata', 'first-four'):
        raise ValueError('Only normal/crash/metadata source commands exist')
    return [node, '--max-old-space-size=192', '--stack-size=8192', launcher, mode, control]


def check_resources(observation, known_count, output_bytes, available_bytes, elapsed, supervisor=None):
    live = union_rows(observation['liveMembers'], supervisor)
    if len(live) > MAX_LIVE or known_count > MAX_KNOWN:
        raise RuntimeError('Owned process identity/count cap')
    rss = sum(row['rssBytes'] for row in live)
    if rss > 4 * GIB or output_bytes > MAX_OUTPUT or available_bytes < 6 * GIB or elapsed > MAX_WALL:
        raise RuntimeError('Ownership resource/wall/disk cap')
    return {'rssBytes': rss, 'liveProcesses': len(live), 'knownIdentities': known_count, 'outputBytes': output_bytes, 'availableBytes': available_bytes, 'elapsed': elapsed}


def parse_actual_command(text, executable):
    import shlex
    # macOS ps does not quote an executable path containing spaces.
    if text == executable:
        return [executable]
    prefix = executable + ' '
    if not text.startswith(prefix):
        raise RuntimeError('Actual command executable prefix differs from pin')
    return [executable] + shlex.split(text[len(prefix):])


def check_static_runtime(text, record, launch_pin, runtime_pin, source, expected):
    """Exact named launch/runtime identities; no alias/realpath/basename rule."""
    import hashlib
    if record.get('expectedExecutable') != {key: launch_pin[key] for key in ('path', 'bytes', 'sha256')}:
        raise RuntimeError('STATIC launch identity evidence changed')
    if record.get('pid') != expected['pid'] or record.get('expectedIdentity') != expected:
        raise RuntimeError('STATIC expected process evidence changed')
    for key in ('before', 'after'):
        row = record.get(key)
        if not isinstance(row, dict) or any(row.get(field) != expected[field] for field in ('pid', 'ppid', 'pgid', 'start')) or not isinstance(row.get('state'), str) or 'Z' in row['state']:
            raise RuntimeError('STATIC runtime process evidence changed')
    if record.get('error') is not None or record.get('errors') != [] or record.get('commandCleanup') != [] or record.get('fileCleanup') != [] or record.get('commandPrimary') is not None or record.get('filePrimary') is not None:
        raise RuntimeError('STATIC runtime evidence has unresolved errors')
    raw = record.get('rawCommandText')
    if not isinstance(raw, str) or record.get('rawCommandComplete') is not True or record.get('rawCommandTruncated') is not False or record.get('rawCommandHex') is not None:
        raise RuntimeError('STATIC complete raw command evidence required')
    encoded = raw.encode('utf8')
    if not 0 < len(encoded) <= 16384 or record.get('rawCommandBytes') != len(encoded) or record.get('rawCommandSHA256') != hashlib.sha256(encoded).hexdigest() or text != raw.strip():
        raise RuntimeError('STATIC raw command evidence checksum changed')
    kernel = record.get('kernelExecutable')
    if not isinstance(kernel, dict) or any(kernel.get(key) != runtime_pin[key] for key in ('path', 'bytes', 'sha256')):
        raise RuntimeError('STATIC exact kernel runtime pin mismatch')
    parts = parse_actual_command(text, runtime_pin['path'])
    if parts != [runtime_pin['path'], source]:
        raise RuntimeError('STATIC exact runtime/source argv mismatch')
    return parts


def check_browser_command(parts, brave, scratch):
    from pathlib import Path
    if not parts or parts[0] != brave:
        raise RuntimeError('Actual Brave executable differs from pin')
    forbidden = ('--enable-unsafe-swiftshader', '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--use-angle', '--use-gl', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features', '--disable-web-security', '--headless', '--ignore-certificate-errors', '--disable-software-rasterizer')
    if any(part == flag or part.startswith(flag + '=') for part in parts[1:] for flag in forbidden):
        raise RuntimeError('Actual sandbox/GPU/security flags refused')
    profiles = [part.split('=', 1)[1] for part in parts if part.startswith('--user-data-dir=')]
    if len(profiles) != 1:
        raise RuntimeError('Exact fresh profile missing/ambiguous')
    profile = Path(profiles[0]).resolve()
    profile.relative_to(Path(scratch).resolve())
    return str(profile)


class ProbeState:
    def __init__(self, token, node_pid):
        self.token, self.node = token, node_pid
        self.browser = None
        self.server = None
        self.work = set()

    def browser_admitted(self, pid):
        if self.browser is not None:
            raise RuntimeError('Repeated browser admission')
        self.browser = pid

    def admit_server(self, value, observation):
        from urllib.parse import urlsplit
        if set(value) != {'token', 'nodePID', 'browserPID', 'serverPID', 'url'} or value['token'] != self.token or value['nodePID'] != self.node or value['browserPID'] != self.browser:
            raise RuntimeError('Static server identity mismatch')
        endpoint = urlsplit(value['url'])
        if endpoint.scheme != 'http' or endpoint.hostname != '127.0.0.1' or not endpoint.port or endpoint.path or endpoint.query or endpoint.fragment or endpoint.username or endpoint.password:
            raise RuntimeError('Closed static endpoint required')
        row = next((row for row in observation['liveMembers'] if row['pid'] == value['serverPID']), None)
        if row is None or row['ppid'] != self.node or row['pgid'] != self.node or self.server is not None:
            raise RuntimeError('Static server not an exact Node child/group member')
        self.server = dict(row)

    def admit_work(self, value, observation):
        if set(value) != {'token', 'nodePID', 'browserPID', 'workerPID', 'phase', 'id'} or value['token'] != self.token or value['nodePID'] != self.node or value['browserPID'] != self.browser or value['phase'] != 'before-worker':
            raise RuntimeError('Prework identity mismatch')
        import re
        if not isinstance(value['id'], str) or re.fullmatch('[a-f0-9-]{36}', value['id']) is None or value['id'] in self.work or len(self.work) >= 4 or not self.server:
            raise RuntimeError('Prework quota/identity/server prerequisite')
        live = {row['pid']: row for row in observation['liveMembers']}
        server = live.get(self.server['pid'])
        if not server or server['start'] != self.server['start'] or server['pgid'] != self.node or server['ppid'] != self.node or self.node not in live or self.browser not in live or value['workerPID'] != self.node:
            raise RuntimeError('Prework current owned subtree is incomplete')
        self.work.add(value['id'])

    def ready(self, value, mode):
        expected = {'token', 'nodePID', 'browserPID', 'serverPID', 'status', 'mode', 'ownershipAcknowledgedBeforeWorker', 'audioProcessing', 'gpuRequested'}
        if set(value) != expected or not self.server or not self.work or value['token'] != self.token or value['nodePID'] != self.node or value['browserPID'] != self.browser or value['serverPID'] != self.server['pid'] or value['status'] != 'pass' or value['mode'] != mode or value['ownershipAcknowledgedBeforeWorker'] is not True or value['audioProcessing'] is not False or value['gpuRequested'] is not (mode in ('metadata', 'first-four')):
            raise RuntimeError('Readiness lacks exact acknowledged source authority')
        if mode == 'first-four' and len(self.work) != 4:
            raise RuntimeError('Exactly four fresh fixture ACKs required')

    def crash_survivors(self, before, after):
        survivors = known_group_survivors(before, after, self.browser)
        if not survivors:
            raise RuntimeError('No exact pre-admitted browser group member survived Node crash')
        return survivors


def final_empty(observed):
    if observed['liveMembers']:
        raise RuntimeError('Final owned process observation still has LIVE members')
