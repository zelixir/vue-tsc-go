#!/usr/bin/env node
"use strict";

/**
 * vue-tsc-go session worker (bin/worker.js).
 *
 * A resident, on-demand Node process that keeps the whole checker pipeline
 * (module hook + vue-tsc + transformed tsc bundle + in-process Go engine)
 * loaded across CLI invocations, so an "edit a file -> typecheck again" loop
 * pays neither the child-process boot (~0.6s) nor the Go program rebuild
 * (~1.5s) again: within one session a re-run only pushes changed file
 * snapshots into the persistent Go engine session and re-checks.
 *
 * Protocol (newline-delimited JSON over a Windows named pipe / unix socket):
 *   client -> worker: first line {"token": "..."} handshake, then requests
 *     {"id", "type": "run",  "cwd", "argv", "cacheDir", "plan": {key, baseKey, files, tsconfigPath}}
 *     {"id", "type": "shutdown"}
 *   worker -> client: {"id", "ok", "mode", "stdout", "stderr", "exitCode", ...}
 *
 * Session identity = (baseKey, cwd). A request with a different identity is
 * answered with {"restart": true} and the worker exits (CLI falls back and a
 * fresh worker picks the new identity up on the next run) — this bounds the
 * resident memory to ONE Go program (~1-1.5GB) per worker and avoids stale
 * module caches after toolchain changes.
 *
 * Correctness contract (identical to the disk incremental cache):
 *  - every run's stdout/stderr/exitCode must equal a fresh full run; the
 *    worker uses the exact same conservative invalidation rules
 *    (bin/cache-incremental.js) and the same post-run double checks
 *    (program-gained-unknown-files / lost-risky-files) before serving an
 *    incremental result; any doubt -> full re-run inside the worker;
 *  - every full/incremental run is written to the disk v2 cache so a dead
 *    worker degrades to the existing cache paths, never to wrong output.
 *
 * The worker exits after VUE_TSC_GO_WORKER_IDLE_MS (default 10 min) without
 * requests. It is spawned on demand by bin/worker-client.js and is NOT a
 * watch-mode process: no file system watching, no proactive work.
 */

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageDir = path.join(__dirname, "..");
const bridgeDir = path.dirname(require.resolve("typescript-native-bridge/package.json"));
const libTs = require(path.join(bridgeDir, "lib", "typescript.js")); // tnbNoteExternalFileChange
const cacheMod = require("./cache.js");
const incMod = require("./cache-incremental.js");

// ── CLI args ────────────────────────────────────────────────────────────────
let pipeName = null;
let token = null;
let metaPath = null;
let idleMs = 600000;
for (let i = 2; i < process.argv.length; i++) {
	const a = process.argv[i];
	if (a === "--pipe") pipeName = process.argv[++i];
	else if (a === "--token") token = process.argv[++i];
	else if (a === "--meta") metaPath = process.argv[++i];
	else if (a === "--idle") idleMs = Number(process.argv[++i]) || 600000;
}
if (!pipeName || !token || !metaPath) {
	try { require("node:fs").writeFileSync(String(metaPath || "") + ".err", "missing args"); } catch {}
	process.exit(2); // misused; stay silent
}

// ── module hook (must be installed before anything TS-ish loads) ────────────
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

process.title = "vue-tsc-go worker";
// role flag consumed by the TNB-WORKERPASS patch in the bridge bundle; distinct
// from VUE_TSC_GO_WORKER (the client opt-in) so CLI checker children that
// inherit the opt-in env do NOT take the worker branch
process.env.VUE_TSC_GO_WORKER_ROLE = "1";

