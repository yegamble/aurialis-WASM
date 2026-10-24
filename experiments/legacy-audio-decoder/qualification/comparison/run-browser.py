"""Owned actual-browser runner supervisor; no audio commands run until Chair release."""
import hashlib,json,os,resource,shutil,signal,subprocess,sys,time
from pathlib import Path
NODE=Path('/Users/yosefgamble/.nvm/versions/node/v26.12.0/bin/node')
def usage(root):return sum(p.stat().st_size for p in root.rglob('*') if p.is_file())
def limits():resource.setrlimit(resource.RLIMIT_CPU,(900,900));resource.setrlimit(resource.RLIMIT_CORE,(0,0))
def main():
 if len(sys.argv)!=7:raise SystemExit('Usage: run-browser.py FIXTURES NATIVE_RESULTS RUNTIME05 NEW_OUTPUT MATRIX_PIN REPO')
 fixtures,native,runtime,output=map(Path,sys.argv[1:5]);pin=sys.argv[5];repo=Path(sys.argv[6]);matrix_path=fixtures/'matrix.json'
 if any(p.is_symlink() for p in (fixtures,native,runtime,output,Path(__file__),fixtures/'inputs',fixtures/'references',fixtures/'recipe',runtime/'assets')):raise RuntimeError('No source/stage symlinks before path resolution.')
 if output.exists():raise RuntimeError('Fresh browser output required.')
 if matrix_path.is_symlink() or hashlib.sha256(matrix_path.read_bytes()).hexdigest()!=pin:raise RuntimeError('Frozen matrix mismatch.')
 matrix=json.loads(matrix_path.read_text());recipe=fixtures/'recipe';script=recipe/'run-wasm.mjs'
 if matrix['retainedBudget']['baselineBytes']+matrix['retainedBudget']['nativePartitionBytes']+matrix['retainedBudget']['wasmPartitionBytes']+matrix['retainedBudget']['supervisorAndReceiptBytes']>512*1024**2:raise RuntimeError('Shared512MiB total retained comparison admission failed.')
 if usage(native)>matrix['retainedBudget']['nativePartitionBytes']:raise RuntimeError('Native result partition exceeded.')
 if recipe.is_symlink() or script.is_symlink() or hashlib.sha256(script.read_bytes()).hexdigest()!=next(r['sha256'] for r in matrix['recipe'] if r['file']=='run-wasm.mjs'):raise RuntimeError('Frozen browser recipe mismatch.')
 # Node owns its fresh output; receipts/logs live in a separate fresh supervisor directory.
 logs=output.with_name(output.name+'-supervisor')
 if logs.exists():raise RuntimeError('Fresh supervisor receipt directory required.')
 logs.mkdir(mode=0o700)
 if shutil.disk_usage(logs).free<6*1024**3+matrix['retainedBudget']['wasmPartitionBytes']:raise RuntimeError('Browser disk admission failed.')
 receipt={'matrixSHA256':pin,'args':[str(NODE),str(script),str(fixtures),str(native),str(runtime),str(output),pin,str(repo)],'limits':{'suiteSeconds':900,'sampledGroupRSSBytes':4*1024**3,'outputBytes':matrix['retainedBudget']['wasmPartitionBytes'],'logBytes':1024**2,'hostReserveBytes':6*1024**3},'primaryFailure':None,'cleanupError':None}
 proc=None;start=time.monotonic();maximum_rss=0
 def persist():(logs/'driver.json').write_text(json.dumps(receipt,indent=2)+'\n')
 try:
  with (logs/'stdout.log').open('xb') as out,(logs/'stderr.log').open('xb') as err:
   proc=subprocess.Popen(receipt['args'],stdout=out,stderr=err,start_new_session=True,preexec_fn=limits);receipt['pid']=proc.pid;persist()
   while proc.poll() is None:
    sampled=subprocess.run(['/bin/ps','-g',str(proc.pid),'-o','rss='],capture_output=True,text=True,timeout=2)
    if sampled.returncode and proc.poll() is None:raise RuntimeError('Browser RSS monitor unavailable.')
    rss=sum(int(x)*1024 for x in sampled.stdout.split());maximum_rss=max(maximum_rss,rss)
    if time.monotonic()-start>900:raise RuntimeError('Browser suite watchdog.')
    if rss>4*1024**3:raise RuntimeError('Browser sampled RSS guard.')
    if usage(logs)>1024**2 or (output.exists() and usage(output)>matrix['retainedBudget']['wasmPartitionBytes']):raise RuntimeError('Browser output/log guard.')
    if shutil.disk_usage(logs).free<6*1024**3:raise RuntimeError('Browser host reserve guard.')
    time.sleep(.1)
   proc.wait(timeout=5)
 except BaseException as error:receipt['primaryFailure']=type(error).__name__+': '+str(error)
 finally:
  if proc:
   try:
    # Always terminate the owned session group, including orphan browser children
    # after a Node failure. No unrelated process/session is signaled.
    try:os.killpg(proc.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    proc.wait(timeout=10)
   except BaseException as error:receipt['cleanupError']=type(error).__name__+': '+str(error)
  receipt.update({'exitCode':proc.returncode if proc else None,'elapsedSeconds':round(time.monotonic()-start,3),'sampledMaximumGroupRSSBytes':maximum_rss})
  receipt['status']='pass' if receipt['exitCode']==0 and not receipt['primaryFailure'] and not receipt['cleanupError'] else 'red';persist();print(json.dumps(receipt,indent=2))
 return 0 if receipt['status']=='pass' else 1
if __name__=='__main__':raise SystemExit(main())
