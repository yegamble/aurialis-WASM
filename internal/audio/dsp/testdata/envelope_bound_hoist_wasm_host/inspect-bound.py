"""Bounded exact-name WASM inspection; never compile or instantiate modules."""
# cspell:ignore AF64 AI64 ALocal ABr ACall ALoop GOTOOLDIR
import collections
import hashlib
import importlib.util
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[5]
SPEC = importlib.util.spec_from_file_location('bound_binary_parser', pathlib.Path(__file__).resolve().parent.with_name('envelope_node_visit_profile_host') / 'profile-parser.py')
PARSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARSER)
NAME = 'github.com_yegamble_Aurialis_WASM_internal_audio_dsp.__studioGainEnvelope_.bound'
TOOL = pathlib.Path('/Users/yosefgamble/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.darwin-arm64/src/cmd/internal/obj/wasm')
PINS = {'a.out.go': 'f4222ffd6a7206e0f16585e93a75a551ed3b5edcf575de64badfeafd17ab3425', 'wasmobj.go': 'a7b2be5e09e1f73496c4eb4258bab63428d5e4cdafd045c96b87b9163ea31942'}
BODY_CAP, OP_CAP, STATE_CAP, STEP_CAP, REPORT_CAP = 16384, 8192, 100000, 1048576, 4 * 1024 * 1024


def emitter_names():
    names, active, value = {}, False, 0
    for name, sha in PINS.items():
        if hashlib.sha256(PARSER.bounded_bytes(TOOL / name, 256 * 1024)).hexdigest() != sha:
            raise ValueError('pinned Go emitter source differs')
    for line in (TOOL / 'a.out.go').read_text().splitlines():
        match = re.match(r'\s*(A[A-Za-z0-9]+)(?:\s*// opcode (0x[0-9A-Fa-f]+))?\s*$', line)
        if not match:
            continue
        name, base = match.groups()
        if name == 'AUnreachable':
            active = True
        if not active:
            continue
        if name == 'AI32TruncSatF32S':
            break
        if base is not None:
            value = int(base, 16)
        names[value] = name
        value += 1
    if names.get(0xb9) != 'AF64ConvertI64S':
        raise ValueError('emitter opcode table refused')
    return names


