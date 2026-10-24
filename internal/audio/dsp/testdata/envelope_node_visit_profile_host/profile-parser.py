"""Bounded binary/function and CPU-sample attribution; never instantiate WASM."""
# cspell:words cpuprofile fstat lstat RDONLY CLOEXEC
import collections
import hashlib
import json
import math
import os
import re
import stat

MODULE_CAP = 16 * 1024 * 1024
PROFILE_CAP = 4 * 1024 * 1024
NODE_CAP = 16384
SAMPLE_CAP = 65536
STEP_CAP = 1048576
REPORT_CAP = 8 * 1024 * 1024
PREFIX = 'github.com_yegamble_Aurialis_WASM_internal_audio_dsp.'
GRAPH_ROOTS = {PREFIX + '__studioGraph_.processBlock', PREFIX + '__studioGraph_.processFrame'}


def bounded_bytes(file, cap, mode=None):
    before = file.lstat()
    if not stat.S_ISREG(before.st_mode) or not 1 <= before.st_size <= cap or (mode is not None and stat.S_IMODE(before.st_mode) != mode):
        raise ValueError('pre-read regular-file/size/mode admission refused')
    descriptor = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened_stream = os.fdopen(descriptor, 'rb')
    except BaseException:
        os.close(descriptor)
        raise
    with opened_stream as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mode, opened.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mode, before.st_ctime_ns):
            raise ValueError('file changed before bounded read')
        data = stream.read(cap + 1)
        after = os.fstat(stream.fileno())
    if len(data) != before.st_size or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode, after.st_ctime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode, before.st_ctime_ns):
        raise ValueError('file changed during bounded read')
    return data


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError('duplicate JSON key')
        value[key] = item
    return value


def decode_json(data):
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda _value: (_ for _ in ()).throw(ValueError('nonfinite JSON constant')))


class Reader:
    def __init__(self, data, start=0, end=None):
        self.data, self.cursor = data, start
        self.end = len(data) if end is None else end
        if not 0 <= start <= self.end <= len(data):
            raise ValueError('section bounds refused')

    def take(self, count):
        if count < 0 or count > self.end - self.cursor:
            raise ValueError('bounded binary read refused')
        first = self.cursor
        self.cursor += count
        return self.data[first:self.cursor]

    def number(self):
        value = 0
        for shift in range(0, 35, 7):
            byte = self.take(1)[0]
            value |= (byte & 127) << shift
            if byte < 128:
                if value > 0xffffffff:
                    break
                return value
        raise ValueError('u32 encoding refused')

    def name(self):
        count = self.number()
        if count > 4096:
            raise ValueError('function/name string cap')
        return self.take(count).decode('utf-8')


def parse_module(file, expected_sha, expected_bytes=None):
    data = bounded_bytes(file, MODULE_CAP)
    if hashlib.sha256(data).hexdigest() != expected_sha or (expected_bytes is not None and len(data) != expected_bytes):
        raise ValueError('exact module hash/size differs')
    reader = Reader(data)
    if reader.take(8) != b'\0asm\x01\0\0\0':
        raise ValueError('WASM version refused')
    names, bodies, seen = {}, {}, set()
    imported, defined = 0, None
    named = named_functions = False
    while reader.cursor < reader.end:
        identity, size = reader.take(1)[0], reader.number()
        part = Reader(data, reader.cursor, reader.cursor + size)
        if identity > 12 or (identity and identity in seen):
            raise ValueError('section identity/duplicate refused')
        seen.add(identity)
        if identity == 0 and part.name() == 'name':
            if named:
                raise ValueError('duplicate name section')
            named = True
            while part.cursor < part.end:
                kind, count = part.take(1)[0], part.number()
                sub = Reader(data, part.cursor, part.cursor + count)
                if kind == 1:
                    if named_functions:
                        raise ValueError('duplicate function-name subsection')
                    named_functions = True
                    count = sub.number()
                    if count > 65536:
                        raise ValueError('function-name count cap')
                    for _ in range(count):
                        index, name = sub.number(), sub.name()
                        if index in names:
                            raise ValueError('duplicate named function index')
                        names[index] = name
                    if sub.cursor != sub.end:
                        raise ValueError('function-name subsection trailing bytes')
                part.cursor = sub.end
        elif identity == 2:
            count = part.number()
            if count > 65536:
                raise ValueError('import count cap')
            for _ in range(count):
                part.name()
                part.name()
                if part.take(1) != b'\0':
                    raise ValueError('only pinned function imports admitted')
                part.number()
                imported += 1
        elif identity == 3:
            defined = part.number()
            if defined > 65536:
                raise ValueError('defined-function count cap')
            for _ in range(defined):
                part.number()
        elif identity == 10:
            count = part.number()
            if defined is None or count != defined:
                raise ValueError('function/code count differs')
            for offset in range(count):
                length = part.number()
                start = part.cursor
                body = part.take(length)
                bodies[imported + offset] = {'offset': start, 'bytes': length, 'sha256': hashlib.sha256(body).hexdigest()}
        if identity in (2, 3, 10) and part.cursor != part.end:
            raise ValueError('section trailing bytes')
        reader.cursor = part.end
    if defined is None or len(bodies) != defined or not names or any(index >= imported + defined for index in names):
        raise ValueError('complete function/name mapping refused')
    reverse = collections.defaultdict(list)
    for index, name in names.items():
        reverse[name].append(index)
    return {'moduleSHA256': expected_sha, 'bytes': len(data), 'imports': imported, 'defined': defined, 'names': names,
            'bodies': bodies, 'reverse': dict(reverse),
            'nameMapSHA256': hashlib.sha256(json.dumps(sorted(names.items()), separators=(',', ':')).encode()).hexdigest()}


