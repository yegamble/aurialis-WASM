"""Synthetic detached Python children only; no browser/codec runs."""
import json,os,secrets,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
from owned_groups import OwnedGroups,RefusedMembership,snapshot,command_hash
CHILD='import time;time.sleep(60)'
class Ownership(unittest.TestCase):
 def virtual(self):
  leader={'pid':10,'ppid':2,'pgid':10,'start':'exact leader','rssBytes':10,'state':'S','commandSHA256':'same-command'}
  owned=OwnedGroups.__new__(OwnedGroups);owned.node_pid=10;owned.token='known';owned.leaders={'node':leader};owned.known={10:leader};owned.events=[];owned.admissions=[]
  return owned,leader
 def test_live_exact_leader_admits_reparented_group_member(self):
  owned,leader=self.virtual();orphan={'pid':11,'ppid':1,'pgid':10,'start':'new sibling orphan','rssBytes':20,'state':'S'}
  with mock.patch('owned_groups.command_hash',return_value='same-command'):
   result=owned.observe({10:leader,11:orphan})
  self.assertEqual(result['rssBytes'],30);self.assertEqual(result['newAdmissions'][0]['ground'],'live-exact-admitted-group-leader')
 def test_known_live_anchor_preserves_continuity_after_leader_exit(self):
  owned,_leader=self.virtual();anchor={'pid':11,'ppid':1,'pgid':10,'start':'known exact child','rssBytes':20,'state':'S'};owned.known[11]=anchor
  new={'pid':12,'ppid':1,'pgid':10,'start':'new member','rssBytes':30,'state':'S'};result=owned.observe({11:anchor,12:new})
  self.assertEqual(result['rssBytes'],50);self.assertEqual(result['newAdmissions'][0]['ground'],'known-live-exact-member-continuity')
 def test_no_live_anchor_refuses_unseen_orphan_with_details_and_no_signal(self):
  owned,_leader=self.virtual();orphan={'pid':12,'ppid':1,'pgid':10,'start':'unseen orphan','rssBytes':30,'state':'S'}
  with mock.patch('owned_groups.snapshot',return_value={12:orphan}),mock.patch('owned_groups.os.killpg') as kill:
   with self.assertRaises(RefusedMembership) as result:owned.cleanup()
   self.assertEqual(result.exception.details['refusedRows'],[orphan]);kill.assert_not_called()
 def test_changed_command_can_only_settle_exact_zombie_or_absence(self):
  for fresh in (None,{'pid':10,'ppid':2,'pgid':10,'start':'exact leader','rssBytes':10,'state':'Z'}):
   owned,leader=self.virtual()
   with mock.patch('owned_groups.command_hash',return_value='zombie display'),mock.patch('owned_groups.snapshot',return_value={} if fresh is None else {10:fresh}):
    self.assertEqual(owned.observe({10:leader})['liveMembers'],[])
   self.assertEqual(owned.events[0]['phase'],'confirmed-leader-exit');self.assertEqual(owned.events[0]['before'],leader);self.assertEqual(owned.events[0]['after'],fresh)
 def test_changed_command_with_reused_pid_never_authorizes_signal(self):
  owned,leader=self.virtual();reused={**leader,'start':'reused start','state':'Z'}
  with mock.patch('owned_groups.command_hash',return_value='changed command'),mock.patch('owned_groups.snapshot',side_effect=[{10:leader},{10:reused}]),mock.patch('owned_groups.os.killpg') as kill:
   with self.assertRaisesRegex(RuntimeError,'identity changed'):owned.cleanup()
   kill.assert_not_called();self.assertEqual(owned.events,[])
 def test_changed_live_command_never_authorizes_signal(self):
  owned,leader=self.virtual()
  with mock.patch('owned_groups.command_hash',return_value='changed live command'),mock.patch('owned_groups.snapshot',return_value={10:leader}),mock.patch('owned_groups.os.killpg') as kill:
   with self.assertRaisesRegex(RuntimeError,'identity changed'):owned.cleanup()
   kill.assert_not_called()
 def make(self,root,stop_between_spawn_and_assignment=False):
  # Monitoring must work before a process can exist outside this setup scope.
  rows=snapshot()
  if os.getpid() not in rows or command_hash(os.getpid()) is None:
   raise RuntimeError('Synthetic parent process monitoring preflight failed.')
  path=root/'candidate.json';ack=root/'node-ack.txt';token=secrets.token_hex(16)
  code="""import json,os,pathlib,signal,subprocess,sys,time
child=None;stopping=False
def stop(_signal,_frame):
 global stopping
 stopping=True
signal.signal(signal.SIGTERM,stop)
try:
 ack=pathlib.Path(sys.argv[2]);deadline=time.monotonic()+3
 while not ack.exists():
  if stopping:raise SystemExit(0)
  if time.monotonic()>deadline:raise RuntimeError('Parent admission acknowledgement timeout.')
  time.sleep(.01)
 if ack.read_text()!=sys.argv[3]:raise RuntimeError('Parent admission acknowledgement mismatch.')
 if stopping:raise SystemExit(0)
 def launch():
  spawned=subprocess.Popen([sys.executable,'-c',sys.argv[4]],start_new_session=True)
  if sys.argv[5]=='hold':
   pathlib.Path(sys.argv[1]).with_name('spawned.json').write_text(json.dumps({'nodePID':os.getpid(),'browserPID':spawned.pid}))
   while not stopping:time.sleep(.01)
  return spawned
 child=launch()
 if stopping:raise SystemExit(0)
 pathlib.Path(sys.argv[1]).write_text(json.dumps({'nodePID':os.getpid(),'browserPID':child.pid,'token':sys.argv[3]}))
 deadline=time.monotonic()+60
 while not stopping and time.monotonic()<deadline:time.sleep(.01)
finally:
 if child is not None:
  if child.poll() is None:child.terminate()
  try:child.wait(timeout=2)
  except subprocess.TimeoutExpired:
   child.kill();child.wait(timeout=2)
"""
  node=None;owned=None
  try:
   node=subprocess.Popen([sys.executable,'-c',code,str(path),str(ack),token,CHILD,'hold' if stop_between_spawn_and_assignment else 'normal'],start_new_session=True)
   owned=OwnedGroups(node.pid,os.getpid(),token)
   # The child cannot spawn its detached process until this exact admission.
   ack.write_text(token)
   if stop_between_spawn_and_assignment:
    until=time.monotonic()+3
    while not (root/'spawned.json').exists():
     if time.monotonic()>until:raise RuntimeError('Held assignment handshake timeout.')
     time.sleep(.01)
    node.terminate()
   until=time.monotonic()+3
   while not path.exists():
    if node.poll() is not None:raise RuntimeError('Synthetic parent exited before handshake.')
    if time.monotonic()>until:raise RuntimeError('Synthetic child handshake timeout.')
    time.sleep(.01)
   candidate=json.loads(path.read_text());owned.admit_browser(candidate)
   return node,owned,candidate
  except BaseException as primary:
   cleanup=[]
   if owned is not None:
    try:owned.cleanup()
    except Exception as error:cleanup.append(str(error))
   if node is not None:
    # Popen is our direct child even when ps admission fails. Before ACK it
    # cannot spawn; after ACK its own finally terminates/reaps its direct child.
    try:
     if node.poll() is None:node.terminate()
     node.wait(timeout=5)
    except Exception as error:cleanup.append(str(error))
   if cleanup:raise RuntimeError('Synthetic setup cleanup failed: '+'; '.join(cleanup)) from primary
   raise
 def finish(self,node,owned):
  try:owned.cleanup()
  finally:
   if node.poll() is None:node.terminate()
   node.wait(timeout=5)
 def test_monitor_denial_precedes_popen(self):
  with tempfile.TemporaryDirectory() as d:
   with mock.patch(__name__+'.snapshot',side_effect=PermissionError('synthetic preflight denial')),mock.patch('subprocess.Popen') as popen:
    with self.assertRaisesRegex(PermissionError,'synthetic preflight denial'):self.make(Path(d))
    popen.assert_not_called();self.assertEqual(list(Path(d).iterdir()),[])
 def test_admission_failure_reaps_direct_child_before_ack(self):
  with tempfile.TemporaryDirectory() as d:
   real_popen=subprocess.Popen;children=[]
   def capture(*args,**kwargs):
    child=real_popen(*args,**kwargs);children.append(child);return child
   with mock.patch('subprocess.Popen',side_effect=capture),mock.patch(__name__+'.OwnedGroups',side_effect=PermissionError('synthetic admission denial')):
    with self.assertRaisesRegex(PermissionError,'synthetic admission denial'):self.make(Path(d))
   # The ps subprocesses have also been reaped. Only our session child could
   # create a detached descendant, and it never received an acknowledgement.
   self.assertTrue(children);self.assertTrue(all(child.poll() is not None for child in children))
   self.assertFalse((Path(d)/'node-ack.txt').exists());self.assertFalse((Path(d)/'candidate.json').exists())
 def test_browser_admission_failure_reaps_parent_and_detached_child(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   with mock.patch.object(OwnedGroups,'admit_browser',side_effect=PermissionError('synthetic browser admission denial')):
    with self.assertRaisesRegex(PermissionError,'synthetic browser admission denial'):self.make(root)
   candidate=json.loads((root/'candidate.json').read_text())
   rows=snapshot()
   self.assertNotIn(candidate['nodePID'],rows)
   self.assertNotIn(candidate['browserPID'],rows)
 def test_term_after_spawn_before_assignment_still_reaps_both_children(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d)
   with self.assertRaisesRegex(RuntimeError,'Synthetic parent exited before handshake'):self.make(root,stop_between_spawn_and_assignment=True)
   spawned=json.loads((root/'spawned.json').read_text());rows=snapshot()
   self.assertNotIn(spawned['nodePID'],rows);self.assertNotIn(spawned['browserPID'],rows)
 def test_detached_child_survives_node_crash_then_both_groups_clean(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,candidate=self.make(Path(d))
   try:
    before=owned.observe();self.assertEqual(len(before['groups']),2);self.assertEqual(len({r['pid'] for r in before['members']}),len(before['members']))
    os.killpg(node.pid,signal.SIGKILL);node.wait(timeout=3)
    live=snapshot()[candidate['browserPID']];self.assertNotEqual(live['ppid'],node.pid)
    self.assertIn(candidate['browserPID'],[r['pid'] for r in owned.observe()['liveMembers']])
    self.assertEqual(owned.cleanup()['liveMembers'],[])
   finally:
    self.finish(node,owned)
 def test_monitor_exception_keeps_primary_and_stops_both_owned_groups(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,_candidate=self.make(Path(d));primary=None;cleanup=None
   try:
    try:raise PermissionError('synthetic monitor denial')
    except PermissionError as error:primary=str(error)
    finally:
     try:owned.cleanup()
     except Exception as error:cleanup=str(error)
    self.assertEqual(primary,'synthetic monitor denial');self.assertIsNone(cleanup);self.assertEqual(owned.observe()['liveMembers'],[])
   finally:self.finish(node,owned)
 def test_token_and_changed_identity_never_authorize_signals(self):
  with tempfile.TemporaryDirectory() as d:
   node,owned,candidate=self.make(Path(d))
   try:
    with self.assertRaisesRegex(RuntimeError,'token'):owned.admit_browser({**candidate,'token':'unowned'})
    observed=snapshot();expected=owned.leaders['browser'];observed[expected['pid']]={**observed[expected['pid']],'start':'different start identity'}
    with mock.patch('owned_groups.snapshot',return_value=observed),mock.patch('owned_groups.os.killpg') as kill:
     with self.assertRaisesRegex(RuntimeError,'identity changed'):owned.cleanup()
     kill.assert_not_called()
   finally:self.finish(node,owned)
if __name__=='__main__':unittest.main()