def decode(data, names):
    if not 1 <= len(data) <= BODY_CAP:
        raise ValueError('function body cap')
    reader = PARSER.Reader(data)
    locals_ = []
    group_count = reader.number()
    if group_count > 256:
        raise ValueError('local group cap')
    for _ in range(group_count):
        count, kind = reader.number(), reader.take(1)[0]
        if kind not in (0x7f, 0x7e, 0x7d, 0x7c) or sum(item[0] for item in locals_) + count > 4096:
            raise ValueError('bounded numeric locals refused')
        locals_.append([count, hex(kind)])
    ops, stack = [], [{'kind': 'function', 'start': -1}]

    def signed(bits):
        value = shift = 0
        for _ in range((bits + 6) // 7):
            byte = reader.take(1)[0]
            value |= (byte & 127) << shift
            shift += 7
            if byte < 128:
                if byte & 64:
                    value -= 1 << shift
                if not -(1 << (bits - 1)) <= value < (1 << (bits - 1)):
                    break
                return value
        raise ValueError('bounded signed immediate refused')

    def control(depth):
        if depth >= len(stack):
            raise ValueError('branch control depth refused')
        return stack[-1-depth]

    while reader.cursor < reader.end:
        offset, code = reader.cursor, reader.take(1)[0]
        args, name = [], names.get(code)
        if code in (2, 3, 4):
            args = [signed(33)]
        elif code in (12, 13, 16, 32, 33, 34, 35, 36, 63, 64):
            args = [reader.number()]
        elif code == 14:
            count = reader.number()
            if count > 4096:
                raise ValueError('branch table cap')
            args = [reader.number() for _ in range(count + 1)]
        elif code == 17 or 40 <= code <= 62:
            args = [reader.number(), reader.number()]
        elif code in (65, 66):
            args = [signed(32 if code == 65 else 64)]
        elif code in (67, 68):
            args = [reader.take(4 if code == 67 else 8).hex()]
        elif code == 252:
            args = [reader.number()]
            name = 'saturating-conversion-' + str(args[0])
            if args[0] > 7:
                raise ValueError('unhandled extended opcode')
        elif not (code in (0, 1, 5, 11, 15, 26, 27) or 69 <= code <= 196):
            raise ValueError('unknown opcode')
        if name is None or len(ops) >= OP_CAP or not stack:
            raise ValueError('opcode/control/instruction admission refused')
        op = {'relative': offset, 'code': code, 'name': name, 'args': args}
        if code in (12, 13):
            op['controls'] = [control(args[0])]
        elif code == 14:
            op['controls'] = [control(depth) for depth in args]
        ops.append(op)
        if code in (2, 3, 4):
            if len(stack) >= 64:
                raise ValueError('control nesting cap')
            item = {'kind': name, 'start': len(ops)-1}
            stack.append(item)
            op['control'] = item
        elif code == 5:
            if stack[-1]['kind'] != 'AIf' or 'else' in stack[-1]:
                raise ValueError('else control refused')
            stack[-1]['else'] = len(ops)-1
        elif code == 11:
            stack.pop()['end'] = len(ops)-1
    if stack or not ops or ops[-1]['code'] != 11:
        raise ValueError('incomplete function control')

    def target(item):
        return item['start']+1 if item['kind'] == 'ALoop' else item['end']+1

    graph = {}
    for index, op in enumerate(ops):
        code = op['code']
        following = [index+1]
        if code == 12:
            following = [target(op['controls'][0])]
        elif code == 13:
            following += [target(op['controls'][0])]
        elif code == 14:
            following = [target(item) for item in op['controls']]
        elif code in (0, 15) or (code == 11 and index == len(ops)-1):
            following = []
        elif code == 4:
            item = op['control']
            following += [item.get('else', item['end'])+1]
        elif code == 5:
            item = next(item['control'] for item in ops if item.get('control', {}).get('else') == index)
            following = [item['end']+1]
        graph[index] = [n for n in following if n < len(ops)]

    def successors(state):
        index, pc = state
        op, new_pc = ops[index], pc
        if op['name'] == 'ALocalSet' and op['args'] == [0]:
            previous = ops[index-1]
            new_pc = previous['args'][0] if previous['name'] == 'AI32Const' else None
        following = graph[index]
        if op['code'] == 14 and pc is not None:
            if pc < 0:
                raise ValueError('negative constant dispatcher refused')
            controls = op['controls']
            following = [target(controls[pc] if pc < len(controls)-1 else controls[-1])]
        return [(n, new_pc) for n in following if n < len(ops)]

    reachable, queue, steps = {(0, 0)}, collections.deque([(0, 0)]), 0
    while queue:
        for following in successors(queue.popleft()):
            steps += 1
            if steps > STEP_CAP or len(reachable) >= STATE_CAP:
                raise ValueError('control exploration cap')
            if following not in reachable:
                reachable.add(following)
                queue.append(following)
    conversions = [index for index, op in enumerate(ops) if op['code'] == 0xb9]
    if len(conversions) != 1:
        raise ValueError('exactly one signed integer-to-float conversion required')
    conversion, cycle = conversions[0], None
    for seed in sorted((state for state in reachable if state[0] == conversion), key=lambda x: -1 if x[1] is None else x[1]):
        queue, seen = collections.deque(successors(seed)), set()
        while queue:
            state = queue.popleft()
            steps += 1
            if steps > STEP_CAP or len(seen) >= STATE_CAP:
                raise ValueError('conversion cycle cap')
            if state == seed:
                cycle = {'instruction': conversion, 'dispatcher': seed[1]}
                break
            if state not in seen:
                seen.add(state)
                queue.extend(successors(state))
        if cycle is not None:
            break
    # This preserves every operation; only local identifiers are renamed by
    # first occurrence for readable comparison. Raw identifiers remain below.
    local_map, normalized, clean = {}, [], []
    for index, op in enumerate(ops):
        args = list(op['args'])
        if op['code'] in (32, 33, 34):
            local_map.setdefault(args[0], len(local_map))
            args = ['local' + str(local_map[args[0]])]
        normalized.append({'op': op['name'], 'args': args, 'next': graph[index]})
        clean.append({key: value for key, value in op.items() if key not in ('control', 'controls')})
    return {'locals': locals_, 'instructions': clean, 'normalizedOperations': normalized,
            'localRenameMap': local_map, 'conversionInstruction': conversion,
            'conversionReachableDispatchValues': sorted({state[1] for state in reachable if state[0] == conversion}, key=lambda x: -1 if x is None else x),
            'conversionInReachableCycle': cycle is not None, 'cycleWitness': cycle,
            'explorationSteps': steps, 'reachableStates': len(reachable),
            'floatingMathSequence': [[op['name'], op['args']] for op in ops if op['code'] in (67, 68) or 91 <= op['code'] <= 102 or 139 <= op['code'] <= 166]}


def inspect(file, sha, size):
    mapping = PARSER.parse_module(file, sha, size)
    indices = mapping['reverse'].get(NAME, [])
    if len(indices) != 1 or indices[0] not in mapping['bodies']:
        raise ValueError('exact single production bound name/body required')
    index = indices[0]
    body = mapping['bodies'][index]
    data = PARSER.bounded_bytes(file, PARSER.MODULE_CAP)
    if hashlib.sha256(data).hexdigest() != sha:
        raise ValueError('module changed between bounded inspection reads')
    raw = data[body['offset']:body['offset']+body['bytes']]
    report = decode(raw, emitter_names())
    report.update({'moduleSHA256': sha, 'functionIndex': index, 'functionName': NAME, 'body': body,
                   'calls': [mapping['names'].get(op['args'][0], 'unresolved-index-' + str(op['args'][0])) for op in report['instructions'] if op['code'] == 16]})
    return raw, report


def compare(first, second):
    math_equal = first['floatingMathSequence'] == second['floatingMathSequence']
    calls_equal = first['calls'] == second['calls']
    distinct = first['body']['sha256'] != second['body']['sha256']
    reviewed_shape = distinct and math_equal and calls_equal and bool(second['conversionReachableDispatchValues']) and first['conversionInReachableCycle'] and not second['conversionInReachableCycle'] and not any(name.startswith('unresolved-index-') for name in first['calls'] + second['calls'])
    return {'rawBodyDiffers': distinct, 'floatingMathSequenceEqual': math_equal, 'namedCallOrderEqual': calls_equal,
            'baselineConversionInReachableCycle': first['conversionInReachableCycle'], 'candidateConversionInReachableCycle': second['conversionInReachableCycle'],
            'shapeConsistentWithProposedHoist': reviewed_shape,
            'scope': 'constant-dispatch-aware static graph within the function with other conditions abstract and calls treated as returning. Every raw/control/math operation is preserved in reports; first-occurrence local renaming is descriptive, not a proof of equivalent control. No V8, cost, speedup, full-chain or deadline admission.'}
