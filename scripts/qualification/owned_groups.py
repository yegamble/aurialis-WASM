"""Private harness ownership only. Never imported by application/audio request code."""
import hashlib,os,signal,subprocess,time
from qualification_clock import remaining
def snapshot():
 result=subprocess.run(['/bin/ps','-axo','pid=,ppid=,pgid=,lstart=,rss=,state='],capture_output=True,text=True,timeout=remaining(3),check=True,env={**os.environ,'LC_ALL':'C'})
 rows={}
 for line in result.stdout.splitlines():
  parts=line.split()
  if len(parts)!=10:raise RuntimeError('Process snapshot parse failed closed.')
  pid,ppid,pgid=map(int,parts[:3]);rows[pid]={'pid':pid,'ppid':ppid,'pgid':pgid,'start':' '.join(parts[3:8]),'rssBytes':int(parts[8])*1024,'state':parts[9]}
 return rows
def command_hash(pid):
 result=subprocess.run(['/bin/ps','-p',str(pid),'-o','command='],capture_output=True,text=True,timeout=remaining(3),check=False)
 if result.returncode==1 and not result.stdout.strip():return None
 if result.returncode:raise RuntimeError('Owned leader command observation failed.')
 if not result.stdout.strip():raise RuntimeError('Owned leader command disappeared.')
 return hashlib.sha256(result.stdout.strip().encode()).hexdigest()
def same(a,b):return (a['pid'],a['pgid'],a['start'])==(b['pid'],b['pgid'],b['start'])
class RefusedMembership(RuntimeError):
 def __init__(self,rows,groups,anchors):
  super().__init__('Unproved member of owned group; no group signal authorized.')
  self.details={'refusedRows':rows,'groups':sorted(groups),'knownLiveAnchors':anchors}
