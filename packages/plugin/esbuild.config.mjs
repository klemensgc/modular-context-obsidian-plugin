import esbuild from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

// Load .env.local for Quick Connect OAuth credentials (gitignored)
// Falls through to empty strings if file missing — plugin handles gracefully at runtime.
const envLocalPath = resolvePath(process.cwd(), ".env.local");
const envVars = { GOOGLE_OAUTH_CLIENT_ID: "", GOOGLE_OAUTH_CLIENT_SECRET: "" };
if (existsSync(envLocalPath)) {
  const content = readFileSync(envLocalPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key in envVars) envVars[key] = value;
  }
}

import { copyFileSync } from "node:fs";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  external: ["obsidian", "electron", "child_process"],
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: "inline",
  loader: {
    ".py": "text",
  },
  define: {
    "process.env.GOOGLE_OAUTH_CLIENT_ID": JSON.stringify(envVars.GOOGLE_OAUTH_CLIENT_ID),
    "process.env.GOOGLE_OAUTH_CLIENT_SECRET": JSON.stringify(envVars.GOOGLE_OAUTH_CLIENT_SECRET),
  },
}).catch(() => process.exit(1));

// Copy MCP Google server binary to plugin folder so it ships alongside main.js/styles.css.
// User's copy-to-vault flow: cp main.js styles.css manifest.json mcp-server.js <plugin-dir>/
const mcpDist = resolvePath("../mcp-google/dist/index.js");
if (existsSync(mcpDist)) {
  copyFileSync(mcpDist, "mcp-server.js");
  console.log("[build] Copied mcp-google dist → mcp-server.js");
} else {
  console.warn(
    "[build] WARNING: ../mcp-google/dist/index.js missing. " +
      "Run 'npm run build' in packages/mcp-google first, or Google Workspace MCP features will not work.",
  );
}
