// Legacy entry point. Both workflows execute the shared TypeScript pipeline.
const { spawnSync } = require("node:child_process");
const result = spawnSync("deno", ["run", "--allow-net", "--allow-env", "scraper.ts", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
