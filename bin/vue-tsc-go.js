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
 * Diagnostic cache (see bin/cache.js): when enabled (default on), the CLI
 * process fingerprints the whole check (toolchain + tsconfig chain + full
 * input file set with content hashes + argv + env). On a hit the previous
 * run's stdout/stderr/exit code are replayed byte for byte without starting
 * the checker. On a miss the check runs IN THIS SAME PROCESS (a fully
 * single-process flow: the vue-tsc driver's terminal process.exit() is trapped
 * and turned into the exit code, and stdout/stderr are captured through the
 * stream write methods so the result can be stored in the cache). No resident
 * process is ever involved by default. `--no-cache`, `VUE_TSC_GO_NO_CACHE` or
 * any fingerprinting problem falls back to a plain in-process run.
 *
 * Optional EXPERIMENTAL session worker (bin/worker.js): a resident process
 * that keeps the checker pipeline + Go engine loaded across runs. It is
 * disabled by default and only starts when explicitly requested with
 * VUE_TSC_GO_WORKER=1 (or --worker) — see README ("multi-worktree" caveat).
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const packageDir = path.join(__dirname, "..");
const bridgeDir = path.dirname(require.resolve("typescript-native-bridge/package.json"));
const cacheMod = require("./cache.js");

const rawArgv = process.argv.slice(2);
const { argv, cacheDir: cacheDirArg, clear, worker: workerFlag } = cacheMod.extractCacheArgs(rawArgv);
const cacheDisabled = cacheMod.isCacheDisableRequested(rawArgv, process.env);
const workerMod = require("./worker-client.js");

// --- memory tuning for the checker (Go runtime knobs) ---
//
// The checker hosts BOTH the Go runtime (tsgo engine, live heap dominates the
// peak) and the V8 heap (vue-tsc + Volar virtual code). Measured on the
// element-plus benchmark, the checker's peak working set splits roughly into:
// Go live heap ~730-800MB, V8 heap ~400MB, runtimes/base ~150MB. Default
// GOGC=100 lets the Go heap grow to ~2x live before collecting; forcing a
// lower GOGC cuts the peak working set meaningfully (see README) without
// affecting diagnostics (GC-only knob — stdout/stderr/exit code are
// unaffected). These env vars are applied BEFORE the bridge's Go addon is
// loaded (which happens inside buildPlan): Node on Windows propagates
// process.env writes to the native environment, and the Go runtime reads them
// when it initializes at addon load. (The --no-cache path additionally
// re-execs once to also apply the V8 semi-space flag, see below.) Defaults can
// be overridden or disabled with VUE_TSC_GO_GOGC / VUE_TSC_GO_SEMI_SPACE (set
// to "off" to skip). A user-provided GOGC in the environment is always
// respected.
const MEMORY_TUNE_APPLIED = "VUE_TSC_GO_MEMORY_TUNED";

function tunedGogc() {
	const requested = process.env.VUE_TSC_GO_GOGC ?? "30";
	return !requested || requested === "off" ? null : requested;
}

function tunedSemiSpace() {
	const requested = process.env.VUE_TSC_GO_SEMI_SPACE ?? "4";
	return !requested || requested === "off" ? null : requested;
}

function applyGodebug(env) {
	const godebug = String(env.GODEBUG || "");
	if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(godebug)) {
		env.GODEBUG = godebug ? `${godebug},asyncpreemptoff=1` : "asyncpreemptoff=1";
	}
	return env;
}

