// Runs before every build (npm "prebuild"). If the phone app's code has a mistake that would stop it from starting
// (like two things with the same name), the build stops here, so the live site stays on the last version that works.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fcc-check-"));
const files = [["public/app/app.js", "app.mjs"], ["public/app/demo.js", "demo.cjs"], ["public/app/sw.js", "sw.cjs"]];  // app.js is a module; the others are plain scripts
let bad = 0;
for (const [file, as] of files) {
  if (!existsSync(file)) continue;
  const copy = join(dir, as); copyFileSync(file, copy);
  try { execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" }); console.log(`checked ${file}: OK`); }
  catch (e) { bad++; console.error(`\n${file} has a mistake that would stop the app from starting:\n${String(e.stderr || e.message).replaceAll(copy, file)}`); }
}
if (bad) { console.error("Build stopped so the live app stays on the last version that works."); process.exit(1); }