class OwnedGroups:
 def __init__(self,node_pid,parent_pid,token):
  rows=snapshot();node=rows.get(node_pid)
  if not node or node['ppid']!=parent_pid or node['pgid']!=node_pid:raise RuntimeError('Owned Node session admission failed.')
  command=command_hash(node_pid)
  if command is None:raise RuntimeError('Owned Node exited before admission.')
  self.token=token;self.node_pid=node_pid;self.leaders={'node':{**node,'commandSHA256':command}};self.known={node_pid:node};self.events=[];self.admissions=[]
 def admit_browser(self,candidate):
  if candidate.get('token')!=self.token or candidate.get('nodePID')!=self.node_pid or 'browser' in self.leaders:raise RuntimeError('Browser ownership token/repeated admission rejected.')
  pid=candidate.get('browserPID')
  if not isinstance(pid,int) or pid<=1 or pid==self.node_pid:raise RuntimeError('Invalid owned Browser PID.')
  rows=snapshot();node=rows.get(self.node_pid);browser=rows.get(pid)
  if not node or not same(node,self.leaders['node']) or not browser or browser['ppid']!=self.node_pid or browser['pgid']!=pid:raise RuntimeError('Browser PID/PPID/PGID admission failed.')
  command=command_hash(pid)
  if command is None:raise RuntimeError('Owned Browser exited before admission.')
  self.leaders['browser']={**browser,'commandSHA256':command};self.known[pid]=browser
  self.observe(rows)
  return {'token':self.token,'nodePID':self.node_pid,'browserPID':pid,'browserPGID':browser['pgid'],'browserStart':browser['start']}
 def observe(self,rows=None):
  rows=snapshot() if rows is None else rows;groups={x['pgid'] for x in self.leaders.values()};live_leaders={}
  for name,expected in self.leaders.items():
   current=rows.get(expected['pid'])
   if current and not same(current,expected):raise RuntimeError('Owned leader identity changed; no signal authorized.')
   if current and 'Z' not in current['state']:
    command=command_hash(current['pid'])
    if command is None or command!=expected['commandSHA256']:
     # macOS can replace an exiting command with its zombie display name.
     # Only an absent or exact-identity zombie may settle this observation;
     # a changed live command still refuses every subsequent group signal.
     fresh=snapshot().get(current['pid'])
     if fresh is None or (same(fresh,expected) and 'Z' in fresh['state']):
      self.events.append({'phase':'confirmed-leader-exit','leader':name,'before':dict(current),'after':None if fresh is None else dict(fresh),'observedCommandSHA256':command})
      if fresh is None:rows.pop(current['pid'],None);current=None
      else:rows[fresh['pid']]=fresh;current=fresh
     elif command is None:raise RuntimeError('Owned leader exit observation did not settle.')
     else:raise RuntimeError('Owned leader identity changed; no signal authorized.')
   if name=='browser' and current and self.node_pid in rows and 'Z' not in rows[self.node_pid]['state'] and current['ppid']!=self.node_pid:raise RuntimeError('Live Node lost Browser parent relationship.')
   if current and 'Z' not in current['state']:live_leaders[current['pgid']]=current['pid']
  selected={pid:r for pid,r in rows.items() if r['pgid'] in groups}
  anchors={}
  for row in selected.values():
   old=self.known.get(row['pid'])
   if old and not same(row,old):raise RuntimeError('Known member identity changed; no signal authorized.')
   if old and same(row,old) and 'Z' not in row['state']:anchors.setdefault(row['pgid'],row['pid'])
  new_admissions=[]
  def proved(row,seen):
   if row['pid'] in seen:return False
   old=self.known.get(row['pid'])
   if old and same(row,old):return True
   parent=selected.get(row['ppid'])
   if parent and proved(parent,seen|{row['pid']}):ground='current-parent-chain';anchor=parent['pid']
   elif row['pgid'] in live_leaders:ground='live-exact-admitted-group-leader';anchor=live_leaders[row['pgid']]
   elif row['pgid'] in anchors:ground='known-live-exact-member-continuity';anchor=anchors[row['pgid']]
   else:return False
   new_admissions.append({'pid':row['pid'],'pgid':row['pgid'],'start':row['start'],'ground':ground,'anchorPID':anchor})
   return True
  refused=[]
  for row in selected.values():
   if not proved(row,set()):refused.append(row)
  if refused:raise RefusedMembership(refused,groups,anchors)
  unique_admissions={x['pid']:x for x in new_admissions}
  if len(set(self.known)|set(selected))>4096 or len(self.admissions)+len(unique_admissions)>4096:raise RuntimeError('Owned identity bookkeeping quota exceeded.')
  self.admissions.extend(unique_admissions.values())
  self.known.update(selected)
  live=[r for r in selected.values() if 'Z' not in r['state']]
  return {'groups':sorted(groups),'members':list(selected.values()),'liveMembers':live,'newAdmissions':list(unique_admissions.values()),'rssBytes':sum(r['rssBytes'] for r in live)}
 def cleanup(self):
  # Revalidate each unique group immediately before signaling. A reparented
  # Browser keeps its admitted PID/start/PGID and token; new identities refuse.
  for sig,wait in ((signal.SIGTERM,2),(signal.SIGKILL,3)):
   observed=self.observe();self.events.append({'phase':'before-signal','signal':int(sig),'observation':observed})
   if not observed['liveMembers']:return self.observe()
   for group in observed['groups']:
    check=self.observe()
    if any(row['pgid']==group for row in check['liveMembers']):
     try:os.killpg(group,sig)
     except ProcessLookupError:pass
   until=time.monotonic()+remaining(wait)
   while time.monotonic()<until:
    observed=self.observe()
    if not observed['liveMembers']:self.events.append({'phase':'stopped','observation':observed});return observed
    time.sleep(remaining(.025))
  observed=self.observe();self.events.append({'phase':'cleanup-unsettled','observation':observed})
  raise RuntimeError('Owned groups still have live members after bounded cleanup.')
