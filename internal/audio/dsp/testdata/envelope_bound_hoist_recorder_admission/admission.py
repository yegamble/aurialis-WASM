"""Separate recorder receipt analysis; immutable old gate remains RED."""
# cspell:ignore WRONLY CREAT lstat fstat ENOENT
import importlib.util
import os
import pathlib
import sys

sys.dont_write_bytecode = True
SOURCE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('immutable_qualification_host', SOURCE.with_name('envelope_bound_hoist_qualification_host') / 'host.py')
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
SCHEMA = HOST.SCHEMA


def recorder_requests(io, rate):
    requests = io.get('requests')
    if not isinstance(requests, list) or not 1 <= len(requests) <= 256 or any(not isinstance(item, dict) for item in requests):
        return False
    file = '/aurialis-private-fixture/rate' + str(rate) + '.bin'
    missing = [index for index, item in enumerate(requests) if item.get('result') != 'ok']
    opened = [index for index, item in enumerate(requests) if item.get('operation') == 'open']
    closed = [index for index, item in enumerate(requests) if item.get('operation') == 'close']
    if len(missing) != 1 or len(opened) != 1 or len(closed) != 1:
        return False
    absent, start, end = missing[0], opened[0], closed[0]
    if (not absent < start < end
            or requests[absent] != {'operation': 'lstat', 'path': file, 'result': 'ENOENT'}
            or requests[start] != {'operation': 'open', 'path': file, 'flags': os.O_WRONLY | os.O_CREAT | os.O_EXCL, 'mode': 0o600, 'result': 'ok'}
            or requests[end] != {'operation': 'close', 'fd': 3, 'result': 'ok'}):
        return False
    for index, item in enumerate(requests):
        operation = item.get('operation')
        if operation == 'stat':
            if item != {'operation': 'stat', 'path': '/aurialis-private-fixture', 'result': 'ok'} or index >= absent:
                return False
        elif operation == 'lstat':
            if index != absent:
                return False
        elif operation in ('open', 'close'):
            pass  # Sole exact entries were checked above.
        elif operation == 'fstat':
            if item != {'operation': 'fstat', 'fd': 3, 'result': 'ok'} or not start < index < end:
                return False
        elif operation in ('write', 'writeSync'):
            if (item.get('fd') not in (1, 2, 3) or 'path' in item or item.get('result') != 'ok'
                    or (item['fd'] == 3 and not start < index < end)):
                return False
        else:
            return False
    return True


def _validate_recorded_child(receipt, source_id, job, source, source_sha, argv, log_bytes, counter=None, output_sha=None):
    module = source['modules']['wasm']['module']
    expected = {'schema': SCHEMA, 'sourceId': source_id, 'jobId': job['id'], 'name': job['name'],
                'nodeVersion': 'v26.12.0', 'sourceSHA256': source_sha,
                'manifestSHA256': source['modules']['wasm']['BUILD_SHA256'], 'moduleSHA256': module['sha256'],
                'runtimeSHA256': source['runtime']['sha256'], 'overlaySHA256': module['overlaySHA256'], 'sourceSetSHA256': module['sourceSetSHA256'],
                'nodeArgv': argv, 'goArgv': [module['file'], '-test.run=^' + job['name'] + '$', '-test.count=1', '-test.v', '-test.timeout=25s'],
                'goExit': 0, 'goExited': True, 'failure': None}
    io = receipt.get('io', {})
    if set(receipt) != set(expected) | {'io', 'counterReceipt', 'outputSHA256', 'counterBUILD_SHA256'} or any(receipt.get(key) != value for key, value in expected.items()):
        raise ValueError('exact actual argv/module/GoJS provenance refused')
    common = {'file', 'flags', 'mode', 'bytes', 'logBytes', 'opened', 'everOpened', 'closed', 'failure', 'requests'}
    if job['kind'] == 'unit':
        common.add('openAttempts')
    if (io.get('file') != '/aurialis-private-fixture/rate' + str(job.get('rate', 8000)) + '.bin' or io.get('mode') != 0o600 or io.get('flags') != os.O_WRONLY | os.O_CREAT | os.O_EXCL):
        raise ValueError('closed exact file flags/mode refused')
    if set(io) != common or io.get('failure') is not None or io.get('opened') is not False or io.get('logBytes') != log_bytes or not isinstance(io.get('requests'), list) or len(io['requests']) > 256:
        raise ValueError('closed GoJS IO schema/completion refused')
    if job['kind'] == 'unit':
        if (io.get('openAttempts') != 0 or io.get('bytes') != 0 or io.get('everOpened') is not False or io.get('closed') is not False
                or any(item.get('operation') not in ('write', 'writeSync', 'fstat') or item.get('fd') not in (0, 1, 2) or item.get('result') != 'ok' for item in io['requests'])
                or any(receipt.get(key) is not None for key in ('counterReceipt', 'outputSHA256', 'counterBUILD_SHA256'))):
            raise ValueError('log-only unit IO refused')
    elif (receipt.get('counterReceipt') != counter or receipt.get('outputSHA256') != output_sha or receipt.get('counterBUILD_SHA256') != source['counterBUILD']['sha256']
          or io.get('everOpened') is not True or io.get('closed') is not True or io.get('bytes') != counter['outputBytes']
          or not recorder_requests(io, job['rate'])):
        raise ValueError('closed recorder IO/counter completion refused')



def validate_recorder(receipt, source_id, job, source, source_sha, argv, log_bytes, counter, output_sha):
    if job.get('kind') != 'recorder' or job.get('backend') != 'wasm' or job.get('rate') not in (8000, 44100, 48000, 96000, 192000):
        raise ValueError('closed actual GoJS recorder analysis only')
    _validate_recorded_child(receipt, source_id, job, source, source_sha, argv, log_bytes, counter, output_sha)
