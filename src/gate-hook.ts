export {};
// Codex runs this as a PreToolUse command hook. Codex lets the tool run when a hook fails, so every failure
// here exits 2, which Codex treats as a block.
const url = process.argv[2];
try {
  if (!url) throw new Error("no gate URL");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.VALET_CODEX_GATE_TOKEN ?? ""}`,
      "content-type": "application/json",
    },
    body: await Bun.stdin.text(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out = (await res.text()).trim();
  if (out && out !== "{}") process.stdout.write(out);
} catch (e) {
  process.stderr.write(`valet's tool gate failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