// ── session state ───────────────────────────────────────────────────────────
let api = null; // { sys, executeCommandLine } exposed by the TNB-WORKERPASS patch
let session = null;
// session = {
//   baseKey, cwd, argvKey, vueTscModule,
//   key,                       // plan.key of the last completed run
//   result: {stdout, stderr, exitCode},
//   entry:  {format:2, files, graph, fileDiags, fileHashes, flags, programFiles}, // v2 entry fields of the last run
// }
const debugLog = [];
function debug(msg) {
	if (debugLog.length < 200) debugLog.push(msg);
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function removeQuiet(file) { try { fs.unlinkSync(file); } catch {} }

let warmCwd = null; // cwd whose pipeline is already loaded (boot-time warm start)
let warmPromise = null; // in-flight boot-time warm start

/**
 * Load the checker pipeline without creating a session: chdir to the project,
 * resolve the project's own vue-tsc (same rule as the CLI child) and evaluate
 * the transformed tsc bundle. With VUE_TSC_GO_WORKER_ROLE=1 the patched bundle
 * does NOT execute the command line; it exposes { sys, executeCommandLine }.
 * If the pipeline is already loaded for the same cwd, only chdir is needed.
 */
function ensurePipeline(cwd) {
	process.chdir(cwd);
	if (api && warmCwd === cwd) return "vue-tsc (warm)";
	let vueTscModule = "vue-tsc";
	try {
		vueTscModule = require.resolve("vue-tsc", { paths: [cwd] });
	} catch {}
	if (!api || warmCwd !== cwd) {
		// drop cached project toolchain modules so a toolchain upgrade mid-session
		// is picked up on session (re)start
		for (const key of Object.keys(require.cache)) {
			if (key === vueTscModule || key.startsWith(path.dirname(vueTscModule) + path.sep)) {
				delete require.cache[key];
			}
		}
		require(vueTscModule).run();
	}
	api = globalThis.__vueTscGoWorkerApi;
	if (!api || !api.sys || typeof api.executeCommandLine !== "function") {
		throw new Error("worker: bridge did not expose the worker API (VUE_TSC_GO_WORKER patch missing?)");
	}
	warmCwd = cwd;
	return vueTscModule;
}

function initSession(cwd, argv) {
	process.argv = [process.execPath, __filename, ...argv];
	const vueTscModule = ensurePipeline(cwd);
	return vueTscModule;
}

/**
 * Run one check in-process. Byte-exact output is captured by intercepting the
 * stdout/stderr write methods the tsc sys object uses; the tsc driver's final
 * system.exit() (a dynamic process.exit call) is trapped and turned into the
 * exit code. Any unexpected error is reported as {fatal} so the CLI can fall
 * back to a fresh child process (correctness over speed).
 */
function runOnce(argv, envOverlay, stderrTTY) {
	globalThis.__tnbScanCacheReset = true; // directive-alignment text cache may hold stale file content
	globalThis.__tnbResetDiagCaches = true; // bridge per-file/program diagnostic caches must start empty each run (fresh-child semantics)
	// The bridge's one-shot stderr banner is suppressed in worker mode (see
	// scripts/patch-tnb-directives.js); a fresh child would print it as the
	// first stderr bytes, so synthesize it here with the requesting CLI's
	// stderr TTY state to stay byte-identical.
	const banner = (stderrTTY ? "\u001B[2m\u258E TNB ACTIVE \u2014 `typescript` is the tsgo-backed fork\u001B[0m\n" : "\u258E TNB ACTIVE \u2014 `typescript` is the tsgo-backed fork\n");
	const savedEnv = {};
	for (const k of Object.keys(envOverlay)) {
		savedEnv[k] = process.env[k];
		process.env[k] = envOverlay[k];
	}
	const chunks = [];
	const errChunks = [];
	const ow = process.stdout.write;
	const ew = process.stderr.write;
	const oexit = process.exit;
	process.stdout.write = (s) => { chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8")); return true; };
	process.stderr.write = (s) => { errChunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf8")); return true; };
	process.exit = (code) => { throw { __vtgExit: true, code: typeof code === "number" ? code : 0 }; };
	const savedExitCode = process.exitCode;
	process.exitCode = undefined;
	const savedArgs = api.sys.args;
	api.sys.args = argv;
	process.argv = [process.execPath, __filename, ...argv];
	let exitCode = 0;
	let fatal = null;
	// vue-tsc's run() retries its main() when the language plugins report
	// "extensions changed" (extra vueCompilerOptions extensions); in the worker
	// that throw surfaces out of executeCommandLine, so retry here (the plugin
	// closure records the full extension set before throwing).
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				api.executeCommandLine(api.sys, () => {}, argv);
				exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
				break;
			} catch (e) {
				if (e && e.__vtgExit) {
					exitCode = e.code;
					break;
				}
				fatal = String((e && e.stack) || e);
				if (attempt < 5 && /extensions changed/i.test(fatal)) {
					fatal = null;
					continue;
				}
				break;
			}
		}
	} finally {
		process.stdout.write = ow;
		process.stderr.write = ew;
		process.exit = oexit;
		process.exitCode = savedExitCode;
		api.sys.args = savedArgs;
		for (const k of Object.keys(envOverlay)) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
	}
	return { stdout: chunks.join(""), stderr: banner + errChunks.join(""), exitCode, fatal };
}

