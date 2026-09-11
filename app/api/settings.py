"""Settings: the saved API keys, the Perso workspace picker, and the button
that opens the folder finished videos are saved in.

Lifted out of app/main.py unchanged (2026-09-06). WORKSPACE is the one name
shared with the rest of the app; it lives in app/state.py and is read as
state.WORKSPACE at CALL time, never copied into a name of our own -- the tests
reassign it (tests/conftest.py) and a copy would never see that.
"""
import os
import subprocess
import sys
import time
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import state
from app.perso_client import APP_VERSION, SIGNUP_LINK, list_dubbing_spaces
from app.settings_env import (
    current_value,
    read_analytics_off,
    read_key_status,
    read_reports_off,
    read_value,
    write_analytics_off,
    write_keys,
    write_reports_off,
)

router = APIRouter()


class SettingsRequest(BaseModel):
    gemini_api_key: Optional[str] = None
    perso_api_key: Optional[str] = None
    perso_space_seq: Optional[str] = None
    analytics_off: Optional[bool] = None
    reports_off: Optional[bool] = None


@router.get("/api/settings")
def settings_get():
    """The saved keys and Perso workspace from kit.env, values included, plus
    the folder this app keeps its jobs in.

    Values come back verbatim (user decision 2026-08-06): this is a
    single-user desktop app and the keys live in a file that user owns, so
    hiding them behind set/unset booleans only made a saved key look like an
    empty field. Localhost-only exposure comes from the 127.0.0.1 bind; the
    TrustedHost middleware above adds the DNS-rebinding defense on top --
    changing the bind to 0.0.0.0 WOULD expose these values."""
    status = read_key_status()
    if status is None:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    # perso_signup_link carries the UTM tag, which is built from the running platform --
    # the static page can't know it, so it comes from here.
    return {"gemini_key_set": status["GEMINI_API_KEY"], "perso_key_set": status["PERSO_API_KEY"],
            "gemini_api_key": read_value("GEMINI_API_KEY"),
            "perso_api_key": read_value("PERSO_API_KEY"),
            "perso_space_seq": read_value("PERSO_SPACE_SEQ"),
            "perso_signup_link": SIGNUP_LINK,
            "analytics_off": read_analytics_off(),
            "reports_off": read_reports_off(),
            # The folder every finished video is saved in. Only the server knows
            # it -- the desktop shell can point the workspace anywhere -- so the
            # screen cannot tell the user where their videos are without this.
            "workspace": state.WORKSPACE,
            "app_version": APP_VERSION}


@router.post("/api/settings")
def settings_post(body: SettingsRequest):
    """Write non-empty API keys (and the picked Perso workspace) into kit.env,
    backing it up first.

    Nothing here needs a restart any more: every reader of these three values
    goes through settings_env.current_value, which reads kit.env at use time,
    so the next dub already uses what was just saved. restart_required stays in
    the response as a False for older clients that still look for it."""
    space = None if body.perso_space_seq is None else body.perso_space_seq.strip()
    # The picker only ever posts a seq it got from /api/perso/spaces; anything
    # else is hand-crafted and must not reach the engine env file. isascii +
    # isdigit (not isdigit alone): "²" passes isdigit but crashes int(), and
    # Arabic-Indic digits silently convert to a different workspace number.
    if space and not (space.isascii() and space.isdigit() and len(space) <= 10):
        raise HTTPException(422, "perso_space_seq must be a workspace number")
    try:
        # None = field not sent (leave alone); "" = clear the saved value.
        status = write_keys({
            "GEMINI_API_KEY": None if body.gemini_api_key is None else body.gemini_api_key.strip(),
            "PERSO_API_KEY": None if body.perso_api_key is None else body.perso_api_key.strip(),
            "PERSO_SPACE_SEQ": space,
        })
    except FileNotFoundError:
        raise HTTPException(503, "Settings need a desktop install (no kit.env found)")
    except ValueError as e:
        raise HTTPException(422, str(e))
    # Unlike the keys, this one needs no restart: the desktop shell re-reads
    # kit.env before every count, so the next event already obeys the switch.
    if body.analytics_off is not None:
        write_analytics_off(body.analytics_off)
    # The same story for the failure reports, and the same lack of a restart:
    # the shell re-reads kit.env before it sends one.
    if body.reports_off is not None:
        write_reports_off(body.reports_off)
    return {"gemini_key_set": status["GEMINI_API_KEY"], "perso_key_set": status["PERSO_API_KEY"],
            "perso_space_seq": read_value("PERSO_SPACE_SEQ"),
            "restart_required": False}