/** Apply the Go-runtime tuning to this process before the addon loads. */
function applyGoTuningInProcess() {
	if (tunedGogc() !== null && !process.env.GOGC) process.env.GOGC = tunedGogc();
	applyGodebug(process.env);
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
	applyGodebug(env);
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

/** Install the `typescript` -> bridge module-resolution hook. */
function installBridgeModuleHook() {
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
}

/** Resolve the project's own vue-tsc (falls back to the bundled one). */
function resolveVueTscModule() {
	try {
		return require.resolve("vue-tsc", { paths: [process.cwd()] });
	} catch {}
	return "vue-tsc";
}

/**
 * Run the actual check in-process, uncaptured (module hook + vue-tsc.run());
 * the tsc driver exits the process when done. Used for the --no-cache path
 * (after a tuning re-exec) and for the non-cacheable fallback.
 */
function runCheckInProcess(argvForTsc) {
	// vue-tsc/tsc read process.argv directly — expose only the cleaned args
	process.argv = [process.argv[0], process.argv[1], ...(argvForTsc || [])];
	installBridgeModuleHook();
	require(resolveVueTscModule()).run();
}

/**
 * Run the check in THIS process and capture stdout/stderr/exit code
 * (cache-miss path — keeps the whole flow single-process).
 *
 * The tsc driver ends every run with a terminal `process.exit()`; it is
 * trapped (thrown sentinel) and converted into the exit code. Output is
 * captured by intercepting the stream write methods — the same technique the
 * session worker uses (bin/worker.js runOnce). TTY state is masked so the
 * captured bytes match what a pipe-spawned checker child would produce (that
 * is what cache entries historically store and replay).
 */
/**
 * One-shot stderr banner of the bridge (emitted once per process at first
 * project creation). When several checker runs happen in this process (tier
 * fallback within one cache miss), only the first run captures the banner —
 * later runs must synthesize it so stored/replayed stderr stays byte-identical
 * to a fresh checker child's output.
 */
const TNB_BANNER = "\u258E TNB ACTIVE \u2014 `typescript` is the tsgo-backed fork\n";
let tnbBannerSeen = false;

/** Normalize a captured run's stderr w.r.t. the one-shot bridge banner. */
function finishCaptured(chunks, errChunks, exitCode) {
	let stderr = errChunks.join("");
	if (stderr.startsWith(TNB_BANNER)) {
		tnbBannerSeen = true;
	} else if (tnbBannerSeen) {
		stderr = TNB_BANNER + stderr;
	}
	return { stdout: chunks.join(""), stderr, exitCode };
}

function runCapturedInProcess(argvForTsc, extraEnv) {
	// This process may already have run a checker pass (tier fallback within
	// one miss, or a previous miss): reset the bridge's session-level caches to
	// fresh-child semantics — same mechanism the session worker uses
	// (bin/worker.js runOnce).
	globalThis.__tnbScanCacheReset = true;
	globalThis.__tnbResetDiagCaches = true;
	const envOverlay = { ...(extraEnv || {}) };
	const savedEnv = {};
	for (const k of Object.keys(envOverlay)) {
		savedEnv[k] = process.env[k];
		process.env[k] = envOverlay[k];
	}
	const savedArgv = process.argv;
	const chunks = [];
	const errChunks = [];
	const ow = process.stdout.write;
	const ew = process.stderr.write;
	const oexit = process.exit;
	process.stdout.write = (s) => { chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8")); return true; };
	process.stderr.write = (s) => { errChunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8")); return true; };
	process.exit = (code) => { throw { __vtgExit: true, code: typeof code === "number" ? code : 0 }; };
	const stdoutDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const stderrDesc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
	try {
		Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
		Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
	} catch {}
	try {
		process.argv = [process.argv[0], process.argv[1], ...(argvForTsc || [])];
		installBridgeModuleHook();
		require(resolveVueTscModule()).run();
		// a clean return means the driver finished without process.exit
		const code = typeof process.exitCode === "number" ? process.exitCode : 0;
		return finishCaptured(chunks, errChunks, code);
	} catch (e) {
		if (e && e.__vtgExit) {
			return finishCaptured(chunks, errChunks, e.code);
		}
		// unexpected failure: report it, do not lose the run
		errChunks.push("vue-tsc-go: checker process error: " + String((e && e.stack) || e) + "\n");
		return finishCaptured(chunks, errChunks, 1);
	} finally {
		process.stdout.write = ow;
		process.stderr.write = ew;
		process.exit = oexit;
		process.argv = savedArgv;
		try {
			if (stdoutDesc) Object.defineProperty(process.stdout, "isTTY", stdoutDesc);
			if (stderrDesc) Object.defineProperty(process.stderr, "isTTY", stderrDesc);
		} catch {}
		for (const k of Object.keys(envOverlay)) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	}
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
	if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} start pid=${process.pid} ppid=${process.ppid}\n`);
	// cache management only applies to the top-level invocation
	if (clear) {
		const tsconfigPath = cacheMod.resolveCacheDir(cacheDirArg, path.join(process.cwd(), "tsconfig.json"));
		workerMod.shutdownWorkers(tsconfigPath).catch(() => {}).then(() => {
			const ok = cacheMod.clearCache(tsconfigPath);
			process.exit(ok ? 0 : 1);
		});
		return;
	}

	// Go-runtime memory tuning must be in place before the bridge's Go addon
	// loads (inside buildPlan below) — see the comment at the top.
	applyGoTuningInProcess();

	if (cacheDisabled) {
		// Apply GC/heap tuning env + node flags (see comment above) unless a
		// parent process already spawned us with them in place. The V8
		// semi-space flag can only be set at process start, so re-exec once.
		if (!process.env[MEMORY_TUNE_APPLIED] && tunedSemiSpace() !== null) {
			reExecTuned();
			return;
		}
		runCheckInProcess(argv);
		return;
	}

	// --- cache-enabled path (single process by default) ---
	// EXPERIMENTAL session worker: strictly opt-in (VUE_TSC_GO_WORKER=1 or
	// --worker); see README. Any worker problem degrades to the regular flow.
	const workerEnabledHere = workerMod.workerAllowed({ env: process.env, explicit: workerFlag });
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
		// miss (or stale): try an incremental check first (tier 1: sub-program of
		// the affected closure; tier 2: full program with per-file re-check of
		// the affected closure), fall back to a full run. Either way the result
		// is captured and stored as a v2 cache entry. All runs execute IN THIS
		// PROCESS (see runCapturedInProcess). See bin/cache.js handleMiss() and
		// bin/cache-incremental.js.
		const missed = cacheMod.handleMiss({
			argv,
			cacheDir,
			plan,
			spawnChild: runCapturedInProcess,
			dumpTmpBase: path.join(os.tmpdir(), `vue-tsc-go-dump-${process.pid}-${Date.now()}`),
			debug: process.env.VUE_TSC_GO_DEBUG ? (msg) => process.stderr.write(`[vue-tsc-go debug] ${msg}\n`) : null,
		});
		if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] t=${Date.now()} miss handled mode=${missed && missed.mode} exit=${missed && missed.exitCode}\n`);
		if (missed && missed.spawnError && missed.exitCode !== 0 && missed.stdout === "" && !missed.stderr.includes("checker process error")) {
			// runner never started (should not happen in-process, kept for safety)
			return emitAndExit(null, Buffer.from("vue-tsc-go: failed to run checker: " + String(missed.spawnError) + "\n", "utf8"), 1);
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
