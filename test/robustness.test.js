"use strict";
/**
 * Robustness tests for the session worker (fixture project):
 *  1. kill -9 the worker mid-session -> next run automatically recovers,
 *     output still byte-identical to --no-cache;
 *  2. two concurrent CLI runs -> both produce correct output, no crosstalk;
 *  3. idle self-exit: with VUE_TSC_GO_WORKER_IDLE_MS small, the worker exits
 *     by itself after the run.
 *
 * Run: node test/robustness.test.js
 */
const { spawnSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BIN = path.join(__dirname, "..", "bin", "vue-tsc-go.js");
const FIXTURE = path.join(__dirname, "fixture");
const CACHE = path.join(FIXTURE, ".vue-tsc-go-cache");
const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); console.log((cond ? "ok  " : "FAIL") + " - " + msg); };

function run(env, extraArgs) {
  const res = spawnSync(process.execPath, [BIN, ...(extraArgs || []), "--noEmit"], {
    cwd: FIXTURE, env: { ...process.env, VUE_TSC_GO_WORKER_IDLE_MS: "15000", ...env }, encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  return {
    stdout: (res.stdout || "").toString("utf8"),
    stderr: (res.stderr || "").toString("utf8").split(/\r?\n/).filter((l) => !l.startsWith("[vue-tsc-go debug]")).join("\n"),
    exitCode: typeof res.status === "number" ? res.status : 1,
  };
}
function workerMetas(cacheDir) {
  try {
    return fs.readdirSync(path.join(cacheDir || CACHE, "worker")).filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(fs.readFileSync(path.join(cacheDir || CACHE, "worker", n), "utf8")));
  } catch { return []; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  try {
    const { execSync } = require("node:child_process");
    execSync(`powershell -NoProfile -File "${path.join(__dirname, "kill-workers.ps1")}"`, { stdio: "ignore" });
  } catch {}
  fs.rmSync(CACHE, { recursive: true, force: true });
  const ref = run({ VUE_TSC_GO_NO_CACHE: "1" });

  try {
    // 1. kill -9 recovery
    run({ VUE_TSC_GO_WORKER: "1" });
    const metas = workerMetas();
    check(metas.length >= 1, "worker meta file exists after first worker run");
    if (metas.length) {
      try { process.kill(metas[0].pid, "SIGKILL"); } catch {}
    }
    await sleep(300);
    const r1 = run({ VUE_TSC_GO_WORKER: "1" });
    check(r1.stdout === ref.stdout && r1.exitCode === ref.exitCode && r1.stderr === ref.stderr,
      "run after kill -9 recovers with byte-identical output");

    // 2. concurrency: two CLIs at once against the same worker
    const env = { ...process.env, VUE_TSC_GO_WORKER: "1" };
    const c1 = spawn(process.execPath, [BIN, "--noEmit"], { cwd: FIXTURE, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const c2 = spawn(process.execPath, [BIN, "--noEmit"], { cwd: FIXTURE, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const collect = (child) => new Promise((res) => {
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => res({ stdout: out, stderr: err.split(/\r?\n/).filter((l) => !l.startsWith("[vue-tsc-go debug]")).join("\n"), exitCode: code }));
    });
    const [j1, j2] = await Promise.all([collect(c1), collect(c2)]);
    check(j1.stdout === ref.stdout && j2.stdout === ref.stdout && j1.exitCode === ref.exitCode && j2.exitCode === ref.exitCode,
      "two concurrent CLI runs both byte-identical (no crosstalk)");

    // 3. idle self-exit (own --cache-dir -> own pipe identity, fresh worker)
    const idleDir = path.join(FIXTURE, ".idle-cache");
    fs.rmSync(idleDir, { recursive: true, force: true });
    run({ VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_WORKER_IDLE_MS: "1500" }, ["--cache-dir", idleDir]);
    const metas2 = workerMetas(idleDir);
    check(metas2.length >= 1, "worker alive right after run (idle 1.5s)");
    const pid = metas2[0] && metas2[0].pid;
    let exited = false;
    if (pid) {
      for (let i = 0; i < 30; i++) {
        await sleep(250);
        const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
        if (!alive) { exited = true; break; }
      }
    }
    check(exited, "worker exited by itself after idle timeout");
  } catch (e) {
    failures.push("threw: " + e);
  } finally {
    // kill every worker registered under CACHE before removing the meta dir,
    // so no resident worker survives the test run
    for (const m of workerMetas()) {
      try { process.kill(m.pid); } catch {}
    }
    await sleep(300);
    for (const m of workerMetas()) {
      try { process.kill(m.pid, "SIGKILL"); } catch {}
    }
    try { fs.rmSync(CACHE, { recursive: true, force: true }); } catch {}
  }

  if (failures.length) {
    console.error("ROBUSTNESS TEST FAILED:\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("ROBUSTNESS TEST PASSED");
}
main();
