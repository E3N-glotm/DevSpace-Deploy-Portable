import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const exe = join(root, "DevSpace-Portable.exe");
const source = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
const temp = mkdtempSync(join(tmpdir(), "devspace-selected-diff-"));

const patch = [
  "===================================================================",
  "--- a/mcp_rein_stage/DEVELOPMENT_STATUS.md",
  "+++ b/mcp_rein_stage/DEVELOPMENT_STATUS.md",
  "@@ -1,3 +1,4 @@",
  " status",
  "-old development line",
  "+new development line",
  "+development only",
  "===================================================================",
  "--- a/mcp_rein_stage/README.md",
  "+++ b/mcp_rein_stage/README.md",
  "@@ -5,2 +5,3 @@",
  " readme context",
  "-old readme line",
  "+new readme line",
  "+readme only",
  "===================================================================",
  "--- a/mcp_rein_stage/configs/experiments/rein_spm_extractor_1024_16c_aligned.yaml",
  "+++ b/mcp_rein_stage/configs/experiments/rein_spm_extractor_1024_16c_aligned.yaml",
  "@@ -1,1 +1,2 @@",
  " model: rein",
  "+yaml only",
].join("\n");

try {
  const patchFile = join(temp, "aggregate.patch");
  const output = join(temp, "selected.patch");
  writeFileSync(patchFile, patch, "utf8");

  const selectedPath = "mcp_rein_stage/README.md";
  const run = spawnSync(exe, ["--diff-extract-test", patchFile, selectedPath, output], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout || `diff extraction exited ${run.status}`);
  const selected = readFileSync(output, "utf8");
  assert.match(selected, /--- a\/mcp_rein_stage\/README\.md/);
  assert.match(selected, /\+readme only/);
  assert.doesNotMatch(selected, /DEVELOPMENT_STATUS/);
  assert.doesNotMatch(selected, /development only/);
  assert.doesNotMatch(selected, /rein_spm_extractor/);
  assert.doesNotMatch(selected, /yaml only/);
  assert.equal((selected.match(/^===================================================================$/gm) ?? []).length, 1);

  assert.match(source, /oldGutter\.PadLeft\(5\).*newGutter\.PadLeft\(5\)/s);
  assert.match(source, /UiTypography\.Code\(9F/);
  assert.match(source, /ResolveFamily\("Segoe UI Variable Text"/);

  console.log(JSON.stringify({
    exactSelectedFileDiff: true,
    jsDiffSeparatorAware: true,
    noCrossFileLeakage: true,
    dualLineNumberGutter: true,
    modernTypography: true,
  }));
} finally {
  rmSync(temp, { recursive: true, force: true });
}
