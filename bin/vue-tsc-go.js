#!/usr/bin/env node
"use strict";

/**
 * vue-tsc-go — drop-in vue-tsc replacement backed by the tsgo (TypeScript Go
 * port) engine via `typescript-native-bridge`.
 *
 * Strategy (zero fork):
 *  1. Install a Module._resolveFilename hook that redirects every `typescript`
 *     / `typescript/...` resolution to the `typescript-native-bridge` package
 *     (a drop-in TypeScript fork whose createProgram switches Program /
 *     TypeChecker to the in-process Go engine when `configFilePath` is set).
 *     This covers:
 *       - vue-tsc's `resolveTscPath()` default `require.resolve('typescript/lib/tsc')`
 *         (including its package.json `name` probe),
 *       - `@volar/typescript` / `@vue/language-core` internal `require('typescript')`,
 *     so the whole pipeline consistently runs on the bridge TypeScript.
 *  2. Call the published `vue-tsc.run()` (exported by vue-tsc 3.x) which
 *     fs-hook-rewrites the tsc entry source to inject Volar's program proxy,
 *     exactly like the original `vue-tsc` bin does.
 *  3. CLI args are passed through untouched.
 *
 * Diagnostic cache (see bin/cache.js): when enabled (default on), the parent
 * process fingerprints the whole check (toolchain + tsconfig chain + full
 * input file set with content hashes + argv + env). On a hit the previous
 * run's stdout/stderr/exit code are replayed byte for byte without starting
 * the checker. On a miss the check runs in a child process (this same script
 * with VUE_TSC_GO_INTERNAL_CHILD=1, so hooks are installed there too), the
 * output is captured and written to the cache. `--no-cache`, `VUE_TSC_GO_NO_CACHE`
 * or any fingerprinting problem falls back to a plain in-process run.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const packageDir = path.join(__dirname, "..");
const bridgeDir = path.dirname(require.resolve("typescript-native-bridge/package.json"));
const cacheMod = require("./cache.js");

const rawArgv = process.argv.slice(2);
const { argv, cacheDir: cacheDirArg, clear, noWorker } = cacheMod.extractCacheArgs(rawArgv);
const isChild = !!process.env.VUE_TSC_GO_INTERNAL_CHILD;
const cacheDisabled = isChild || cacheMod.isCacheDisableRequested(rawArgv, process.env);
const workerMod = require("./worker-client.js");

// --- cold-run peak-memory tuning (checker process only) ---
//
// The cache-miss child (and the --no-cache in-process run) hosts BOTH the Go
// runtime (tsgo engine, live heap dominates the peak) and the V8 heap (vue-tsc
// + Volar virtual code). Measured on the element-plus benchmark, the checker's
// peak working set splits roughly into: Go live heap ~730-800MB, V8 heap
// ~400MB, runtimes/base ~150MB. Default GOGC=100 lets the Go heap grow to
// ~2x live before collecting; forcing a lower GOGC and a smaller V8
// semi-space size cuts the peak working set meaningfully (see README) without
// affecting diagnostics (GC-only knobs — stdout/stderr/exit code are
// unaffected). Defaults can be overridden or disabled with VUE_TSC_GO_GOGC /
// VUE_TSC_GO_SEMI_SPACE (set to "off" to skip). A user-provided GOGC in the
// environment is always respected.
const MEMORY_TUNE_APPLIED = "VUE_TSC_GO_MEMORY_TUNED";

function tunedGogc() {
	const requested = process.env.VUE_TSC_GO_GOGC ?? "30";
	return !requested || requested === "off" ? null : requested;
}

function tunedSemiSpace() {
	const requested = process.env.VUE_TSC_GO_SEMI_SPACE ?? "4";
	return !requested || requested === "off" ? null : requested;
}

/**
 * Environment for a tuned checker process: GOGC (unless the user set their
 * own) and GODEBUG=asyncpreemptoff=1 applied at process spawn — the bridge
 * normally sets this in JS before loading the Go addon, but the Go runtime
 * only honors it reliably when present at spawn time. Marks the environment
 * with MEMORY_TUNE_APPLIED so the spawned process does not re-exec again.
 */
function tunedEnv(extra) {
	const env = { ...process.env, ...(extra || {}) };
	if (tunedGogc() !== null && !process.env.GOGC) env.GOGC = tunedGogc();
	const godebug = String(env.GODEBUG || "");
	if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(godebug)) {
		env.GODEBUG = godebug ? `${godebug},asyncpreemptoff=1` : "asyncpreemptoff=1";
	}
	env[MEMORY_TUNE_APPLIED] = "1";
	return env;
}

