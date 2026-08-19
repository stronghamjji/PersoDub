// Receives one usage event per request and appends a row to D1.
//
// The endpoint is public -- the URL ships inside an open-source app, so anyone
// can post to it. That is accepted: the validation below is not a gate against a
// determined faker, it is what keeps junk out of the table so the numbers stay
// readable. Nothing here reads a header, a cookie, or the client IP.

const EVENTS = new Set(["app_launch", "dub_success", "dub_failure", "install_failure"]);
const PLATFORMS = new Set(["mac", "windows"]);
const ERROR_CODES = new Set([
  "path-too-long", "disk-full", "network", "permission", "engine-start",
  "out-of-memory", "unsupported-format", "engine-crash",
  "unknown",
]);

const DEVICE = /^[0-9a-f]{32}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response(null, { status: 405 });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    const { event, os, version, device } = body ?? {};
    if (!EVENTS.has(event)) return new Response(null, { status: 400 });
    if (!PLATFORMS.has(os)) return new Response(null, { status: 400 });
    if (typeof version !== "string" || !VERSION.test(version)) return new Response(null, { status: 400 });
    if (typeof device !== "string" || !DEVICE.test(device)) return new Response(null, { status: 400 });

    // Only failures carry a code, and only one off the published list -- an
    // unrecognized value becomes "unknown" rather than reaching the table
    // verbatim, which is what keeps a stray path or message out of storage.
    const code = (event === "dub_failure" || event === "install_failure")
      ? (ERROR_CODES.has(body.error_code) ? body.error_code : "unknown")
      : null;

    // The day is stamped here, not by the client: a wrong clock on one machine
    // should not land rows in the wrong bucket for everyone else.
    const day = new Date().toISOString().slice(0, 10);

    await env.persodub_count
      .prepare("INSERT INTO events (day, event, os, version, device, error_code) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(day, event, os, version, device, code)
      .run();

    return new Response(null, { status: 204 });
  },
};
