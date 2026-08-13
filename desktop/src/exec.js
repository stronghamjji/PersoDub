import { spawn } from "node:child_process";

// Terminal control sequences (CSI): erase-line, cursor show/hide, and the
// synchronized-output pair Ollama's progress bar uses. A terminal acts on them
// and shows nothing; the installer screen is HTML, so it printed them as text
// -- its last line read "2h13m[K[?25h[?2026l" through the whole 8 GB pull.
const CONTROL_SEQUENCES = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function run(argv, { cwd, env, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const recent = [];
    const feed = (buf) => {
      // Split on \r as well as \n: a progress bar redraws its line with a bare
      // carriage return, so splitting on newlines alone glued every update of
      // a download into one ever-growing line.
      for (const raw of buf.toString().split(/\r\n|[\r\n]/)) {
        const line = raw.replace(CONTROL_SEQUENCES, "");
        if (!line.trim()) continue;
        recent.push(line);
        if (recent.length > 20) recent.shift();
        onLine(line);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${argv[0]} exit ${code}\n${recent.join("\n")}`));
    });
  });
}
