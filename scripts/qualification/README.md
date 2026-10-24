# Qualification process ownership

These helpers belong only to bounded local QA runners. Application, audio and HTTP request code must never import them.

`owned_groups.py` and its six controls are copied exactly from the independently accepted private decoder ownership checkpoint. It admits exact Node and detached browser PID, start time, process group and command hash identities, preserves known group continuity after parent changes, refuses unseen members without an anchor and revalidates before bounded signals. Normal exit does not bypass final cleanup.

`observed_process.py` pins an external native host for RSS observations and counts the union once; it never signals that host. Missing or changed identity refuses observation. Parent runners retain primary and cleanup errors separately and never reinterpret uncertainty as a clean exit. Browser launch and pre-Worker admission require the parent acknowledgment before workload execution.

Run the nine synthetic controls with `python3 -m unittest discover -s scripts/qualification -p '*_test.py'`. Actual normal/crash browser controls remain a separate gate.
