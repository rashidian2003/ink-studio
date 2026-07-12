import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const banner = `/*
Ink Studio - bundled with esbuild.
Handwriting / stylus note-taking for Obsidian.
*/
`;

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: banner },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // perfect-freehand is intentionally NOT external: it is a browser-safe
  // library that must be bundled into main.js so it ships to mobile.
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