def integer(value, low=0, high=0x7fffffff):
    if type(value) is not int or not low <= value <= high:
        raise ValueError('bounded integer refused')
    return value


def distribution(values):
    ordered = sorted(values)
    def percentile(percent):
        return ordered[((len(ordered) - 1) * percent) // 100]
    return {'count': len(values), 'minimum': ordered[0], 'median': percentile(50), 'p90': percentile(90), 'p99': percentile(99),
            'maximum': ordered[-1], 'mean': sum(values) / len(values), 'zeroCount': values.count(0),
            'belowRequested100': sum(value < 100 for value in values), 'atLeast1000': sum(value >= 1000 for value in values)}


def profile_summary(data, mapping, used):
    if not 1 <= len(data) <= PROFILE_CAP:
        raise ValueError('profile byte cap')
    profile = decode_json(data)
    if not isinstance(profile, dict) or set(profile) != {'nodes', 'samples', 'timeDeltas', 'startTime', 'endTime'}:
        raise ValueError('closed CPU profile schema refused')
    nodes, samples, deltas = profile['nodes'], profile['samples'], profile['timeDeltas']
    if (not all(isinstance(value, list) for value in (nodes, samples, deltas)) or not 1 <= len(nodes) <= NODE_CAP
            or not 1 <= len(samples) <= SAMPLE_CAP or len(samples) != len(deltas)):
        raise ValueError('node/sample counts refused')
    first, final = profile['startTime'], profile['endTime']
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (first, final)) or not 0 < first < final or final - first > 28000000:
        raise ValueError('profile time bounds refused')
    for value in deltas:
        integer(value, 0, 28000000)
    if sum(deltas) > final - first:
        raise ValueError('sample clock exceeds profile span')
    by_id, parents, resolved, urls = {}, {}, {}, set()
    for node in nodes:
        if not isinstance(node, dict) or not {'id', 'callFrame'} <= set(node) or set(node) - {'id', 'callFrame', 'children', 'hitCount', 'positionTicks'}:
            raise ValueError('closed node schema refused')
        identity = integer(node['id'], 1)
        if identity in by_id:
            raise ValueError('duplicate node ID')
        frame = node['callFrame']
        if not isinstance(frame, dict) or set(frame) != {'functionName', 'scriptId', 'url', 'lineNumber', 'columnNumber'}:
            raise ValueError('closed call-frame schema refused')
        for key, limit in (('functionName', 4096), ('scriptId', 128), ('url', 4096)):
            if not isinstance(frame[key], str) or len(frame[key].encode('utf-8')) > limit:
                raise ValueError('call-frame string cap')
        integer(frame['lineNumber'], -1, MODULE_CAP)
        integer(frame['columnNumber'], -1, MODULE_CAP)
        integer(node.get('hitCount', 0), 0, SAMPLE_CAP)
        ticks = node.get('positionTicks', [])
        if not isinstance(ticks, list) or len(ticks) > SAMPLE_CAP:
            raise ValueError('position-tick count refused')
        for tick in ticks:
            if not isinstance(tick, dict) or set(tick) != {'line', 'ticks'}:
                raise ValueError('position-tick schema refused')
            integer(tick['line'], 0, MODULE_CAP)
            integer(tick['ticks'], 0, SAMPLE_CAP)
        symbol, index = frame['functionName'], None
        if frame['url'].startswith('wasm:'):
            if not re.fullmatch(r'wasm://wasm/[0-9a-f]{1,64}', frame['url']):
                raise ValueError('WASM script URL refused')
            urls.add(frame['url'])
            match = re.fullmatch(r'wasm-function\[(\d{1,10})\]', symbol)
            if match:
                candidate = int(match[1])
                if candidate in mapping['names']:
                    index = candidate
            elif len(mapping['reverse'].get(symbol, [])) == 1:
                index = mapping['reverse'][symbol][0]
        token = 'w' + str(index) if index is not None else 'n' + str(identity)
        resolved[identity] = {'token': token, 'functionIndex': index,
                              'name': mapping['names'][index] if index is not None else symbol,
                              'unresolvedWasm': frame['url'].startswith('wasm:') and index is None}
        by_id[identity] = node
    if len(urls) > 1:
        raise ValueError('more than one WASM script in single-module diagnostic')
    for identity, node in by_id.items():
        children = node.get('children', [])
        if not isinstance(children, list) or len(children) > NODE_CAP:
            raise ValueError('child relation cap')
        for child in children:
            integer(child, 1)
            if child not in by_id or child in parents or child == identity:
                raise ValueError('missing/duplicate/self parent refused')
            parents[child] = identity
    roots = set(by_id) - set(parents)
    if len(roots) != 1:
        raise ValueError('single rooted profile tree required')
    root = next(iter(roots))
    if by_id[root]['callFrame']['functionName'] != '(root)':
        raise ValueError('CPU profile root refused')
    connected = {root}
    for identity in by_id:
        cursor, path = identity, set()
        while cursor not in connected:
            if cursor in path or cursor not in parents:
                raise ValueError('cycle/disconnected profile node')
            path.add(cursor)
            cursor = parents[cursor]
        connected.update(path)
    self_counts, inclusive, edges, recursive, paths, categories = (collections.Counter() for _ in range(6))
    steps, graph, unresolved_graph = 0, 0, 0
    for sample in samples:
        integer(sample, 1)
        if sample not in by_id:
            raise ValueError('unknown sample node')
        stack, cursor = [], sample
        while cursor is not None:
            steps += 1
            if steps + used.get('steps', 0) > STEP_CAP:
                raise ValueError('aggregate stack-step cap')
            stack.append(cursor)
            cursor = parents.get(cursor)
        labels = [resolved[identity] for identity in stack]
        if any(item['functionIndex'] is not None and item['name'] in GRAPH_ROOTS for item in labels):
            graph += 1
            unresolved_graph += any(item['unresolvedWasm'] for item in labels)
            tokens = [item['token'] for item in labels]
            self_counts[tokens[0]] += 1
            inclusive.update(set(tokens))
            recursive.update({token: count - 1 for token, count in collections.Counter(tokens).items() if count > 1})
            edges.update(set(zip(tokens[1:], tokens[:-1])))
            paths[tuple(reversed(stack))] += 1
            categories['graph'] += 1
        elif any(item['unresolvedWasm'] for item in labels):
            categories['unresolved-wasm'] += 1
        elif any(item['name'] == '(garbage collector)' for item in labels):
            categories['garbage-collector'] += 1
        elif any(item['functionIndex'] is not None and item['name'].startswith('runtime.') for item in labels):
            categories['runtime-outside-graph'] += 1
        elif any(item['functionIndex'] is not None and '.prepareStudio' in item['name'] for item in labels):
            categories['preparation-outside-graph'] += 1
        elif any(item['functionIndex'] is not None for item in labels):
            categories['wasm-outside-graph'] += 1
        else:
            categories['host-or-idle'] += 1
    additions = {'bytes': len(data), 'nodes': len(nodes), 'samples': len(samples), 'steps': steps}
    caps = {'bytes': PROFILE_CAP, 'nodes': NODE_CAP, 'samples': SAMPLE_CAP, 'steps': STEP_CAP}
    for key, value in additions.items():
        if type(used.get(key, 0)) is not int or not 0 <= used.get(key, 0) <= caps[key] - value:
            raise ValueError('aggregate profile admission cap')
    referenced = {item['functionIndex'] for item in resolved.values() if item['functionIndex'] is not None}
    report = {'scope': 'diagnostic sample attribution only; no timing comparability/cost/speedup/deadline/headroom inference',
              'moduleSHA256': mapping['moduleSHA256'], 'profileSHA256': hashlib.sha256(data).hexdigest(),
              'profileBytes': len(data), 'nodeCount': len(nodes), 'sampleCount': len(samples), 'graphSamples': graph,
              'unresolvedGraphSamples': unresolved_graph, 'unresolvedWasmNodes': sum(item['unresolvedWasm'] for item in resolved.values()),
              'requestedIntervalMicroseconds': 100, 'observedTimeDeltaMicroseconds': distribution(deltas),
              'profileSpanMicroseconds': final - first, 'sumTimeDeltasMicroseconds': sum(deltas), 'stackSteps': steps,
              'exclusiveSampleCategories': dict(categories), 'graphSelfLeafCounts': dict(self_counts),
              'graphInclusiveMembershipCounts': dict(inclusive), 'recursiveMembershipBeyondFirst': dict(recursive),
              'graphCallerCalleeMembershipCounts': [{'caller': key[0], 'callee': key[1], 'samples': value} for key, value in edges.most_common()],
              'topGraphPaths': [{'rootToLeafNodeIDs': list(path), 'samples': count} for path, count in paths.most_common(20)],
              'inclusiveLimit': 'inclusive function/edge memberships overlap; do not sum as exclusive cost',
              'rawFrames': [{'id': identity, 'callFrame': node['callFrame'], **resolved[identity]} for identity, node in by_id.items()],
              'actualWasmFunctions': {str(index): {'name': mapping['names'][index], 'codeBody': mapping['bodies'].get(index)} for index in sorted(referenced)}}
    if len(json.dumps(report).encode()) > REPORT_CAP:
        raise ValueError('bounded attribution report cap')
    for key, value in additions.items():
        used[key] = used.get(key, 0) + value
    return report
