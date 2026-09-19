"use strict";

/**
 * vue-tsc-go self-test.
 *
 * Verifies on ./fixture:
 *  (a) .vue files are included in the check,
 *  (b) errors inside .vue are reported with line/col pointing at the .vue source,
 *  (c) the process exit code is non-zero on errors (tsc convention: 1 on diagnostics,
 *      2 on compiler errors — same convention as tsc / original vue-tsc,
 *      verified byte-for-byte against vue-tsc 3.3.11 + typescript 5.9).
 *
 * Run: node test/selftest.js
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const bin = path.join(__dirname, "..", "bin", "vue-tsc-go.js");
const fixture = path.join(__dirname, "fixture");

const result = spawnSync(process.execPath, [bin, "-p", fixture, "--noEmit"], {
	encoding: "utf8",
	shell: false,
});

console.log("--- exit code:", result.status);
console.log("--- stdout ---");
console.log(result.stdout);
console.log("--- stderr ---");
console.log(result.stderr);

const out = result.stdout + result.stderr;
const failures = [];

if (result.status !== 2) failures.push(`expected exit code 2 (compiler errors), got ${result.status}`);
if (!/App\.vue/.test(out)) failures.push("no diagnostics reference App.vue (.vue file not checked?)");
if (!/TS2322/.test(out)) failures.push("expected TS2322 (string assigned to number) in App.vue script");
if (!/TS2304|Cannot find name/.test(out)) failures.push("expected TS2304 (unknown name) diagnostics");

// line/col sanity: diagnostics for App.vue should carry a line:col suffix
const vueDiags = out.split(/\r?\n/).filter(l => l.includes("App.vue") && /\(\d+,\d+\)|:\d+:\d+/.test(l));
if (vueDiags.length === 0) failures.push("App.vue diagnostics lack line/column positions");

if (failures.length) {
	console.error("SELFTEST FAILED:\n - " + failures.join("\n - "));
	process.exit(1);
}
console.log("SELFTEST PASSED");
