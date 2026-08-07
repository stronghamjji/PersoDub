export async function waitForHealth(url, { timeoutMs, intervalMs = 250, predicate = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (predicate(body)) return body;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const hint = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}${hint}`);
}
