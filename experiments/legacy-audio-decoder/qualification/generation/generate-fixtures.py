"""Private generated candidates only; no new native/WASM decoder is executed."""
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import signal
import struct
import subprocess
import time

SETUP = Path('/private/tmp/aurialis-private-decoder-setup')
ROOT = Path('/private/tmp/aurialis-private-decoder-fixtures-01')
FFMPEG = Path('/opt/homebrew/bin/ffmpeg')
FFPROBE = Path('/opt/homebrew/bin/ffprobe')
MAX_RETAINED = 512 * 1024 * 1024
MAX_ENCODED = 192 * 1024 * 1024
RESERVE = 6 * 1024**3
started = time.monotonic()
events = []

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()

def usage():
    return sum(p.stat().st_size for p in ROOT.rglob('*') if p.is_file())

def guard():
    if time.monotonic() - started > 900 or usage() > MAX_RETAINED or shutil.disk_usage(ROOT).free < RESERVE:
        raise RuntimeError('Fixture suite wall/output/disk guard failed.')

def child_limit():
    resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

def command(args, name):
    guard()
    stdout, stderr = ROOT / 'logs' / (name + '.stdout'), ROOT / 'logs' / (name + '.stderr')
    begin = time.monotonic(); killed = None; sampled_rss = 0; proc = None; primary = None; cleanup_error = None
    try:
        with stdout.open('xb') as out, stderr.open('xb') as err:
            proc = subprocess.Popen([str(a) for a in args], stdout=out, stderr=err, start_new_session=True, preexec_fn=child_limit)
            while proc.poll() is None:
                if time.monotonic() - begin > 30: killed = 'wall'
                elif stdout.stat().st_size + stderr.stat().st_size > 256 * 1024: killed = 'log-output'
                elif usage() > MAX_RETAINED or shutil.disk_usage(ROOT).free < RESERVE: killed = 'output/disk'
                else:
                    sampled = subprocess.run(['/bin/ps', '-g', str(proc.pid), '-o', 'rss='], capture_output=True, text=True, timeout=2)
                    if sampled.returncode == 0:
                        rss = sum(int(value) * 1024 for value in sampled.stdout.split())
                        sampled_rss = max(sampled_rss, rss)
                        if rss > 4 * 1024**3: killed = 'sampled-group-rss'
                    elif proc.poll() is None: killed = 'rss-monitor-unavailable'
                if killed:
                    os.killpg(proc.pid, signal.SIGKILL); break
                time.sleep(0.025)
            proc.wait(timeout=5)
    except BaseException as error:
        primary = type(error).__name__ + ': ' + str(error)
        raise
    finally:
        if proc is not None:
            try:
                if proc.poll() is None: os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
            except BaseException as error:
                cleanup_error = type(error).__name__ + ': ' + str(error)
        event = {'name': name, 'args': [str(a) for a in args], 'pid': proc.pid if proc else None,
                 'exitCode': proc.returncode if proc else None, 'guardFailure': killed,
                 'primaryFailure': primary, 'cleanupError': cleanup_error,
                 'sampledGroupRSSBytes': sampled_rss, 'elapsedSeconds': round(time.monotonic() - begin, 3),
                 'stdout': str(stdout), 'stderr': str(stderr)}
        events.append(event)
        (ROOT / 'commands.json').write_text(json.dumps(events, indent=2) + '\n')
        if cleanup_error and primary is None: raise RuntimeError('Owned fixture process cleanup failed: ' + cleanup_error)
    if killed: raise RuntimeError('Fixture process guard failed: ' + killed)
    return event

