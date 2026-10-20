# End-to-end runs against the real app

These drive a running PersoDub; they are not part of any test suite.

## click.mjs

Presses the app's own buttons over the Chrome DevTools Protocol, as a person would,
with a screenshot and a time for each step. Node 22 or later (global WebSocket), no packages.

    cd desktop && npx electron . --remote-debugging-port=9333
    node tests/e2e/click.mjs --video <short mp4 with speech> --out <folder> [--port 9333] [--translator hunyuan]

Six steps: Home; Settings > Models; a new dubbing of the video into Korean on this
computer; the finished script table and timeline; Export; Home again with the new
project's card. Leave the app on Home. A dub already in the queue makes step 4 wait
(30 minutes at most). The dub uses the translator the app would start a new project on,
or the one `--translator` names (picked in Advanced options), so that one has to work:
a key saved, ChatGPT signed in, or a local model downloaded in Settings > Models. Each
run leaves its project, named `e2e-click-<time>`, on Home.

`<folder>` gets `NN-<step>.png`, `report.md` and `report.json`. A failed step exits 1
and the report has its screenshot and a DOM snippet. Export's file is moved out of
Downloads into `<folder>/export`, and the language and options the run picked are put
back as the app's remembered choices afterwards. A `<select>` is set through the page:
its macOS menu is native and CDP cannot press it.
