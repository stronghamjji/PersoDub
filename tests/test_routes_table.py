# -*- coding: utf-8 -*-
"""Every route the app answers on, and the methods it answers with.

Endpoints moved out of app/main.py into app/api/*.py routers. A router that
stops being mounted -- a deleted include_router line, a bad import swallowed
somewhere, a prefix typed twice -- takes its whole area of the app with it, and
every unit test around it still passes, because the tests call the handlers,
not the app. This is the one check that notices.

Methods, not just paths: this used to compare `app.openapi()["paths"]`, which
is blind twice over. A route that loses one of its methods keeps its path, so
dropping PUT from /api/dub/jobs/{jid}/subtitle_style would not have shown up
here at all; and a route declared include_in_schema=False is not in the schema
in the first place, which is exactly what HEAD /api/dub/result/{jid}/srt is.
Walking app.routes sees both.

The walk recurses because this FastAPI keeps an included router as a single
wrapper object in app.routes (the routes themselves hang off its
original_router) rather than flattening them in.

FastAPI's own /docs, /redoc and /openapi.json are in the list too. They are
routes the app serves, and pinning them costs nothing but a line each; the
alternative is a filter with a rule nobody can check.

Update the list on purpose when you add or move a route: a router that
silently fails to mount shows up here, and so does a route that quietly
changed its path or lost a method.
"""
from starlette.routing import Route

import app.main

ROUTES = [
    ('DELETE', '/api/dub/jobs/{jid}/workspace'),
    ('DELETE', '/api/models/{mid}'),
    ('GET', '/'),
    ('GET', '/api/agent/status'),
    ('GET', '/api/downloads'),
    ('GET', '/api/downloads/{did}'),
    ('GET', '/api/downloads/{did}/video'),
    ('GET', '/api/dub/jobs'),
    ('GET', '/api/dub/jobs/{jid}'),
    ('GET', '/api/dub/jobs/{jid}/script'),
    ('GET', '/api/dub/jobs/{jid}/script/{line}/audio'),
    ('GET', '/api/dub/jobs/{jid}/subtitle_style'),
    ('GET', '/api/dub/result/{jid}'),
    ('GET', '/api/dub/result/{jid}/original'),
    ('GET', '/api/dub/result/{jid}/srt'),
    ('GET', '/api/dub/result/{jid}/subtitle_preview'),
    ('GET', '/api/dub/result/{jid}/subtitled'),
    ('GET', '/api/engines'),
    ('GET', '/api/erase/{jid}'),
    ('GET', '/api/erase/{jid}/original'),
    ('GET', '/api/erase/{jid}/video'),
    ('GET', '/api/languages'),
    ('GET', '/api/models'),
    ('GET', '/api/perso/spaces'),
    ('GET', '/api/report/bundle'),
    ('GET', '/api/settings'),
    ('GET', '/api/setup'),
    ('GET', '/api/subtitles/estimate'),
    ('GET', '/api/tts/engines'),
    ('GET', '/api/whats-new'),
    ('GET', '/docs'),
    ('GET', '/docs/oauth2-redirect'),
    ('GET', '/health'),
    ('GET', '/js/{name}'),   # the page's ES modules, token-stamped and uncacheable (app/main.py)
    ('GET', '/logo.png'),
    ('GET', '/openapi.json'),
    ('GET', '/redoc'),
    ('HEAD', '/api/dub/result/{jid}/srt'),
    ('HEAD', '/docs'),
    ('HEAD', '/docs/oauth2-redirect'),
    ('HEAD', '/openapi.json'),
    ('HEAD', '/redoc'),
    ('POST', '/api/agent/chat'),
    ('POST', '/api/agent/stop'),
    ('POST', '/api/clips/cut'),
    ('POST', '/api/downloads'),
    ('POST', '/api/downloads/upload'),
    ('POST', '/api/downloads/{did}/save'),
    ('POST', '/api/dub/jobs/{jid}/cancel'),
    ('POST', '/api/dub/jobs/{jid}/perso/materialize'),
    ('POST', '/api/dub/jobs/{jid}/perso/speaker'),
    ('POST', '/api/dub/jobs/{jid}/redub'),
    ('POST', '/api/dub/jobs/{jid}/retry'),
    ('POST', '/api/dub/jobs/{jid}/script/{line}'),
    ('POST', '/api/dub/jobs/{jid}/script/{line}/revert'),
    ('POST', '/api/dub/jobs/{jid}/script/{line}/voice'),
    ('POST', '/api/dub/jobs/{jid}/voices/stale'),
    ('POST', '/api/dub/start'),
    ('POST', '/api/erase'),
    ('POST', '/api/erase/suggest'),
    ('POST', '/api/erase/{jid}/dub'),
    ('POST', '/api/erase/{jid}/save'),
    ('POST', '/api/models/{mid}/cancel'),
    ('POST', '/api/models/{mid}/download'),
    ('POST', '/api/perso/spaces/preview'),
    ('POST', '/api/settings'),
    ('POST', '/api/settings/reveal-output'),
    ('POST', '/api/setup'),
    ('POST', '/api/source/probe'),
    ('POST', '/api/subtitles/burn'),
    ('POST', '/api/subtitles/extract'),
    ('POST', '/api/translate'),
    ('POST', '/api/tts/say'),
    ('PUT', '/api/dub/jobs/{jid}/subtitle_style'),
]


def _method_and_path(routes):
    """(method, path) for every route reachable from `routes`, routers included.

    OPTIONS-only and websocket routes have no `methods`; a Mount (the /js and
    /static file servers) has no methods either and is not a route table entry.
    """
    for route in routes:
        included = getattr(route, "original_router", None)
        if included is not None:
            yield from _method_and_path(included.routes)
        elif isinstance(route, Route) and route.methods:
            for method in route.methods:
                yield (method, route.path)


def test_the_app_serves_exactly_these_routes():
    assert sorted(set(_method_and_path(app.main.app.routes))) == ROUTES


def test_the_srt_route_answers_head_even_though_it_is_not_in_the_schema():
    """The one route the old paths-only table structurally could not see."""
    assert ('HEAD', '/api/dub/result/{jid}/srt') in ROUTES
    assert '/api/dub/result/{jid}/srt' in app.main.app.openapi()["paths"]
