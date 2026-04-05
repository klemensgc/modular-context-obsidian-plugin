import esbuild from "esbuild";

esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  external: ["obsidian", "electron", "child_process"],
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: "inline",
}).catch(() => process.exit(1));
