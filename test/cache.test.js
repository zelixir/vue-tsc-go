"use strict";

/**
 * vue-tsc-go diagnostic-cache self-test.
 *
 * Verifies on a throwaway copy of ./fixture:
 *  (a) first run writes a cache entry (miss),
 *  (b) second run hits the cache and reproduces stdout/stderr/exit code
 *      byte for byte,
 *  (c) a source-file edit invalidates the cache and the fresh output again
 *      matches a --no-cache run byte for byte,
 *  (d) touching a file (mtime only) triggers revalidation without changing
 *      the output (program-manifest stat check),
 *  (e) --cache-dir / --clear-cache / --no-cache behave.
 *
 * Run: node test/cache.test.js
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "vue-tsc-go.js");
const fixture = path.join(__dirname, "fixture");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vue-tsc-go-cache-test-"));
const proj = path.join(tmp, "proj");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
for (const f of ["tsconfig.json", path.join("src", "App.vue"), path.join("src", "main.ts")]) {
	fs.copyFileSync(path.join(fixture, f), path.join(proj, f));
}

function run(args) {
	const res = spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: proj });
	return { stdout: res.stdout || "", stderr: res.stderr || "", status: res.status };
}

const failures = [];
function check(cond, msg) {
	if (!cond) failures.push(msg);
}

try {
	const args = ["-p", proj, "--noEmit"];

	// (a) miss run writes an entry
	const r1 = run(args);
	const entriesDir = path.join(proj, ".vue-tsc-go-cache", "entries");
	const list1 = fs.existsSync(entriesDir) ? fs.readdirSync(entriesDir) : [];
	check(r1.status !== 0, "fixture copy should have diagnostics (non-zero exit)");
	check(list1.length === 1, `expected exactly 1 cache entry after miss run, got ${list1.length}`);

	// (b) hit run is byte-identical
	const r2 = run(args);
	check(r2.status === r1.status, `hit exit code mismatch: ${r2.status} vs ${r1.status}`);
	check(r2.stdout === r1.stdout, "hit stdout differs from miss stdout");
	check(r2.stderr === r1.stderr, "hit stderr differs from miss stderr");

	// (c) source edit invalidates; fresh output matches --no-cache byte for byte
	const mainTs = path.join(proj, "src", "main.ts");
	fs.writeFileSync(mainTs, fs.readFileSync(mainTs, "utf8") + "\n// cache-test edit\n");
	const r3 = run(args);
	const r3n = run([...args, "--no-cache"]);
	check(r3.status === r3n.status, "post-edit exit code differs between cached pipeline and --no-cache");
	check(r3.stdout === r3n.stdout, "post-edit stdout differs from --no-cache stdout");
	check(r3.stderr === r3n.stderr, "post-edit stderr differs from --no-cache stderr");

	// (d) mtime-only change: key stays, manifest stat check forces revalidation
	const appVue = path.join(proj, "src", "App.vue");
	const before = fs.readFileSync(appVue);
	const future = Date.now() / 1000 + 3600;
	fs.utimesSync(appVue, future, future);
	const r4 = run(args);
	fs.utimesSync(appVue, future, future); // keep mtime stable for the comparison run below
	const r4n = run([...args, "--no-cache"]);
	fs.writeFileSync(appVue, before); // restore content & mtime for later steps
	check(r4.stdout === r4n.stdout && r4.stderr === r4n.stderr && r4.status === r4n.status,
		"mtime-only touch changed the result (manifest revalidation broken)");

	// (e) --cache-dir / --clear-cache / --no-cache
	const customDir = path.join(tmp, "custom-cache");
	const r5 = run([...args, "--cache-dir", customDir]);
	check(r5.stdout === r3n.stdout, "--cache-dir run output mismatch");
	check(fs.existsSync(path.join(customDir, "entries")) &&
		fs.readdirSync(path.join(customDir, "entries")).length >= 1,
		"--cache-dir did not create entries");
	run([...args, "--cache-dir", customDir, "--clear-cache"]);
	check(!fs.existsSync(path.join(customDir, "entries")), "--clear-cache did not remove entries");
	const r6 = run([...args, "--no-cache"]);
	check(r6.stdout === r3n.stdout, "--no-cache run output mismatch");
	check(!fs.existsSync(path.join(proj, ".vue-tsc-go-cache", "entries")) ||
		fs.readdirSync(path.join(proj, ".vue-tsc-go-cache", "entries")).length <= 2,
		"unexpected entry accumulation");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
	console.error("CACHE TEST FAILED:\n - " + failures.join("\n - "));
	process.exit(1);
}
console.log("CACHE TEST PASSED");