/** Extra node flags for the tuned checker process (V8 semi-space size). */
function tunedNodeFlags() {
	const semi = tunedSemiSpace();
	if (semi === null) return [];
	const present = process.execArgv.some((a) => a.replace(/^--no-?/, "--").startsWith("--max-semi-space-size"));
	return present ? [] : [`--max-semi-space-size=${semi}`];
}

/**
 * The --no-cache path runs the checker in-process; node flags and GOGC must
 * be applied before any code loads, so re-exec once with the tuned
 * environment and flags (stdio/stdin inherited, exit code propagated).
 */
function reExecTuned(extraEnv) {
	const args = [...process.execArgv, ...tunedNodeFlags(), __filename, ...rawArgv];
	const res = spawnSync(process.execPath, args, {
		env: tunedEnv(extraEnv),
		stdio: "inherit",
		windowsHide: true,
	});
	process.exit(typeof res.status === "number" ? res.status : 1);
}

/**
 * Run the actual check in-process (module hook + vue-tsc.run()).
 */
function runCheckInProcess(argvForTsc) {
	// vue-tsc/tsc read process.argv directly — expose only the cleaned args
	process.argv = [process.argv[0], process.argv[1], ...(argvForTsc || [])];
	const Module = require("node:module");
	const originalResolveFilename = Module._resolveFilename;
	Module._resolveFilename = function (request, ...rest) {
		if (request === "typescript") {
			request = path.join(bridgeDir, "lib", "typescript.js");
		} else if (request.startsWith("typescript/")) {
			request = bridgeDir + request.slice("typescript".length);
		}
		return originalResolveFilename.call(this, request, ...rest);
	};

	// Resolve `vue-tsc` from the project being checked (cwd) first, exactly like
	// running the project's own `vue-tsc` binary: the Volar codegen differs
	// between vue-tsc versions (e.g. 3.1.5 vs 3.3.11 emit different virtual code
	// for `<template v-for>` keys and consume different @ts-expect-error
	// directives), so diagnostics only match the original tool when the same
	// vue-tsc version is used. Falls back to the vue-tsc bundled with this
	// package when the project does not declare one.
	let vueTscModule = "vue-tsc";
	try {
		vueTscModule = require.resolve("vue-tsc", { paths: [process.cwd()] });
	} catch {}

	// `vue-tsc`'s bin does: require('../index.js').run();
	require(vueTscModule).run();
}

/**
 * Run the check in a child process and capture stdout/stderr/exit code
 * (used for the cache-miss path so the parent can store the result).
 */
