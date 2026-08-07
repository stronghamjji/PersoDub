import { spawn } from "node:child_process";

export function run(argv, { cwd, env, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const recent = [];
    const feed = (buf) => {
      for (const line of buf.toString().split("\n")) {
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