def _open_folder(path: str) -> None:
    """Show a folder in the desktop's own file browser (Finder, Explorer, or
    whatever xdg-open answers to). Separate so the endpoint below can be tested
    without opening windows on the test machine."""
    if sys.platform == "darwin":
        subprocess.Popen(["open", path])
    elif sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]  # Windows only
    else:
        subprocess.Popen(["xdg-open", path])

@router.post("/api/settings/reveal-output")
def settings_reveal_output():
    """Open the folder finished videos are saved in. Settings used to print the
    raw path in a read-only field; a button that opens the folder is what a
    desktop app does instead (2026-08-28), and only the server knows the folder
    (the desktop shell can point the workspace anywhere)."""
    try:
        _open_folder(state.WORKSPACE)
    except OSError as e:
        raise HTTPException(500, f"Could not open the folder: {e}")
    return {"ok": True}


@router.get("/api/perso/spaces")
def perso_spaces():
    """Workspaces the saved Perso key can dub in, for the Settings picker.

    The key comes from kit.env first (a key saved moments ago, before any
    restart) and the process env second (server deployments with no kit) --
    otherwise picking a workspace right after saving the key would take two
    restarts. The key itself is used server-side only and never returned.
    """
    key = current_value("PERSO_API_KEY")
    if not key:
        raise HTTPException(409, "Enter a Perso API key to see its workspaces")
    try:
        spaces = list_dubbing_spaces(key)
    except Exception as e:
        # Never interpolate str(e): an httpx error can echo request details.
        raise HTTPException(502, f"Could not list Perso workspaces ({type(e).__name__})")
    return {"spaces": spaces}


class PersoSpacesPreviewRequest(BaseModel):
    api_key: str


# Last preview (key, when, spaces), so the typing/blur/paste triggers on the
# screen can all fire without three calls to Perso for one key. Not a cache with
# a policy -- just the 5-second window that collapses one burst into one call.
_preview_last = {"key": "", "at": 0.0, "spaces": None}
_PREVIEW_WINDOW_SEC = 5.0


@router.post("/api/perso/spaces/preview")
def perso_spaces_preview(body: PersoSpacesPreviewRequest):
    """Workspaces for a key the user has TYPED but not saved yet.

    This is what removes the second restart: without it the picker could only
    list workspaces for an already-saved key, so a new key meant save, restart,
    pick, save, restart. The key arrives in the body, is used server-side only,
    and is never echoed back -- the response carries workspaces and nothing
    else, so a key can't leak into logs or the screen through this route.
    """
    key = (body.api_key or "").strip()
    if not key:
        raise HTTPException(400, "Enter a Perso API key to see its workspaces")
    now = time.monotonic()
    if _preview_last["spaces"] is not None and _preview_last["key"] == key \
            and now - _preview_last["at"] < _PREVIEW_WINDOW_SEC:
        return {"spaces": _preview_last["spaces"]}
    try:
        spaces = list_dubbing_spaces(key)
    except Exception as e:
        # Same rule as above: the type name only, never str(e) -- an httpx
        # error message can carry the request, and the request carries the key.
        raise HTTPException(502, f"Could not list Perso workspaces ({type(e).__name__})")
    _preview_last.update(key=key, at=now, spaces=spaces)
    return {"spaces": spaces}
