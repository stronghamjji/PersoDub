"""Where the app keeps its work, and what it is working on.

WORKSPACE and the job store used to be defined on app/main.py, and every
router that needed them reached back for them at call time (the `_main()`
seams in app/api/*.py). They live here now, so app/main.py is one more
importer rather than the owner: a router asks app.state, and so does main.

One module for both rather than a paths.py and a state.py: they are the same
fact seen twice. Every job folder is WORKSPACE/<day>/<name>, the store is
filled from WORKSPACE at boot (`job_store.restore(WORKSPACE)`), and the two of
them are the only names all of main, the dub routes, the script routes, the
result downloads and Settings share. Two files for four names would be
ceremony.

WORKSPACE is a plain string, and the tests reassign it (tests/conftest.py
points it at a temp folder for every test). So read it as `state.WORKSPACE` at
call time -- never `from app.state import WORKSPACE`, which takes a copy that
a later reassignment can never reach. Same for `state.job_store`, which one
test replaces wholesale.
"""
import os

from app.jobs import JobStore

# The repo root: this file is app/state.py, so two dirnames up from it.
APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The folder every job's work -- and every finished video -- is saved in.
WORKSPACE = os.path.join(APP_DIR, "workspace")
STATIC_DIR = os.path.join(APP_DIR, "static")

# Store for background dubbing jobs. One per process: the routes that start a
# job, the routes that read one, and the boot-time re-arm all mean this object.
job_store = JobStore()
