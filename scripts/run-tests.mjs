import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const outputDir = mkdtempSync(join(tmpdir(), "ink-studio-tests-"));
const entries = ["inputMath.test", "document.test"];

await build({
  entryPoints: Object.fromEntries(
    entries.map((name) => [name, `tests/${name}.ts`])
  ),
  outdir: outputDir,
  bundle: true,
  platform: "node",
  format: "esm",
  outExtension: { ".js": ".mjs" },
  external: ["node:*"],
});

const result = spawnSync(
  process.execPath,
  ["--test", ...entries.map((name) => join(outputDir, `${name}.mjs`))],
  {
  stdio: "inherit",
  }
);
process.exit(result.status ?? 1);
