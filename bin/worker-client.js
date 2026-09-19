"use strict";

/**
 * CLI-side counterpart of bin/worker.js: discovers, spawns and talks to the
 * resident session worker over a named pipe. Every failure mode (worker dead,
 * pipe busy, token mismatch, timeout, crash mid-run, baseKey restart) degrades
 * silently to "no worker" — the caller then uses the regular child-process
 * paths, which can only cost time, never correctness.
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const packageDir = path.join(__dirname, "..");

const CONNECT_TIMEOUT_MS = 1500;
const SPAWN_WAIT_MS = 8000; // total budget for a freshly spawned worker to listen
const RUN_TIMEOUT_MS = 600000;

function sha1(data) {
	return crypto.createHash("sha1").update(data).digest("hex");
}

/**
 * Worker gating: STRICT opt-in. The default (no flag, no env) never spawns or
 * contacts a resident worker — multiple parallel worktrees would each grow a
 * ~1GB-class resident process, which is unacceptable, so the worker is an
 * experimental feature that must be requested explicitly via
 * VUE_TSC_GO_WORKER=1 (env) or the --worker CLI flag. --no-worker /
 * VUE_TSC_GO_NO_WORKER=1 disables it even when opted in.
 */
function workerAllowed({ env, explicit }) {
	const no = String(env.VUE_TSC_GO_NO_WORKER || "").toLowerCase();
	if (no === "1" || no === "true" || no === "yes") return false;
	if (explicit) return true;
	const yes = String(env.VUE_TSC_GO_WORKER || "").toLowerCase();
	return yes === "1" || yes === "true" || yes === "yes";
}

function workerDir(cacheDir) {
	return path.join(cacheDir, "worker");
}

function pipeIdentity(cacheDir, tsconfigPath, argv) {
	return sha1(`v1|${process.platform}|${cacheDir}|${tsconfigPath}|${argv.join("\u0000")}`);
}

function pipeNameFor(identity) {
	return `\\\\.\\pipe\\vue-tsc-go-${identity.slice(0, 40)}`;
}

function metaPathFor(cacheDir, identity) {
	return path.join(workerDir(cacheDir), identity + ".json");
}

function readMeta(cacheDir, identity) {
	try {
		const m = JSON.parse(fs.readFileSync(metaPathFor(cacheDir, identity), "utf8"));
		if (m && m.pipe && m.token && Number.isInteger(m.pid)) return m;
	} catch {}
	return null;
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Connect to the worker pipe and complete the token handshake. */
function tryConnect(pipe, token) {
	return new Promise((resolve) => {
		const sock = net.connect({ path: pipe });
		let buf = "";
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			if (!ok) { try { sock.destroy(); } catch {} resolve(null); }
			else resolve(sock);
		};
		const timer = setTimeout(() => finish(false), CONNECT_TIMEOUT_MS);
		sock.setEncoding("utf8");
		sock.on("connect", () => {
			sock.write(JSON.stringify({ handshake: token }) + "\n");
		});
		sock.on("data", (d) => {
			buf += d;
			// the worker answers the handshake with a single ack line
			const i = buf.indexOf("\n");
			if (i === -1) return;
			clearTimeout(timer);
			let ack = null;
			try { ack = JSON.parse(buf.slice(0, i)); } catch {}
			finish(!!(ack && ack.handshake === "ok"));
		});
		sock.on("error", () => { clearTimeout(timer); finish(false); });
	});
}

/**
 * Send one request line and collect exactly one JSON response line.
 * Resolves null on any transport problem (so the caller falls back).
 */
function request(sock, payload, timeoutMs) {
	return new Promise((resolve) => {
		let buf = "";
		let settled = false;
		const finish = (val) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.removeListener("data", onData);
			if (!val) { try { sock.destroy(); } catch {} }
			resolve(val);
		};
		const onData = (d) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i === -1) return;
			let resp = null;
			try { resp = JSON.parse(buf.slice(0, i)); } catch {}
			finish(resp);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		sock.on("data", onData);
		sock.on("error", () => finish(null));
		sock.on("close", () => finish(null));
		sock.write(JSON.stringify(payload) + "\n");
	});
}

/** Tuned spawn environment for the worker (same knobs as the checker child). */
function workerSpawnEnv(env) {
	const e = { ...env, VUE_TSC_GO_WORKER: "1" };
	if (!e.GOGC) e.GOGC = "30";
	const godebug = String(e.GODEBUG || "");
	if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(godebug)) e.GODEBUG = godebug ? `${godebug},asyncpreemptoff=1` : "asyncpreemptoff=1";
	return e;
}

function workerNodeFlags() {
	return process.execArgv.some((a) => a.replace(/^--no-?/, "--").startsWith("--max-semi-space-size"))
		? []
		: ["--max-semi-space-size=4"];
}

