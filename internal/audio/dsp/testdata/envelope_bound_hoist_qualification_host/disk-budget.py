"""Fixed46-child write ledger; physical observations are not OS reservations."""
# cspell:ignore WRONLY CREAT fstat purgeable statvfs frsize bavail CLOEXEC RDONLY fstat
import json
import os
import pathlib
import stat
import time

FLOOR = 6576668672
KIB = 1024
MIB = KIB * KIB
SOURCE_ALLOWANCE = 64 * MIB
COORD_CAP = 8 * KIB
JOURNAL_CAP = MIB
MAX_RECORDS = 512
SOURCE_FILES = {'host.py', 'disk-budget.py', 'binding.mjs', 'unit.mjs', 'recorder.mjs', 'source-contract.test.py', 'README.md'}


def slots(jobs):
    result = {'SOURCE.json': 256 * KIB, 'SOURCE-SHA256.json': 256 * KIB,
              'QUALIFICATION.json': 256 * KIB, 'ALL-SHA256.json': 512 * KIB,
              'disk.jsonl': JOURNAL_CAP, 'ACTIVE.lock': 4 * KIB}
    result.update({'source-frozen/' + name: 256 * KIB for name in SOURCE_FILES})
    for job in jobs:
        prefix = 'runs/' + job['id'] + '/'
        result['claims/' + job['id'] + '.json'] = 4 * KIB
        result.update({prefix + name: cap for name, cap in (
            ('child.log', 256 * KIB), ('parent-exit.json', 16 * KIB),
            ('ACCEPTED.json', 64 * KIB), ('REJECTED.json', 64 * KIB))})
        if job['backend'] == 'wasm':
            result[prefix + 'receipt.json'] = 128 * KIB
        if job['kind'] == 'recorder':
            result[prefix + 'rate' + str(job['rate']) + '.bin'] = 8 * MIB
    return result


def remaining(directory, ledger):
    # Keep unused capacity even for completed files. Round every slot to64KiB,
    # reserve4KiB metadata/slot and64KiB/directory, plus8MiB emergency allowance.
    directories = {'.'} | {str(parent) for name in ledger for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
    sizes = {}
    if directory.exists():
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('exclusive evidence directory refused')
        for path in directory.rglob('*'):
            name = path.relative_to(directory).as_posix()
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode) and name in directories:
                continue
            if not stat.S_ISREG(info.st_mode) or name not in ledger or info.st_size > ledger[name]:
                raise ValueError('unknown/symlink/over-cap evidence refused: ' + name)
            sizes[name] = info.st_size
    return (sum(cap - sizes.get(name, 0) for name, cap in ledger.items())
            + sum((-cap) % (64 * KIB) + 4 * KIB for cap in ledger.values())
            + len(directories) * 64 * KIB + 8 * MIB)


def decode_coord(data, now, device):
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError('duplicate coordination key')
            result[name] = value
        return result
    value = json.loads(data, object_pairs_hook=unique)
    expected = {'schema', 'issuedUnix', 'expiresUnix', 'volumeDevice', 'otherRemainingBytes', 'concurrentSourceAllowanceBytes'}
    if (set(value) != expected or value['schema'] != 'dsp46-coordination-v1'
            or any(type(value[key]) is not int for key in expected - {'schema'})
            or not 0 <= now - value['issuedUnix'] <= 1800
            or not now < value['expiresUnix'] <= value['issuedUnix'] + 1800
            or value['volumeDevice'] != device
            or not 0 <= value['otherRemainingBytes'] <= 1024 ** 4
            or not SOURCE_ALLOWANCE <= value['concurrentSourceAllowanceBytes'] <= 1024 ** 4):
        raise ValueError('fresh explicit other-demand/volume coordination refused')
    return value


class Budget:
    def __init__(self, directory, coordination, ledger, reader):
        self.directory, self.coordination, self.ledger, self.reader = directory, coordination, ledger, reader

    def check(self, event):
        parent = self.directory if self.directory.exists() else self.directory.parent
        device = parent.stat().st_dev
        coord = decode_coord(self.reader(self.coordination, COORD_CAP), int(time.time()), device)
        demand = remaining(self.directory, self.ledger)
        observed = os.statvfs(parent)
        if not 0 < observed.f_frsize <= 64 * KIB:
            raise ValueError('filesystem allocation unit refused')
        free = observed.f_bavail * observed.f_frsize
        required = FLOOR + demand + coord['otherRemainingBytes'] + coord['concurrentSourceAllowanceBytes']
        if free < required:
            raise OSError('physical free below fixed floor plus complete remaining demand')
        record = {'event': event, 'observedUnix': int(time.time()), 'physicalFreeBytes': free,
                  'floorBytes': FLOOR, 'remainingDSPBytes': demand, 'coordination': coord,
                  'requiredBytes': required, 'scope': 'admission observation; no OS reservation/purgeable credit'}
        data = (json.dumps(record, separators=(',', ':')) + '\n').encode()
        journal = self.directory / 'disk.jsonl'
        length = journal.stat().st_size if journal.exists() else 0
        if len(data) > 2 * KIB or length + len(data) > JOURNAL_CAP:
            raise ValueError('disk observation journal cap refused')
        if journal.exists() and self.reader(journal, JOURNAL_CAP).count(b'\n') >= MAX_RECORDS:
            raise ValueError('disk observation count refused')
        self.directory.mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            with os.fdopen(descriptor, 'ab') as stream:
                stream.write(data)
        except BaseException:
            # fdopen owns the descriptor once constructed; no child is owned here.
            raise
        return record

    def publish(self, name, data):
        if name not in self.ledger or name == 'disk.jsonl' or not isinstance(data, bytes) or len(data) > self.ledger[name]:
            raise ValueError('closed publication/cap refused')
        self.check('publish:' + name)
        target = self.directory / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data)

    def json(self, name, value):
        self.publish(name, (json.dumps(value, indent=2) + '\n').encode())
