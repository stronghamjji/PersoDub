"""The app itself: the FastAPI object, its two middlewares, the static mounts,
the page, the health check, and the routers every endpoint now lives in.

Nothing here answers an /api route any more. The endpoints moved out into
app/api/*.py over 2026-09-06, and with them went the names they needed: the
workspace folder and the job store are app/state.py's, and each router imports
what it uses from the module that owns it. That is why this file no longer
imports run_dub, the engine checks or the Perso client -- and why nothing
reads anything back off this module at call time.

The one thing left with any behaviour is the boot-time re-arm below: on
startup the store is read back off disk and jobs that were queued when the app
last closed are put back in line (app/api/dub.py's rearm_queued_jobs, which is
where the work they are queued with is built).
"""
import os
from contextlib import asynccontextmanager
from urllib.parse import urlparse

from fastapi import FastAPI, Response
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import state
from app.api import agent as agent_api
from app.api import clips as clips_api
from app.api import dub as dub_api
from app.api import misc as misc_api
from app.api import models as models_api
from app.api import results as results_api
from app.api import script as script_api
from app.api import settings as settings_api
from app.perso_client import APP_VERSION


@asynccontextmanager
async def lifespan(_app):
    """Jobs from before this launch.

    The job store is a dictionary, so quitting the app used to lose every
    record even though the folders were all still there. Reading the job.json
    files back is what lets Projects reopen yesterday's work.

    On startup rather than at import: the workspace is read when the server
    actually starts, so a test that redirects it (tests/conftest.py) is not
    racing an import that already scanned the real one. Best-effort by design
    -- a workspace that isn't there yet simply restores nothing, and one bad
    file is skipped rather than taking the app down.
    """
    state.job_store.restore(state.WORKSPACE)
    dub_api.rearm_queued_jobs()
    yield


app = FastAPI(title="PersoDub", version=APP_VERSION, lifespan=lifespan)
# GET /api/settings returns saved API key values (single-user desktop app, the
# user owns the file they live in). That makes DNS rebinding the one remote
# read path -- a hostile page whose domain re-resolves to 127.0.0.1 becomes
# same-origin with this server in the victim's browser -- and its requests
# arrive with the attacker's domain in Host, so a strict allowlist shuts it
# out. (Tests pass base_url="http://127.0.0.1" so no test-only host ships here.)
app.add_middleware(TrustedHostMiddleware,
                   allowed_hosts=["127.0.0.1", "localhost"])


# TrustedHost can't stop cross-origin WRITES: a hostile page POSTing to
# 127.0.0.1 sends Host: 127.0.0.1 (passes the allowlist) and, without CORS
# middleware, the browser withholds the response but the side effect still
# fires -- e.g. swapping in an attacker's Perso key via /api/settings.
# Browsers always attach Origin to cross-origin POSTs, so rejecting foreign
# Origins closes that; requests without Origin (our Electron UI same-origin
# GETs, curl, tests) are untouched.
@app.middleware("http")
async def reject_cross_origin_writes(request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost"):
            return Response("Cross-origin requests are not allowed", status_code=403)
    return await call_next(request)


# Every endpoint the app answers on. The URLs are unchanged by the move; the
# list they add up to is pinned in tests/test_routes_table.py, which is what
# notices a router that quietly stops being mounted.
app.include_router(agent_api.router)
app.include_router(clips_api.router)
app.include_router(dub_api.router)
app.include_router(misc_api.router)
app.include_router(models_api.router)
app.include_router(results_api.router)
app.include_router(script_api.router)
app.include_router(settings_api.router)


# Serves the UI's plumbing-layer JS module (ui/src/dubApi.mjs) so static/index.html
# can import it directly, e.g. <script type="module" src="/js/dubApi.mjs">. Mounted
# straight from ui/src (not copied into static/) so there is a single source of
# truth -- the same file the node:test unit tests in ui/src/dubApi.test.mjs cover.
app.mount("/js", StaticFiles(directory=os.path.join(state.APP_DIR, "ui", "src")), name="js")


@app.get("/", response_class=HTMLResponse)
def index():
    """Dubbing app screen."""
    with open(os.path.join(state.STATIC_DIR, "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/health")
def health():
    """Health check to confirm the app is alive."""
    return {"status": "ok"}
