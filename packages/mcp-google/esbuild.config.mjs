import esbuild from "esbuild";
import { chmodSync } from "node:fs";

const outfile = "dist/index.js";

await esbuild
  .build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile,
    platform: "node",
    target: "node20",
    format: "cjs",
    sourcemap: "inline",
    banner: {
      js: "#!/usr/bin/env node\n",
    },
    external: [],
  })
  .catch(() => process.exit(1));

chmodSync(outfile, 0o755);
