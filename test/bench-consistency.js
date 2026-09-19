"use strict";
/**
 * Bench consistency check: for each bench project, compare byte-for-byte
 *  (a) worker-path run (resident worker, warm session full/replay)
 *  (b) --no-cache run
 *  (c) disk-hit run (cache miss via --no-worker, then plain run)
 * stdout, stderr and exit code must all be identical across (a),(b),(c).
 *
 * Usage: node test/bench-consistency.js [element-plus|vueuse|vben|all]
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "vue-tsc-go.js");
const PROJECTS = {
  "element-plus": { cwd: "D:/Code/vue-tsc-go/bench/element-plus", args: ["-p", "tsconfig.web.json", "--composite", "false", "--noEmit"], leaf: "packages/utils/browser.ts" },
  vueuse: { cwd: "D:/Code/vue-tsc-go/bench/vueuse", args: ["--noEmit"], leaf: "packages/core/_configurable.ts" },
  vben: { cwd: "D:/Code/vue-tsc-go/bench/vue-vben-admin/apps/web-antd", args: ["--noEmit", "--skipLibCheck"], leaf: "src/main.ts" },
};

function run(cwd, args, env) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const rawStderr = res.stderr ? res.stderr.toString("utf8") : "";
  return {
    stdout: res.stdout ? res.stdout.toString("utf8") : "",
    stderr: rawStderr.split(/\r?\n/).filter((l) => !l.startsWith("[vue-tsc-go debug]")).join("\n"),
    rawStderr,
    exitCode: typeof res.status === "number" ? res.status : 1,
  };
}

function killWorkers(cwd) {
  // best effort: remove worker meta so the next run spawns fresh
  const { execSync } = require("node:child_process");
  try {
    execSync(`powershell -NoProfile -File "${path.join(__dirname, "kill-workers.ps1")}"`, { stdio: "ignore" });
  } catch {}
}

const which = process.argv[2] || "all";
const names = which === "all" ? Object.keys(PROJECTS) : [which];
let failed = false;
for (const name of names) {
  const { cwd, args } = PROJECTS[name];
  console.log(`\n=== ${name} ===`);
  // (b) uncached reference
  const ref = run(cwd, [...args, "--no-cache"], {});
  console.log(`no-cache: exit=${ref.exitCode} stdout=${ref.stdout.length}B stderr=${ref.stderr.length}B`);
  // (a) worker: first run = cold worker (spawn+full), second = warm full/replay
  killWorkers(cwd);
  const w1 = run(cwd, args, { VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
  const w2 = run(cwd, args, { VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
  const w1mode = /worker mode=(\w+)/.exec(w1.rawStderr)?.[1] || "?";
  const w2mode = /worker mode=(\w+)/.exec(w2.rawStderr)?.[1] || "?";
  console.log(`worker: cold mode=${w1mode} exit=${w1.exitCode}, warm mode=${w2mode} exit=${w2.exitCode}`);
  // (c) disk: clear cache, miss run (--no-worker), hit run
  run(cwd, [...args, "--clear-cache"], {});
  run(cwd, args, { VUE_TSC_GO_NO_WORKER: "1" });
  const hit = run(cwd, args, { VUE_TSC_GO_NO_WORKER: "1" });
  console.log(`disk hit: exit=${hit.exitCode}`);
  for (const [label, r] of [["worker-cold", w1], ["worker-warm", w2], ["disk-hit", hit]]) {
    const ok = r.stdout === ref.stdout && r.exitCode === ref.exitCode && r.stderr === ref.stderr;
    console.log(`  ${label}: ${ok ? "IDENTICAL" : "MISMATCH"}`);
    if (!ok) {
      failed = true;
      console.log("    --- ref ---\n" + ref.stdout.slice(0, 2000));
      console.log("    --- got ---\n" + r.stdout.slice(0, 2000));
      if (r.stderr !== ref.stderr) {
        console.log("    --- ref stderr ---\n" + ref.stderr.slice(0, 500));
        console.log("    --- got stderr ---\n" + r.stderr.slice(0, 500));
      }
    }
  }
  // (d) real content edit on an existing leaf file: worker warm full run must
  // equal a fresh --no-cache run (new diagnostics byte-for-byte)
  const leafPath = path.join(cwd, PROJECTS[name].leaf);
  const original = fs.readFileSync(leafPath, "utf8");
  try {
    fs.appendFileSync(leafPath, "\nconst __benchProbeErr: number = \"x\";\n");
    const wEdit = run(cwd, args, { VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
    const refEdit = run(cwd, [...args, "--no-cache"], {});
    const wMode = /worker mode=(\w+)/.exec(wEdit.rawStderr)?.[1] || "?";
    const ok = wEdit.stdout === refEdit.stdout && wEdit.exitCode === refEdit.exitCode && wEdit.stderr === refEdit.stderr;
    console.log(`  worker-edit (mode=${wMode}): ${ok ? "IDENTICAL" : "MISMATCH"} (errors: ${refEdit.stdout.split("\n").filter((l) => l.includes("error")).length})`);
    if (!ok) {
      failed = true;
      console.log("    --- ref ---\n" + refEdit.stdout.slice(0, 2000));
      console.log("    --- got ---\n" + wEdit.stdout.slice(0, 2000));
    }
  } finally {
    fs.writeFileSync(leafPath, original);
  }
  // post-restore sanity: worker run must match reference again
  const wRestored = run(cwd, args, { VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
  const okRestored = wRestored.stdout === ref.stdout && wRestored.exitCode === ref.exitCode && wRestored.stderr === ref.stderr;
  console.log(`  worker-restore: ${okRestored ? "IDENTICAL" : "MISMATCH"}`);
  if (!okRestored) failed = true;
}
process.exit(failed ? 1 : 0);
