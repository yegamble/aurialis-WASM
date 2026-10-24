"""Encode the same planned FLAC32 candidate using existing libFLAC; never decode."""
import hashlib,importlib.util,json,struct
from pathlib import Path
SETUP=Path('/private/tmp/aurialis-private-decoder-setup')
OLD=Path('/private/tmp/aurialis-private-decoder-fixtures-02')
NEW=Path('/private/tmp/aurialis-private-decoder-fixtures-03')
spec=importlib.util.spec_from_file_location('fixture_generation',SETUP/'generate-fixtures.py');g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.ROOT=NEW;g.events=[]
if NEW.exists():raise RuntimeError('New FLAC32 output required.')
NEW.mkdir(mode=0o700)
for name in ['logs','sources','candidates']:(NEW/name).mkdir(mode=0o700)
baseline=sum(p.stat().st_size for d in [Path('/private/tmp/aurialis-private-decoder-fixtures-01'),OLD] for p in d.rglob('*') if p.is_file())
g.MAX_RETAINED-=baseline
rows=json.loads((OLD/'candidate-results.json').read_text());row=next(x for x in rows if x['id']=='flac-rate-88200')
source=Path(row['source']['wav'])
if g.sha(source)!=row['source']['wavSHA256']:raise RuntimeError('Original generated S32 source changed.')
raw=bytearray(source.read_bytes()[44:]);edges=[-2147483648,-2147483647,2147483647,2147483646,0,1,-1,16777215,16777216,16777217,16777219,1073741823,1073741824,1073741887,1073741888,1073741889,1073741951,1073741952,1073741953,-1073741887,-1073741888,-1073741889]
for i,value in enumerate(edges):struct.pack_into('<i',raw,i*4,value)
reference=bytearray()
for (value,) in struct.iter_unpack('<i',raw):reference+=struct.pack('<f',value/2147483648)
if not any(value & 255 for (value,) in struct.iter_unpack('<i',raw)):raise RuntimeError('Missing low8-bit coverage.')
input_path=NEW/'sources/generated-88200-1ch-s32le.raw';input_path.write_bytes(raw);input_path.chmod(0o600)
ref=NEW/'sources/expected-88200-1ch.f32le';ref.write_bytes(reference);ref.chmod(0o600)
output=NEW/'candidates/flac-rate-88200.flac'
flac=Path('/opt/homebrew/bin/flac');provenance=json.loads((SETUP/'flac-fixture-provenance.json').read_text())
if g.sha(flac)!=provenance['sha256']:raise RuntimeError('FLAC generator changed.')
files=[Path('/opt/homebrew/Cellar/flac/1.5.0/lib/libFLAC.14.dylib'),Path('/opt/homebrew/lib/libogg.0.dylib')]
files+=sorted(Path('/opt/homebrew/Cellar/flac/1.5.0/include/FLAC').glob('*.h'))
files+=list(Path('/opt/homebrew/Cellar/flac/1.5.0').glob('COPYING*'))
provenance['libraryHeadersNotices']=[{'path':str(p.resolve()),'bytes':p.stat().st_size,'sha256':g.sha(p)} for p in files if p.is_file()]
args=[flac,'--silent','--force-raw-format','--sign=signed','--endian=little','--bps=32','--channels=1','--sample-rate=88200','-j1','--no-padding','--no-seektable','--no-preserve-modtime','--output-name='+str(output),input_path]
plan={'sameCandidateID':row['id'],'reason':'prior FFmpeg fixture encoded24-bit; existing libFLAC supports32-bit','sourceRevision':'adds declared exactS32 extreme/tie/low-bit vector, prior source+24-coded file retained',
 'originalSource':row['source'],'raw':str(input_path),'rawSHA256':g.sha(input_path),'reference':str(ref),'referenceSHA256':g.sha(ref),'referenceRule':'exact signed integer divided by2^31, then IEEE754binary32 round-to-nearest-even; no24-bit intermediate',
 'edges':edges,'frames':len(raw)//4,'rate':88200,'channels':1,'bits':32,'command':[str(a) for a in args],'generator':provenance,'scriptSHA256':g.sha(Path(__file__))}
(NEW/'preregistered-flac32.json').write_text(json.dumps(plan,indent=2)+'\n')
event=g.command(args,'encode-flac32-existing-xiph')
if event['exitCode']!=0:raise RuntimeError('FLAC32 encode RED, preserve before fixing.')
data=output.read_bytes()
if not 42<=len(data)<=2*1024*1024 or data[:4]!=b'fLaC' or data[4]&127 or int.from_bytes(data[5:8],'big')!=34:raise RuntimeError('Unexpected generated STREAMINFO geometry.')
packed=int.from_bytes(data[18:26],'big');info={'sampleRate':packed>>44,'channels':((packed>>41)&7)+1,'bitsPerSample':((packed>>36)&31)+1,'totalSamples':packed&((1<<36)-1)}
if info!={'sampleRate':88200,'channels':1,'bitsPerSample':32,'totalSamples':len(raw)//4}:raise RuntimeError('FLAC32 STREAMINFO mismatches request.')
row.update({'path':str(output),'status':'generated-unqualified','bytes':len(data),'sha256':g.sha(output),'streamInfo':info,'source':{'raw':str(input_path),'float':str(ref),'rate':88200,'channels':1,'bits':32,'frames':len(raw)//4,'rawSHA256':g.sha(input_path),'floatSHA256':g.sha(ref)},'losslessSourceComparisonEligible':True,'priorQuantizedCandidateRetained':True})
(NEW/'candidate-results.json').write_text(json.dumps(rows,indent=2)+'\n')
result={'status':'generated-candidates-only','uniqueCandidateIDs':len(rows),'generated':sum(x.get('status')=='generated-unqualified' for x in rows),'uncovered':[x['id'] for x in rows if x.get('status')!='generated-unqualified'],'streamInfo32':info,'combinedRetainedBytes':baseline+g.usage(),'newNativeOrWasmDecode':False}
(NEW/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
