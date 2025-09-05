// NEW: safeJson.ts
export async function safeJson(resp: Response) {
  const ct = resp.headers.get("content-type") || "";
  const text = await resp.text(); // read once
  if (!resp.ok) {
    throw new Error(`Upstream ${resp.status} ${resp.statusText}; CT=${ct}; BodyStart=${text.slice(0,300)}`);
  }
  // Only parse if it *looks* like JSON and content-type is sane
  if (!ct.includes("application/json") && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    throw new Error(`Non-JSON Content-Type (${ct}); BodyStart=${text.slice(0,300)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    // Optional: write the bad payload to disk for postmortem
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await Bun.write(`/tmp/bad-${ts}.txt`, text);
    } catch {}
    throw new Error(`Failed to parse JSON; CT=${ct}; Len=${text.length}; BodyStart=${text.slice(0,300)}`);
  }
}