/** Extract per-file diagnostics for a finished full run (TNB dump patches). */
function collectFullEntry(plan, progDump, graphDump, diagDump, synDump) {
	const programFiles = readJson(progDump);
	const graphDumped = readJson(graphDump);
	const diagsDumped = readJson(diagDump);
	const synDumped = readJson(synDump);
	const rootSet = new Set(plan.files.map(([f]) => incMod.canon(f)));
	return {
		programFiles,
		entry: {
			format: 2,
			files: plan.files,
			graph: graphDumped ? incMod.canonEdges(graphDumped.edges) : null,
			fileDiags: diagsDumped && !diagsDumped.fileless ? diagsDumped.byFile : null,
			syntacticDiags: synDumped && !synDumped.fileless ? synDumped.byFile : null,
			fileHashes: programFiles ? cacheMod.computeFileHashes(programFiles, rootSet) : null,
			flags: plan.files
				? {
					...incMod.computeRootFlags(plan.files),
					filelessDiags: diagsDumped ? !!diagsDumped.fileless : true,
					unresolvedRelative: graphDumped ? !!graphDumped.unresolvedRelative : true,
				}
				: null,
			programFiles,
		},
	};
}

/**
 * Diff the session's stored root file set against the new plan: returns the
 * original (non-canon) paths of changed / added / deleted files. The worker
 * notifies the Go engine about changed files via the bridge's external-change
 * API (the same mechanism tsc --watch uses) so its snapshots are invalidated
 * and re-read from disk before the re-check.
 */
function diffFiles(oldFiles, newFiles) {
	const changed = [];
	const added = [];
	const deleted = [];
	if (!Array.isArray(oldFiles)) return { changed, added, deleted };
	const oldMap = new Map(oldFiles.map(([f, h]) => [incMod.canon(f), h]));
	const newMap = new Map(newFiles.map(([f, h]) => [incMod.canon(f), h]));
	for (const [cf, h] of newMap) {
		const orig = newFiles.find(([p]) => incMod.canon(p) === cf)[0];
		if (!oldMap.has(cf)) added.push(orig);
		else if (oldMap.get(cf) !== h) changed.push(orig);
	}
	for (const [cf] of oldMap) {
		if (!newMap.has(cf)) deleted.push(oldFiles.find(([p]) => incMod.canon(p) === cf)[0]);
	}
	return { changed, added, deleted };
}

function writeDiskEntry(cacheDir, key, result, entry) {	try {
		cacheMod.writeEntry(cacheDir, key, {
			stdoutBase64: Buffer.from(result.stdout, "utf8").toString("base64"),
			stderrBase64: Buffer.from(result.stderr, "utf8").toString("base64"),
			exitCode: result.exitCode,
			programFiles: entry.programFiles,
			baseKey: entry.baseKey,
			files: entry.files,
			graph: entry.graph,
			fileDiags: entry.fileDiags,
			syntacticDiags: entry.syntacticDiags || null,
			fileHashes: entry.fileHashes,
			flags: entry.flags,
		});
	} catch {} // read-only fs -> silent
}

