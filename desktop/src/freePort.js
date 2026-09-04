import { createServer } from "node:net";

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Last launch's port, if nothing else took it meanwhile; otherwise any free
// one. The backend's port is the page's browser origin, and everything the
// page keeps in localStorage (the seen "What's new" version, the timeline's
// open state, pane sizes) lives under that origin -- a new port every launch
// meant a blank slate every launch. Anything that is not a usable user port
// (unset, 0, privileged, out of range) just means "pick a free one".
export function getPreferredPort(preferred) {
  if (!Number.isInteger(preferred) || preferred <= 1024 || preferred > 65535) return getFreePort();
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(getFreePort()));
    srv.listen(preferred, "127.0.0.1", () => srv.close(() => resolve(preferred)));
  });
}
