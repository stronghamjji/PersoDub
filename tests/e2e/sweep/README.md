Area modules for tests/e2e/sweep.mjs. Each file exports:

    export const area = "home";          // short name, used in --only and the report
    export const steps = [
      { name: "project cards", looks: ["#screen-home"], stopsArea: false,
        async run(app, ctx) { ...; return "33 cards, 4 tool cards"; } },
    ];

`app` is the connection from tests/e2e/lib/cdp.mjs (click, key, type, choose, feed, waitFor, inPage, api, shot, tr, opened).
It knows the name the page calls the app (`app.page.name`, which `tr` fills {app} with).
`ctx` has video, srt, out, stamp, fixtures (the import area's odd inputs) and a shared `state` object the steps of one run may pass things through.
A step returns a one-line note with its numbers, or throws with the reason; it throws
`Skip` (from lib/cdp.mjs) with the reason when this computer cannot run it (not signed in,
a model not installed), and is reported as skipped.
The two steps that turn Settings > Privacy's switch (50-settings.mjs, 55-events.mjs) run only when the sweep is started with `PERSODUB_KIT_DIR=<the app's kit>` and that kit's `kit.env` has `PERSODUB_ANALYTICS_DEBUG=1`, `PERSODUB_REPORTS_DEBUG=1` and `PERSODUB_EVENTS_DEBUG=1`, so nothing a test turns on is sent (lib/kit.mjs); otherwise they are skipped.
After a step that did not pass, the sweep closes what it may have left open over the next
step (the ChatGPT sign-in, the Download dialog, the subtitle looks, the Help dialog, the update window: `app.putAway()`) and says so in its note.
Leave the app on Home at the end of an area.
Modules run in file-name order: 10-home.mjs, 20-prep.mjs, 30-dub.mjs, 40-tools.mjs, 50-settings.mjs.