function handleRun(req) {
	const plan = req.plan;
	const argvKey = JSON.stringify(req.argv);

	// session identity: a different toolchain/config/argv/cwd -> restart
	if (session && (session.baseKey !== plan.baseKey || session.cwd !== req.cwd || session.argvKey !== argvKey)) {
		debug(`session identity change (baseKey ${session.baseKey === plan.baseKey ? "same" : "diff"}, cwd ${session.cwd === req.cwd ? "same" : "diff"}) -> restart`);
		return { ok: false, restart: true, mode: "restart" };
	}
	if (!session) {
		const t0 = Date.now();
		const vueTscModule = initSession(req.cwd, req.argv);
		session = {
			baseKey: plan.baseKey,
			cwd: req.cwd,
			argvKey,
			vueTscModule,
			key: null,
			result: null,
			entry: null,
		};
		debug(`session init in ${Date.now() - t0}ms vue-tsc=${vueTscModule}`);
	}

	// 1) replay: same content set as the last run served by this session and
	//    the program manifest still stat-verifies (node_modules etc. unchanged)
	if (session.result && session.key === plan.key && session.entry && cacheMod.isEntryUsable(session.entry, plan)) {
		debug("mode=replay");
		return { ok: true, mode: "replay", ...session.result };
	}

	const tmpBase = path.join(os.tmpdir(), `vue-tsc-go-worker-${process.pid}-${Date.now()}`);
	const progDump = tmpBase + ".progfiles.json";
	const graphDump = tmpBase + ".graph.json";
	const diagDump = tmpBase + ".diags.json";
	const synDump = tmpBase + ".syndiags.json";
	try {
		// content changes: invalidate the engine's snapshots for these files
		// (same mechanism as tsc --watch); the overlay sync at the start of
		// the check consumes the notes and re-reads them from disk
		let prep = null;
		if (session.entry) {
			const diff = diffFiles(session.entry.files, plan.files);
			if (diff.added.length || diff.deleted.length) {
				// file-set changes can shift module resolution in ways the
				// session update cannot fully express -> restart the session
				// (the CLI falls back and a fresh worker adopts the new set)
				debug(`file set changed (+${diff.added.length}/-${diff.deleted.length}) -> restart`);
				return { ok: false, restart: true, mode: "restart" };
			}
			for (const f of diff.changed) {
				try { libTs.tnbNoteExternalFileChange(f); } catch {}
			}
			if (diff.changed.length) debug(`external change notes: ${diff.changed.length}`);
			// per-file incremental: re-check only the reverse-dependent closure,
			// replay every other file's diagnostics from session memory
			try {
				prep = incMod.prepareIncremental({ plan, oldEntry: session.entry, tmpBase, debug });
			} catch (e) {
				debug("prepareIncremental threw: " + String((e && e.stack) || e));
			}
		}

		if (prep) {
			debug(`incremental: affected=${prep.affectedList.length} of ${plan.files.length}`);
			const res = runOnce(req.argv, {
				VUE_TSC_GO_DUMP_FILES: progDump,
				VUE_TSC_GO_DUMP_GRAPH: graphDump,
				VUE_TSC_GO_INCREMENTAL: prep.manifestPath,
				...(session.entry.syntacticDiags ? { VUE_TSC_GO_MIX_SYNTACTIC: "1" } : {}),
			}, !!req.stderrIsTTY);
			if (!res.fatal) {
				const programFiles = readJson(progDump);
				const graphDumped = readJson(graphDump);
				let ok = !!programFiles && !!graphDumped && fs.existsSync(prep.freshDump);
				if (ok && prep.cachedSyntactic && !fs.existsSync(prep.freshSyntacticDump)) ok = false;
				if (ok && incMod.programGainedUnknownFiles(programFiles, session.entry, plan)) {
					debug("incremental: program gained unknown files -> full rerun");
					ok = false;
				}
				if (ok && incMod.programLostRiskyFiles(programFiles, session.entry, plan)) {
					debug("incremental: program lost risky file -> full rerun");
					ok = false;
				}
				if (ok) {
					const fileDiags = incMod.mergeFileDiags(prep.cachedManifest, prep.freshDump, prep.deleted, new Set(prep.affectedList));
					const syntacticDiags = prep.cachedSyntactic
						? incMod.mergeFileDiags(prep.cachedSyntactic, prep.freshSyntacticDump, prep.deleted, new Set(prep.affectedList))
						: null;
					if (fileDiags && (!prep.cachedSyntactic || syntacticDiags)) {
						const rootSet = new Set(plan.files.map(([f]) => incMod.canon(f)));
						const entry = {
							format: 2,
							baseKey: plan.baseKey,
							files: plan.files,
							graph: incMod.canonEdges(graphDumped.edges),
							fileDiags,
							syntacticDiags,
							fileHashes: cacheMod.computeFileHashes(programFiles, rootSet),
							flags: {
								...incMod.computeRootFlags(plan.files),
								filelessDiags: false,
								unresolvedRelative: !!graphDumped.unresolvedRelative,
							},
							programFiles,
						};
						session.key = plan.key;
						session.result = { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
						session.entry = entry;
						writeDiskEntry(req.cacheDir, plan.key, session.result, entry);
						debug("incremental: ok");
						return { ok: true, mode: "incremental", ...session.result };
					}
				}
				debug("incremental aborted -> full rerun");
			} else {
				debug("incremental run fatal -> full rerun");
			}
		}

		// full run inside the worker (also the metadata producer for the disk
		// cache's incremental path used by non-worker runs)
		const res = runOnce(req.argv, {
			VUE_TSC_GO_DUMP_FILES: progDump,
			VUE_TSC_GO_DUMP_GRAPH: graphDump,
			VUE_TSC_GO_DUMP_DIAGS: diagDump,
			VUE_TSC_GO_DUMP_SYNDIAGS: synDump,
		}, !!req.stderrIsTTY);
		if (res.fatal) {
			debug("full run fatal: " + res.fatal);
			return { ok: false, fatal: res.fatal, mode: "full", stdout: res.stdout, stderr: res.stderr, exitCode: 1 };
		}
		const collected = collectFullEntry(plan, progDump, graphDump, diagDump, synDump);
		collected.entry.baseKey = plan.baseKey;
		session.key = plan.key;
		session.result = { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode };
		session.entry = collected.entry;
		writeDiskEntry(req.cacheDir, plan.key, session.result, collected.entry);
		debug(`full: ok program=${(collected.entry.programFiles || []).length} files`);
		return { ok: true, mode: "full", ...session.result };
	} finally {
		removeQuiet(progDump);
		removeQuiet(graphDump);
		removeQuiet(diagDump);
	}
}

// ── request scheduling (strictly serialized: session state is shared) ───────
let chain = Promise.resolve();

function handleLine(line, sock, state) {
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (!msg) return;
	// first line of every connection must be the token handshake
	if (!state.authed) {
		if (msg.handshake !== token) {
			try { sock.destroy(); } catch {}
			return;
		}
		state.authed = true;
		send(sock, { handshake: "ok" });
		return;
	}
	if (typeof msg.id !== "number") return;
	if (msg.type === "shutdown") {
		send(sock, { id: msg.id, ok: true, mode: "shutdown" });
		setTimeout(() => process.exit(0), 150);
		return;
	}
	if (msg.type === "run") {
		const t0 = Date.now();
		chain = chain.then(async () => {
			let resp;
			try {
				if (warmPromise) { await warmPromise; warmPromise = null; }
				resp = handleRun(msg);
			} catch (e) {
				resp = { ok: false, fatal: String((e && e.stack) || e), mode: "error" };
			}
			resp.id = msg.id;
			resp.ms = Date.now() - t0;
			if (debugLog.length && msg.debug) resp.debug = debugLog.splice(0);
			send(sock, resp);
			if (resp.restart) setTimeout(() => process.exit(0), 300);
		}).catch(() => {});
		return;
	}
	// unknown type: ignore
}

function send(sock, obj) {
	try { sock.write(JSON.stringify(obj) + "\n"); } catch {}
}

// ── idle self-exit ──────────────────────────────────────────────────────────
let idleTimer = null;
function armIdle() {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		cleanupMeta();
		process.exit(0);
	}, idleMs);
	idleTimer.unref();
}

