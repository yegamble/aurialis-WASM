"""Only reuse exact closed-profile libraries from retained native01 compile RED."""
import hashlib,json,os,shutil,stat
from pathlib import Path
INVENTORY_SHA256 = "9651ce143b8f9b780556a9f7982235fa050864b06c1875176cd276f9d4fb2f93"

def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for part in iter(lambda:f.read(1048576),b''):h.update(part)
 return h.hexdigest()

def headers(root,expected):
 entries=[];dirs=0;total=0
 for base,names,files in os.walk(root,followlinks=False):
  for name in sorted(names+files):
   p=Path(base)/name;s=p.lstat()
   if stat.S_ISREG(s.st_mode):
    total+=s.st_size
    if total>expected['bytes'] or len(entries)>=expected['files']:raise RuntimeError('Header bounds changed.')
    entries.append([str(p.relative_to(root)),s.st_size,digest(p)])
   elif stat.S_ISDIR(s.st_mode):
    dirs+=1
    if dirs>expected['dirs']:raise RuntimeError('Header directory count changed.')
   else:raise RuntimeError('Unexpected header link/special file.')
 actual={'bytes':total,'files':len(entries),'dirs':dirs,'contentLayoutSHA256':hashlib.sha256(json.dumps(sorted(entries),separators=(',',':')).encode()).hexdigest()}
 if actual!=expected:raise RuntimeError('Header content changed.')
 return actual

recipe=Path('/recipe');previous=Path('/previous');output=Path('/output')
inventory=recipe/'reuse-native01.json'
if digest(inventory)!=INVENTORY_SHA256:raise RuntimeError('Native01 immutable inventory changed.')
proof=json.loads(inventory.read_text())
for record in proof['records']:
 relative=Path(record['path'])
 if relative.is_absolute() or '..' in relative.parts:raise RuntimeError('Invalid native input path.')
 source=previous/relative
 if not stat.S_ISREG(source.lstat().st_mode) or source.stat().st_size!=record['bytes'] or digest(source)!=record['sha256']:raise RuntimeError('Native01 input changed: '+str(relative))
 target=output/relative;target.parent.mkdir(parents=True,exist_ok=True)
 # Preserve the original failed build receipt separately from this driver's receipt.
 if relative.name=='build-status.json':target=output/'native01-failed-build-status.json'
 shutil.copyfile(source,target)
 if digest(target)!=record['sha256']:raise RuntimeError('Native input copy changed.')
status=json.loads((previous/'build-status.json').read_text())
if status.get('exitCode')!=1 or status.get('resourceFailure') or status.get('timedOut') or status.get('cleanupError') or status.get('containerState',{}).get('OOMKilled'):raise RuntimeError('Native01 unexpected failure state.')
expected=proof['headers'];before=headers(previous/'install/include',expected)
shutil.copytree(previous/'install/include',output/'install/include',symlinks=False)
after=headers(output/'install/include',expected)
(output/'native-reuse-inputs.json').write_text(json.dumps({'inventorySHA256':INVENTORY_SHA256,'records':proof['records'],'headerBefore':before,'headerAfter':after},indent=2)+'\n')