def waveform(rate, channels, bits):
    frames = rate + 49
    integers = bytearray(); floating = bytearray()
    for frame in range(frames):
        for channel in range(channels):
            shape = ((frame * (53 if channel == 0 else 79) + channel * 509) % 4096) - 2048
            value = shape * (1 << (bits - 14)) + ((frame * 1664525 + channel * 1013904223) & 31) - 16
            if frame == 0: value = (1 << (bits - 2)) * (1 if channel == 0 else -1)
            elif frames // 2 <= frame < frames // 2 + 100: value = 0
            elif frame == frames - 1: value = -3 * (1 << (bits - 3)) if channel == 0 else 5 * (1 << (bits - 4))
            integers.extend(int(value).to_bytes(bits // 8, 'little', signed=True))
            floating.extend(struct.pack('<f', value / (1 << (bits - 1))))
    size = len(integers)
    header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + size, b'WAVE', b'fmt ', 16, 1, channels, rate,
                         rate * channels * bits // 8, channels * bits // 8, bits, b'data', size)
    stem = f'generated-{rate}-{channels}ch-{bits}bit'
    wav, raw = ROOT / 'sources' / (stem + '.wav'), ROOT / 'sources' / (stem + '.f32le')
    if not wav.exists(): wav.write_bytes(header + integers); raw.write_bytes(floating)
    return {'wav': str(wav), 'float': str(raw), 'rate': rate, 'channels': channels, 'bits': bits, 'frames': frames,
            'wavSHA256': sha(wav), 'floatSHA256': sha(raw), 'quantization': 'exact generated signed integer PCM; independent reference rounded to Float32'}

def probe(path, name):
    args = [FFPROBE, '-v', 'error', '-select_streams', 'a:0', '-show_entries',
            'stream=codec_name,codec_type,profile,sample_rate,channels,bits_per_raw_sample,duration,nb_frames', '-of', 'json', path]
    event = command(args, 'metadata-' + name)
    if event['exitCode'] != 0: return {'error': 'Existing generator metadata probe failed.'}
    result = json.loads(Path(event['stdout']).read_text())
    return {'tier': 'existing-generator-provisional-metadata-not-oracle', **result}

def main():
    if ROOT.exists(): raise RuntimeError('New fixture output required.')
    if shutil.disk_usage(ROOT.parent).free < RESERVE + MAX_RETAINED: raise RuntimeError('Insufficient fixture disk admission.')
    ROOT.mkdir(mode=0o700)
    for name in ['logs', 'sources', 'candidates', 'bin']: (ROOT / name).mkdir(mode=0o700)
    inventory = json.loads((SETUP / 'existing-fixture-tools.json').read_text())
    for entry in inventory['paths'] + inventory['libavIdentity']:
        if entry.get('sha256') and sha(Path(entry.get('resolved', entry['path']))) != entry['sha256']:
            raise RuntimeError('Existing fixture tool changed: ' + entry['path'])
    compiler = Path('/Library/Developer/CommandLineTools/usr/bin/clang')
    compiler_receipt = {'compiler': str(compiler), 'sha256': sha(compiler), 'ffprobe': str(FFPROBE), 'ffprobeSHA256': sha(FFPROBE),
                        'generatorSourceSHA256': sha(Path(__file__)), 'vorbisSourceSHA256': sha(SETUP / 'vorbis-fixture-encoder.c'),
                        'existingToolReceiptSHA256': sha(SETUP / 'existing-fixture-tools.json'), 'licensing': 'our generated signals only; no tool/product license grant'}
    (ROOT / 'provenance.json').write_text(json.dumps(compiler_receipt, indent=2) + '\n')
    candidates = []
    def add(name, kind, channels, rate=48000, bits=16, profile=None):
        source = waveform(rate, channels, bits)
        suffix = {'mp3': '.mp3', 'flac': '.flac', 'vorbis': '.ogg', 'opus': '.ogg', 'aac': '.aac', 'aac-m4a': '.m4a', 'alac': '.m4a'}[kind]
        candidates.append({'id': name, 'kind': kind, 'source': source, 'profileRequested': profile,
                           'path': str(ROOT / 'candidates' / (name + suffix)), 'expectation': 'positive candidate; not yet qualified by native9/WASM'})
    for channels in [1, 2]:
        add(f'mp3-{channels}', 'mp3', channels, 44100)
        add(f'flac-{channels}', 'flac', channels)
        add(f'vorbis-{channels}', 'vorbis', channels)
        add(f'opus-{channels}', 'opus', channels)
        add(f'adts-lc-{channels}', 'aac', channels, profile='aac_low')
        add(f'adts-he-{channels}', 'aac', channels, profile='aac_he')
        add(f'm4a-lc-{channels}', 'aac-m4a', channels, profile='aac_low')
        add(f'alac-{channels}', 'alac', channels, 44100, 24)
    add('adts-hev2-stereo', 'aac', 2, profile='aac_he_v2')
    add('m4a-edit-stereo', 'aac-m4a', 2, profile='aac_low')
    for rate, bits in [(8000,16),(22050,24),(88200,32),(192000,24)]: add(f'flac-rate-{rate}', 'flac', 1, rate, bits)
    # Two positive rawstream cut candidates derive from declared boundary metadata.
    candidates += [{'id': 'mp3-valid-shorter', 'kind': 'derived', 'base': 'mp3-1', 'path': str(ROOT/'candidates/mp3-valid-shorter.mp3'),
                    'expectation': 'positive shorter raw MP3; base has no Xing/ID3 declared original frame total'},
                   {'id': 'adts-valid-shorter', 'kind': 'derived', 'base': 'adts-lc-1', 'path': str(ROOT/'candidates/adts-valid-shorter.aac'),
                    'expectation': 'positive shorter ADTS cut at complete packet boundary; no declared original total'}]
    if len(candidates) != 24: raise RuntimeError('Preregistered candidate bound mismatch.')
    (ROOT / 'preregistered-matrix.json').write_text(json.dumps(candidates, indent=2) + '\n')
    args = [compiler, '-std=c17', '-D_DARWIN_C_SOURCE', '-O2', '-fno-fast-math', '-ffp-contract=off', '-Wall', '-Wextra', '-Werror',
            '-I/opt/homebrew/Cellar/libvorbis/1.3.7/include', '-I/opt/homebrew/Cellar/libogg/1.3.6/include', SETUP/'vorbis-fixture-encoder.c',
            '-L/opt/homebrew/Cellar/libvorbis/1.3.7/lib', '-L/opt/homebrew/Cellar/libogg/1.3.6/lib', '-lvorbisenc', '-lvorbis', '-logg', '-lm',
            '-o', ROOT/'bin/vorbis-fixture-encoder']
    compiled = command(args, 'compile-vorbis-fixture')
    if compiled['exitCode'] != 0: raise RuntimeError('Fixture encoder compilation RED; preserve before fixing.')
    compiler_receipt['vorbisExecutableSHA256'] = sha(ROOT/'bin/vorbis-fixture-encoder')
    (ROOT / 'provenance.json').write_text(json.dumps(compiler_receipt, indent=2) + '\n')
    for item in candidates:
        path = Path(item['path'])
        if item['kind'] == 'derived':
            base = next(row for row in candidates if row['id'] == item['base'])
            source = Path(base['path'])
            if not source.exists(): item['status'] = 'uncovered-base-encode-failed'; continue
            event = command([FFPROBE,'-v','error','-select_streams','a:0','-show_packets','-show_entries','packet=pos,size','-of','json',source], 'packet-boundaries-'+item['id'])
            packets = json.loads(Path(event['stdout']).read_text()).get('packets',[]) if event['exitCode']==0 else []
            if len(packets)<4: item['status']='uncovered-no-provisional-boundary';continue
            packet=packets[len(packets)//2-1];end=int(packet['pos'])+int(packet['size']);data=source.read_bytes()
            if end<=0 or end>=len(data): raise RuntimeError('Invalid generated prefix boundary.')
            path.write_bytes(data[:end]);path.chmod(0o600)
            item['mutation']={'cutAtByte':end,'originalBytes':len(data),'boundarySource':'existing ffprobe8.1 provisional packet metadata','baseSHA256':sha(source)}
        else:
            source = item['source']; kind = item['kind']
            if kind == 'vorbis': args=[ROOT/'bin/vorbis-fixture-encoder',source['float'],path,str(source['channels']),str(source['rate']),str(source['frames'])]
            else:
                args=[FFMPEG,'-v','error','-nostdin','-n','-threads','1','-filter_threads','1','-filter_complex_threads','1']
                if item['id']=='m4a-edit-stereo':args+=['-itsoffset','0.1']
                args+=['-i',source['wav'],'-map','0:a:0','-map_metadata','-1','-vn','-sn','-dn']
                if kind=='mp3':args+=['-c:a','libmp3lame','-b:a','128k','-write_xing','0' if source['channels']==1 else '1','-id3v2_version','0','-write_id3v1','0','-f','mp3']
                elif kind=='flac':args+=['-c:a','flac','-sample_fmt','s16' if source['bits']==16 else 's32','-bits_per_raw_sample',str(source['bits']),'-f','flac']
                elif kind=='opus':args+=['-c:a','libopus','-b:a','64k' if source['channels']==1 else '128k','-application','audio','-frame_duration','20','-vbr','off','-f','ogg']
                elif kind in ['aac','aac-m4a']:
                    args+=['-c:a','aac_at','-sample_fmt','s16','-profile:a',item['profileRequested'],'-b:a','32k' if item['profileRequested']=='aac_he_v2' else '64k' if item['profileRequested']=='aac_he' else '128k']
                    args+=['-f','adts'] if kind=='aac' else ['-movflags','+faststart','-use_editlist','1','-f','ipod']
                elif kind=='alac':args+=['-c:a','alac','-sample_fmt','s32p','-bits_per_raw_sample','24','-movflags','+faststart','-f','ipod']
                args+=['-threads:a','1',path]
            event=command(args,'encode-'+item['id']);item['encodeEvent']=event
            if event['exitCode']!=0: item['status']='encoder-RED-uncovered';continue
        if not path.is_file() or not 0<path.stat().st_size<=2*1024*1024:raise RuntimeError('Candidate size bound failed.')
        item.update({'status':'generated-unqualified','bytes':path.stat().st_size,'sha256':sha(path),'provisionalMetadata':probe(path,item['id'])})
        if sum(Path(row['path']).stat().st_size for row in candidates if Path(row['path']).exists())>MAX_ENCODED:raise RuntimeError('Encoded aggregate bound failed.')
        (ROOT/'candidate-results.json').write_text(json.dumps(candidates,indent=2)+'\n')
    result={'status':'generated-candidates-only','candidates':len(candidates),'generated':sum(row.get('status')=='generated-unqualified' for row in candidates),
            'encoderREDs':[row['id'] for row in candidates if row.get('status')!='generated-unqualified'],'retainedBytes':usage(),
            'audioDecodedByNewNativeOrWasm':False,'sourceSHA256':sha(Path(__file__))}
    (ROOT/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

if __name__=='__main__':
    main()