function cleanupMeta() {
	try { fs.unlinkSync(metaPath); } catch {}
}

process.on("exit", cleanupMeta);

// ── server ──────────────────────────────────────────────────────────────────
const server = net.createServer((sock) => {
	sock.setEncoding("utf8");
	const state = { authed: false };
	let buf = "";
	sock.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (line.trim()) handleLine(line, sock, state);
		}
	});
	sock.on("error", () => {});
});

server.on("error", (e) => {
	try { fs.writeFileSync(metaPath + ".err", String((e && e.stack) || e)); } catch {}
	process.exit(3);
}); // pipe name taken by another worker -> lose the race, exit silently

server.listen(pipeName, () => {
	try {
		fs.mkdirSync(path.dirname(metaPath), { recursive: true });
		fs.writeFileSync(metaPath, JSON.stringify({
			pipe: pipeName,
			token,
			pid: process.pid,
			createdAt: new Date().toISOString(),
		}));
	} catch (e) {
		process.exit(4);
	}
	armIdle();
	// boot-time warm start: load the pipeline for the spawning CLI's cwd while
	// the CLI is still computing its fingerprint (overlaps ~200-300ms on cold
	// starts); the first run request awaits it instead of re-initializing
	warmPromise = new Promise((resolve) => {
		setTimeout(() => {
			try { ensurePipeline(process.cwd()); debug("boot pipeline warm"); } catch (e) { debug("boot warm failed: " + String((e && e.stack) || e)); }
			resolve();
		}, 30);
	});
});