function spawnWorker({ cacheDir, identity, env }) {
	const metaPath = metaPathFor(cacheDir, identity);
	const token = crypto.randomBytes(16).toString("hex");
	const idleMs = Number(env.VUE_TSC_GO_WORKER_IDLE_MS) > 0 ? Number(env.VUE_TSC_GO_WORKER_IDLE_MS) : 600000;
	const child = spawn(
		process.execPath,
		[...workerNodeFlags(), path.join(__dirname, "worker.js"), "--pipe", pipeNameFor(identity), "--token", token, "--meta", metaPath, "--idle", String(idleMs)],
		{
			env: workerSpawnEnv(env),
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	);
	child.unref();
	return child;
}

// identities this CLI process has pre-spawned a worker for (token cached so
// the client can connect before the worker's meta file appears)
const pendingSpawns = new Map();

/**
 * Spawn the worker EARLY (before fingerprinting) so its process boot + session
 * pipeline init overlaps the CLI's plan computation on cold starts. Requires
 * only a cheap tsconfig-path resolution — the plan itself follows later.
 */
function pidAlive(pid) {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

function preSpawnWorker({ argv, cacheDirArg, env, cwd }) {
	const cacheMod = require("./cache.js");
	const tsconfigPath = cacheMod.resolveProjectConfigPath(argv, cwd);
	if (!tsconfigPath) return;
	const cacheDir = cacheMod.resolveCacheDir(cacheDirArg, tsconfigPath);
	if (!isWritableDir(cacheDir)) return;
	const identity = pipeIdentity(cacheDir, tsconfigPath, argv);
	const existing = readMeta(cacheDir, identity);
	if (existing && pidAlive(existing.pid)) return; // already running
	if (pendingSpawns.has(identity)) return; // already spawning
	const token = crypto.randomBytes(16).toString("hex");
	const metaPath = metaPathFor(cacheDir, identity);
	const idleMs = Number(env.VUE_TSC_GO_WORKER_IDLE_MS) > 0 ? Number(env.VUE_TSC_GO_WORKER_IDLE_MS) : 600000;
	spawn(process.execPath, [
		...workerNodeFlags(),
		path.join(__dirname, "worker.js"),
		"--pipe", pipeNameFor(identity),
		"--token", token,
		"--meta", metaPath,
		"--idle", String(idleMs),
	], {
		env: workerSpawnEnv(env),
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	}).unref();
	pendingSpawns.set(identity, token);
}

function debugWrite(msg) {
	if (process.env.VUE_TSC_GO_DEBUG) process.stderr.write(`[vue-tsc-go debug] worker: ${msg}\n`);
}

/**
 * Try to run the check via the resident worker. Returns
 *   { mode, stdout, stderr, exitCode, ms, debug? }   on success
 *   null                                             when the caller must fall back
 */
async function runViaWorker({ argv, cacheDir, plan, env }) {
	const identity = pipeIdentity(cacheDir, plan.tsconfigPath, argv);
	const pipe = pipeNameFor(identity);

	let sock = null;
	let meta = readMeta(cacheDir, identity);
	const preSpawnedToken = pendingSpawns.get(identity);
	if (meta) {
		sock = await tryConnect(meta.pipe, meta.token);
		if (!sock) debugWrite("stale worker meta (connect failed), cleaning up");
	}
	if (!sock && !preSpawnedToken) {
		// clean stale meta of a dead worker, then spawn a fresh one
		if (meta) { try { fs.unlinkSync(metaPathFor(cacheDir, identity)); } catch {} }
		if (!isWritableDir(cacheDir)) return null;
		spawnWorker({ cacheDir, identity, env });
	}
	if (!sock) {
		const deadline = Date.now() + SPAWN_WAIT_MS;
		while (Date.now() < deadline && !sock) {
			await sleep(150);
			// the winning worker writes the meta file (its own token) on listen
			meta = readMeta(cacheDir, identity);
			if (meta) sock = await tryConnect(meta.pipe, meta.token);
			else if (preSpawnedToken) sock = await tryConnect(pipe, preSpawnedToken);
		}
		if (!sock) {
			debugWrite("fresh worker did not start listening in time");
			pendingSpawns.delete(identity);
			return null;
		}
	}
	pendingSpawns.delete(identity);

	try {
		const resp = await request(sock, {
			id: 1,
			type: "run",
			cwd: process.cwd(),
			argv,
			cacheDir,
			stderrIsTTY: !!process.stderr.isTTY,
			debug: !!env.VUE_TSC_GO_DEBUG,
			plan: {
				key: plan.key,
				baseKey: plan.baseKey,
				files: plan.files,
				tsconfigPath: plan.tsconfigPath,
				filesCount: plan.filesCount,
			},
		}, RUN_TIMEOUT_MS);
		if (!resp) {
			debugWrite("worker died or timed out mid-run");
			return null;
		}
		if (resp.restart) {
			debugWrite("worker requested restart (session identity change)");
			return null;
		}
		if (resp.ok === false) {
			debugWrite("worker run failed: " + String(resp.fatal || "?").split("\n")[0]);
			return null;
		}
		if (resp.debug && resp.debug.length) for (const d of resp.debug) debugWrite(d);
		return { mode: resp.mode, stdout: resp.stdout, stderr: resp.stderr, exitCode: resp.exitCode, ms: resp.ms };
	} finally {
		try { sock.end(); } catch {}
	}
}

function isWritableDir(cacheDir) {
	try {
		fs.mkdirSync(workerDir(cacheDir), { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/** Kill any workers registered under cacheDir (used by --clear-cache). */
async function shutdownWorkers(cacheDir) {
	const dir = workerDir(cacheDir);
	let names;
	try { names = fs.readdirSync(dir); } catch { return; }
	for (const n of names.filter((x) => x.endsWith(".json"))) {
		let m;
		try { m = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
		if (!m || !m.pipe || !m.token || !Number.isInteger(m.pid)) continue;
		let sock = await tryConnect(m.pipe, m.token).catch(() => null);
		if (sock) {
			await request(sock, { id: 1, type: "shutdown" }, 2000).catch(() => {});
			await sleep(100);
		}
		try { process.kill(m.pid); } catch {}
	}
	await sleep(150);
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

module.exports = {
	workerAllowed,
	runViaWorker,
	shutdownWorkers,
	isWritableDir,
	pipeIdentity,
	preSpawnWorker,
};