function runCheckInChild(argvForChild, extraEnv) {
	const res = spawnSync(process.execPath, [...process.execArgv, ...tunedNodeFlags(), __filename, ...argvForChild], {
		env: tunedEnv(extraEnv),
		encoding: "buffer",
		stdio: ["inherit", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		stdout: res.stdout ? res.stdout.toString("utf8") : "",
		stderr: res.stderr ? res.stderr.toString("utf8") : "",
		exitCode: typeof res.status === "number" ? res.status : 1,
		spawnError: res.error,
	};
}

/**
 * Write both streams and only then exit (write() on pipes is buffered —
 * exiting early would truncate large outputs).
 */
function emitAndExit(stdoutBuf, stderrBuf, code) {
	let pending = 0;
	const done = () => { if (--pending === 0) process.exit(code); };
	const write = (stream, buf) => {
		if (!buf || buf.length === 0) return;
		pending++;
		if (stream.write(buf)) process.nextTick(done);
		else stream.once("drain", done);
	};
	write(process.stdout, stdoutBuf);
	write(process.stderr, stderrBuf);
	if (pending === 0) process.exit(code);
}

async function main() {
	// cache management only applies to the top-level invocation
	if (!isChild && clear) {
		const tsconfigPath = cacheMod.resolveCacheDir(cacheDirArg, path.join(process.cwd(), "tsconfig.json"));
		workerMod.shutdownWorkers(tsconfigPath).catch(() => {}).then(() => {
			const ok = cacheMod.clearCache(tsconfigPath);
			process.exit(ok ? 0 : 1);
		});
		return;
	}

	if (cacheDisabled) {
		// Apply GC/heap tuning env + node flags (see comment above) unless a
		// parent process already spawned us with them in place.
		if (!process.env[MEMORY_TUNE_APPLIED]) {
			reExecTuned();
			return;
		}
		runCheckInProcess(argv);
		return;
	}

	// --- cache-enabled parent path ---
	// start the session worker (if enabled) before fingerprinting so its boot
	// overlaps the plan computation on cold starts; no-op when disabled/running
	const workerEnabledHere = !noWorker && workerMod.workerAllowed({ env: process.env, isTTY: process.stdout.isTTY });
	if (workerEnabledHere) {
		try { workerMod.preSpawnWorker({ argv, cacheDir: cacheDirArg, env: process.env, cwd: process.cwd() }); } catch {}
	}
	let plan;
	let cacheDir;
	try {
		plan = cacheMod.buildPlan({
			argv,
			cwd: process.cwd(),
			bridgeDir,
			packageDir,
			cacheDir: cacheDirArg,
		});
		if (plan && !plan.skip) {
			cacheDir = cacheMod.resolveCacheDir(cacheDirArg, plan.tsconfigPath);
		}
	} catch {
		plan = { skip: "plan-exception" };
	}

	if (plan && !plan.skip && cacheDir) {
		// session worker path (see bin/worker.js): a resident process keeps the
		// checker pipeline + Go engine session loaded across runs, so a small
		// edit -> re-check loop avoids the child boot and the Go program
		// rebuild entirely. Output guarantees are identical to the cache paths;
		// ANY worker problem degrades to the regular flow below.
		if (workerEnabledHere) {
			try {
				const wr = await workerMod.runViaWorker({ argv, cacheDir, plan, env: process.env });
				if (wr) {
					if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} worker mode=${wr.mode} ms=${wr.ms}\n`);
					return emitAndExit(Buffer.from(wr.stdout, "utf8"), Buffer.from(wr.stderr, "utf8"), wr.exitCode);
				}
				if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} worker unavailable -> regular path\n`);
			} catch (e) {
				if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] worker attempt threw: ${String((e && e.stack) || e)}\n`);
			}
		}
		// hit? (key match + stat-verify of the recorded full-program file manifest,
		// tolerating mtime/size churn on root files whose content hash is unchanged)
		const entry = cacheMod.readEntry(cacheDir, plan.key);
		const entryValid = cacheMod.isEntryUsable(entry, plan);
		if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} plan done key=${plan.key.slice(0, 8)} cacheDir=${cacheDir} entry=${entry ? (entryValid ? "HIT" : "STALE") : "MISS"}\n`);
		if (entry && entryValid) {
			return emitAndExit(
				entry.stdoutBase64 ? Buffer.from(entry.stdoutBase64, "base64") : null,
				entry.stderrBase64 ? Buffer.from(entry.stderrBase64, "base64") : null,
				entry.exitCode,
			);
		}
		// miss (or stale): try an incremental check first (only the changed files
		// and their reverse dependents are re-checked; every other file's
		// diagnostics are replayed from the previous entry), fall back to a full
		// run. Either way the result is captured and stored as a v2 cache entry.
		// See bin/cache.js handleMiss() and bin/cache-incremental.js.
		const missed = cacheMod.handleMiss({
			argv,
			cacheDir,
			plan,
			spawnChild: runCheckInChild,
			dumpTmpBase: path.join(os.tmpdir(), `vue-tsc-go-dump-${process.pid}-${Date.now()}`),
			debug: process.env.VUE_TSC_GO_DEBUG ? (msg) => process.stderr.write(`[vue-tsc-go debug] ${msg}\n`) : null,
		});
		if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} miss handled mode=${missed && missed.mode} exit=${missed && missed.exitCode}\n`);
		if (missed && missed.spawnError) {
			return emitAndExit(null, Buffer.from("vue-tsc-go: failed to spawn checker process: " + String(missed.spawnError) + "\n", "utf8"), 1);
		}
		return emitAndExit(Buffer.from(missed.stdout, "utf8"), Buffer.from(missed.stderr, "utf8"), missed.exitCode);
	} else if (process.env.VUE_TSC_GO_DEBUG) {
		process.stderr.write(`[vue-tsc-go debug] plan skip=${plan && plan.skip}\n`);
	}
	runCheckInProcess(argv);
}

main().catch((e) => {
	// last-resort: never lose the run to an internal async error
	process.stderr.write(`vue-tsc-go: internal error: ${String((e && e.stack) || e)}\n`);
	runCheckInProcess(argv);
});
