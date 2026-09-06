# -*- coding: utf-8 -*-
"""Every route the app answers on, written down.

Endpoints moved out of app/main.py into app/api/*.py routers. A router that
stops being mounted -- a deleted include_router line, a bad import swallowed
somewhere, a prefix typed twice -- takes its whole area of the app with it, and
every unit test around it still passes, because the tests call the handlers,
not the app. This is the one check that notices.

Update the list on purpose when you add or move a route: a router that silently
fails to mount shows up here, and so does a route that quietly changed its path.
"""
import app.main

ROUTES = [
    '/',
    '/api/agent/chat',
    '/api/agent/status',
    '/api/agent/stop',
    '/api/clips/cut',
    '/api/dub/jobs',
    '/api/dub/jobs/{jid}',
    '/api/dub/jobs/{jid}/cancel',
    '/api/dub/jobs/{jid}/perso/materialize',
    '/api/dub/jobs/{jid}/perso/speaker',
    '/api/dub/jobs/{jid}/redub',
    '/api/dub/jobs/{jid}/retry',
    '/api/dub/jobs/{jid}/script',
    '/api/dub/jobs/{jid}/script/{line}',
    '/api/dub/jobs/{jid}/script/{line}/audio',
    '/api/dub/jobs/{jid}/script/{line}/revert',
    '/api/dub/jobs/{jid}/script/{line}/voice',
    '/api/dub/jobs/{jid}/subtitle_style',
    '/api/dub/jobs/{jid}/voices/stale',
    '/api/dub/jobs/{jid}/workspace',
    '/api/dub/result/{jid}',
    '/api/dub/result/{jid}/original',
    '/api/dub/result/{jid}/srt',
    '/api/dub/result/{jid}/subtitle_preview',
    '/api/dub/result/{jid}/subtitled',
    '/api/dub/start',
    '/api/engines',
    '/api/models',
    '/api/models/{mid}',
    '/api/models/{mid}/cancel',
    '/api/models/{mid}/download',
    '/api/perso/spaces',
    '/api/perso/spaces/preview',
    '/api/settings',
    '/api/settings/reveal-output',
    '/api/setup',
    '/api/source/probe',
    '/api/subtitles/burn',
    '/api/subtitles/estimate',
    '/api/subtitles/extract',
    '/api/translate',
    '/api/tts/engines',
    '/api/tts/say',
    '/api/whats-new',
    '/health',
]


def test_the_app_serves_exactly_these_routes():
    assert sorted(app.main.app.openapi()["paths"]) == ROUTES
