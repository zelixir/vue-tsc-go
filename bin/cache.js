"use strict";

/**
 * vue-tsc-go diagnostic result cache.
 *
 * Goal: repeated invocations of `vue-tsc-go` on an unchanged project skip the
 * whole check and replay the previous run's stdout/stderr/exit code byte for
 * byte.
 *
 * Cache key (sha1) covers EVERYTHING that can influence diagnostics:
 *  - toolchain: vue-tsc-go package version + bin script content, bridge
 *    version + content hash of the patched `lib/typescript.js` /
 *    `lib/_tsc.js` (captures the TNB-PATCH directive-alignment layer state),
 *    the resolved vue-tsc module path, node version, platform
 *  - invocation: full CLI argv passed through to vue-tsc (after stripping
 *    cache-management flags) + relevant env vars (TSGO_*, VUE_TSC_*)
 *  - config: the resolved tsconfig path, the raw text hash of the tsconfig
 *    and its whole `extends` chain (covers vueCompilerOptions), the parsed
 *    compilerOptions (JSON, sorted), the resolved packageJson path+content
 *  - dependency graph: every input file from the parsed command line —
 *    obtained with a `.vue`-aware readDirectory so the root set matches what
 *    vue-tsc actually checks (verified against `--listFiles` on the
 *    element-plus benchmark: 1782 files incl. 458 .vue, exact match) — each
 *    with its sha1 content hash
 *
 * Failure philosophy: when in doubt, don't cache. Any parse error, unreadable
 * file, exotic option (watch/build/incremental, solution-style configs with
 * references, unresolvable vue extra extensions, ...) silently degrades to a
 * full uncached run. Cache write failures (read-only CI) are silent too.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");

const CACHE_FORMAT_VERSION = 2; // v1: whole-run replay only; v2: + incremental metadata
const MAX_ENTRIES = 24;

function sha1(data) {
	return crypto.createHash("sha1").update(data).digest("hex");
}

function sha1File(file) {
	return sha1(fs.readFileSync(file));
}

function isCacheDisableRequested(argv, env) {
	if (argv.includes("--no-cache")) return true;
	if (argv.includes("--clear-cache")) return false; // clearing works even if disabled
	const envVal = String(env.VUE_TSC_GO_NO_CACHE || env.VUE_TSC_GO_CACHE || "").toLowerCase();
	return envVal === "1" || envVal === "true" || envVal === "yes";
}

/** Pull cache-management flags out of argv so the rest is passed to vue-tsc untouched. */
function extractCacheArgs(argv) {
	const rest = [];
	let cacheDir;
	let clear = false;
	let worker = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--no-cache") continue;
		if (a === "--clear-cache") { clear = true; continue; }
		if (a === "--no-worker") continue; // worker is off by default; kept for compatibility
		if (a === "--worker") { worker = true; continue; }
		if (a === "--cache-dir") { cacheDir = argv[++i]; continue; }
		if (a.startsWith("--cache-dir=")) { cacheDir = a.slice("--cache-dir=".length); continue; }
		rest.push(a);
	}
	return { argv: rest, cacheDir, clear, worker };
}

function resolveProjectConfigPath(argv, cwd) {
	let p;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-p" || a === "--project") p = argv[++i];
		else if (a.startsWith("--project=")) p = a.slice("--project=".length);
		else if (a.startsWith("-p=")) p = a.slice(3);
	}
	if (p === undefined) p = "tsconfig.json";
	const abs = path.isAbsolute(p) ? p : path.join(cwd, p);
	let stat;
	try { stat = fs.statSync(abs); } catch { return null; }
	if (stat.isDirectory()) {
		const candidate = path.join(abs, "tsconfig.json");
		try { fs.statSync(candidate); } catch { return null; }
		return candidate;
	}
	return abs;
}

/** tsc/volar modes where "diagnostics" is not the whole (or a deterministic) story. */
const UNSUPPORTED_ARG_PATTERNS = /^(--watch|-w|--build|-b|--incremental|--version|--help|-h|--init|--showConfig|--listFiles|--listEmittedFiles|--explainFiles|--generateCpuprofile|--generateTrace)$/;

function hasUnsupportedArgs(argv) {
	return argv.some(a => UNSUPPORTED_ARG_PATTERNS.test(a));
}

/** Walk the `extends` chain of a tsconfig; returns [{file, json}] or null. */
function loadConfigChain(tsconfigPath, ts) {
	const chain = [];
	const seen = new Set();
	let current = tsconfigPath;
	while (current) {
		const key = current.replace(/\\/g, "/").toLowerCase();
		if (seen.has(key)) return null;
		seen.add(key);
		let configFile;
		try {
			configFile = ts.readConfigFile(current, ts.sys.readFile);
		} catch {
			return null;
		}
		if (configFile.error || !configFile.config || typeof configFile.config !== "object") return null;
		const obj = configFile.config;
		chain.push({ file: current, json: obj });
		let ext = obj.extends;
		if (ext) {
			if (!Array.isArray(ext)) ext = [ext];
			// resolve like tsc: relative to the containing directory, try .json suffix
			let next = null;
			for (const e of ext) {
				const base = path.isAbsolute(e) ? e : path.join(path.dirname(current), e);
				const candidates = base.endsWith(".json") ? [base] : [base, base + ".json"];
				for (const c of candidates) {
					if (ts.sys.fileExists(c)) { next = c; break; }
				}
				if (next) break;
			}
			current = next;
		} else {
			current = null;
		}
	}
	return chain;
}

/** Collect vue-tsc extra file extensions (.vue + vueCompilerOptions extras) from the chain. */
function collectVueExtensions(chain) {
	const exts = new Set([".vue"]);
	for (const { json } of chain) {
		const vue = json.vueCompilerOptions;
		if (!vue) continue;
		for (const key of ["extensions", "vitePressExtensions", "petiteVueExtensions"]) {
			const v = vue[key];
			if (v === undefined) continue;
			if (!Array.isArray(v) || v.some(e => typeof e !== "string")) return null; // exotic → bail
			for (const e of v) exts.add(e.startsWith(".") ? e : "." + e);
		}
	}
	return [...exts];
}

function sortedOptionsJson(options) {
	// options is a flat-ish object of compiler option values; stringify deterministically
	const keys = Object.keys(options).sort();
	const out = {};
	for (const k of keys) {
		const v = options[k];
		if (typeof v === "function") out[k] = String(v);
		else if (v instanceof Map) out[k] = [...v.entries()];
		else if (typeof v === "object" && v !== null) out[k] = String(v);
		else out[k] = v;
	}
	return JSON.stringify(out);
}

/**
 * Build the full cache plan for one invocation.
 * Returns { key, entryDir } on success, or { skip: reason } when caching must not apply.
 *
 * Root-file content hashing uses an mtime+size pre-screen against the previous
 * run's stored stat snapshot (rootmeta.json): only files whose stat changed
 * since the last run are re-read and re-hashed; unchanged files reuse the
 * stored content hash. The final cache key is still a pure content-hash key —
 * the pre-screen only avoids re-reading files that cannot have changed (any
 * stat mismatch forces a fresh read+hash, so a content change is always seen).
 */
function buildPlan({ argv, cwd, bridgeDir, packageDir, cacheDir }) {
	if (hasUnsupportedArgs(argv)) return { skip: "unsupported-args" };

	const ts = require(path.join(bridgeDir, "lib", "typescript.js"));
	const tsconfigPath = resolveProjectConfigPath(argv, cwd);
	if (!tsconfigPath) return { skip: "no-tsconfig" };

	const host = {
		getCurrentDirectory: ts.sys.getCurrentDirectory,
		useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
		readDirectory: ts.sys.readDirectory,
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		getCanonicalFileName: ts.sys.getCanonicalFileName,
		getNewLine: () => "\n",
	};

	const chain = loadConfigChain(tsconfigPath, ts);
	if (!chain) return { skip: "config-chain-unresolvable" };
	const vueExts = collectVueExtensions(chain);
	if (!vueExts) return { skip: "exotic-vue-extensions" };

	// .vue-aware readDirectory so the root file set matches what vue-tsc checks
	const awareHost = {
		...host,
		readDirectory(p, extensions, exclude, include, depth) {
			const exts = [...new Set([...(extensions || []), ...vueExts])];
			return ts.sys.readDirectory(p, exts, exclude, include, depth);
		},
	};

	let parsed;
	try {
		parsed = ts.getParsedCommandLineOfConfigFile(tsconfigPath, {}, awareHost);
	} catch (e) {
		return { skip: "config-parse-exception" };
	}
	if (!parsed) return { skip: "config-parse-failed" };
	if (parsed.errors && parsed.errors.length > 0) return { skip: "config-errors" };

	const raw = parsed.raw || {};
	// `references` only matter for --build (rejected above); solution-style
	// configs (files:[] + references, no own inputs) fall through to the
	// no-inputs check below.
	if (parsed.fileNames.length === 0) return { skip: "no-inputs" };

	// Only cache pure check runs: emit would be a side effect that a cache hit
	// would silently skip, so require --noEmit (CLI or tsconfig).
	if (parsed.options.noEmit !== true && !argv.includes("--noEmit")) {
		return { skip: "emit-mode" };
	}

	// dependency graph: root file set + content hashes. First take a stat
	// snapshot (mtime+size) of every root file — this both feeds the pre-screen
	// below and is stored in the entry as the next run's pre-screen source.
	const tsconfigDirCache = resolveCacheDir(cacheDir, tsconfigPath);
	const statByKey = new Map();
	for (const f of parsed.fileNames) {
		let st;
		try { st = fs.statSync(f); } catch { return { skip: "unreadable-input:" + f }; }
		statByKey.set(canonName(f), [st.size, Math.round(st.mtimeMs)]);
	}

	// toolchain identity
	let bridgeVersion = "unknown";
	try {
		bridgeVersion = JSON.parse(fs.readFileSync(path.join(bridgeDir, "package.json"), "utf8")).version || bridgeVersion;
	} catch {}
	const toolchain = {
		format: CACHE_FORMAT_VERSION,
		vueTscGo: require(path.join(packageDir, "package.json")).version,
		binScript: sha1File(__filename),
		bridgeVersion,
		bridgeTypescriptJs: sha1File(path.join(bridgeDir, "lib", "typescript.js")),
		bridgeTscJs: sha1File(path.join(bridgeDir, "lib", "_tsc.js")),
		vueTscModule: (() => {
			try { return require.resolve("vue-tsc", { paths: [cwd, packageDir] }); }
			catch { return "unresolved"; }
		})(),
		node: process.versions.node,
		platform: process.platform,
	};

	// config identity
	const config = {
		tsconfigPath: tsconfigPath.replace(/\\/g, "/"),
		chainHashes: chain.map(c => sha1File(c.file)),
		options: sortedOptionsJson(parsed.options),
		packageJson: parsed.packageJson
			? parsed.packageJson.replace(/\\/g, "/") + "@" + sha1File(parsed.packageJson)
			: null,
		vueExts,
	};

	// relevant env (pure debug switches must not invalidate the cache)
	const env = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (/^(TSGO_|VUE_TSC_GO_)/i.test(k) && !/^(VUE_TSC_GO_CACHE_DIR|VUE_TSC_GO_NO_CACHE|VUE_TSC_GO_DEBUG)$/i.test(k)) env[k] = v;
	}

	// baseKey: identity of everything except the input file contents — used to
	// find the previous run's entry for incremental reuse (see cache-incremental.js)
	const baseKey = sha1(JSON.stringify({ toolchain, config, env, argv }));

	// content hashes with the mtime+size pre-screen: reuse the previous run's
	// hash when the stat snapshot is unchanged; otherwise read + hash.
	const prior = readLatestRootMeta(tsconfigDirCache, baseKey);
	const priorHashes = prior ? new Map(prior.files.map(([f, h]) => [canonName(f), h])) : null;
	const priorStats = prior && prior.fileStats ? prior.fileStats : null;
	const files = [];
	const fileStats = {};
	for (const f of parsed.fileNames) {
		const c = canonName(f);
		const st = statByKey.get(c);
		const priorStat = priorStats ? priorStats[c] : null;
		let h;
		if (priorStat && priorStat[0] === st[0] && priorStat[1] === st[1] && priorHashes && priorHashes.has(c)) {
			h = priorHashes.get(c); // stat unchanged since the hashed run -> reuse
		} else {
			try { h = sha1File(f); } catch { return { skip: "unreadable-input:" + f }; }
		}
		files.push([f.replace(/\\/g, "/"), h]);
		fileStats[c] = st;
	}
	files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

	const key = sha1(JSON.stringify({ toolchain, config, files, env, argv }));

	return { key, baseKey, files, fileStats, filesCount: files.length, tsconfigPath };
}

/** Sidecar next to the entries dir holding the last run's root stat snapshot. */
function rootMetaPath(cacheDir) {
	return path.join(cacheDir, "rootmeta.json");
}

function readLatestRootMeta(cacheDir, baseKey) {
	if (!cacheDir || !baseKey) return null;
	const m = readJson(rootMetaPath(cacheDir));
	if (!m || m.baseKey !== baseKey || !Array.isArray(m.files)) return null;
	return m;
}

function writeLatestRootMeta(cacheDir, meta) {
	if (!cacheDir || !meta || !meta.baseKey || !Array.isArray(meta.files)) return;
	const file = rootMetaPath(cacheDir);
	const tmp = path.join(cacheDir, `.rootmeta.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(tmp, JSON.stringify(meta), { flag: "wx" });
		fs.renameSync(tmp, file); // atomic on same volume
	} catch {} // best-effort hint only
}

function resolveCacheDir(requested, tsconfigPath) {
	if (requested) return path.resolve(requested);
	const root = path.dirname(tsconfigPath);
	const nm = path.join(root, "node_modules");
	try {
		if (fs.statSync(nm).isDirectory()) return path.join(nm, ".cache", "vue-tsc-go");
	} catch {}
	return path.join(root, ".vue-tsc-go-cache");
}

function entryPath(cacheDir, key) {
	return path.join(cacheDir, "entries", key + ".json");
}

function readEntry(cacheDir, key) {
	let raw;
	try { raw = fs.readFileSync(entryPath(cacheDir, key), "utf8"); } catch { return null; }
	let entry;
	try { entry = JSON.parse(raw); } catch { return null; }
	if (!entry || (entry.format !== CACHE_FORMAT_VERSION && entry.format !== 1) || entry.key !== key) return null;
	return entry;
}

/**
 * Extended hit check: stat-verify the recorded program manifest, tolerating
 * stat changes on root files whose *content* hash is unchanged (editors/git
 * touching files without changing them must not force a full rerun).
 */
function isEntryUsable(entry, plan) {
	if (!entry) return false;
	if (!Array.isArray(entry.programFiles)) return true;
	let rootHashes;
	if (plan && Array.isArray(plan.files)) {
		rootHashes = new Map(plan.files.map(([f, h]) => [canonName(f), h]));
	} else {
		return verifyProgramFiles(entry);
	}
	const oldHashes = Array.isArray(entry.files)
		? new Map(entry.files.map(([f, h]) => [canonName(f), h]))
		: null;
	const fileHashes = entry.fileHashes || null;
	for (const [file, size, mtimeMs] of entry.programFiles) {
		let st;
		try { st = fs.statSync(file); } catch { return false; }
		if (st.size === size && Math.round(st.mtimeMs) === mtimeMs) continue;
		// stat changed: tolerable for a root file with identical content, or for
		// any file whose sha1 still matches the stored one (regenerated files)
		const c = canonName(file);
		if (rootHashes.has(c) && oldHashes && oldHashes.get(c) === rootHashes.get(c)) continue;
		let content;
		try { content = fs.readFileSync(file); } catch { return false; }
		if (fileHashes && fileHashes[c] === sha1(content)) continue;
		return false;
	}
	return true;
}

function canonName(p) {
	const s = String(p).replace(/\\/g, "/");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Content hashes + ambient-risk classification for the non-root program files
 * (node_modules d.ts, generated files like Volar's .vue-global-types). Needed
 * because some generated files are rewritten (fresh mtime, identical content)
 * on every checker run, so mtime/size verification alone misfires; a sha1
 * comparison settles it. The risk classification (see cache-incremental.js)
 * feeds the sub-program incremental tier.
 */
function computeFileMeta(programFiles, rootSet) {
	const { isAmbientRiskyText } = require("./cache-incremental.js");
	const hashes = {};
	const risky = [];
	for (const [file] of programFiles || []) {
		const c = canonName(file);
		if (rootSet.has(c)) continue;
		let content;
		try {
			content = fs.readFileSync(file);
		} catch {} // unreadable -> omitted; stat check stays authoritative
		if (content === undefined) continue;
		hashes[c] = sha1(content);
		try {
			if (isAmbientRiskyText(content.toString("utf8"))) risky.push(c);
		} catch {}
	}
	return { hashes, risky };
}

function computeFileHashes(programFiles, rootSet) {
	return computeFileMeta(programFiles, rootSet).hashes;
}

function writeEntry(cacheDir, key, payload) {
	const entry = {
		format: CACHE_FORMAT_VERSION,
		key,
		baseKey: payload.baseKey || null,
		createdAt: new Date().toISOString(),
		stdoutBase64: payload.stdoutBase64,
		stderrBase64: payload.stderrBase64,
		exitCode: payload.exitCode,
		programFiles: payload.programFiles || null,
		// v2 incremental metadata (see cache-incremental.js)
		files: payload.files || null,
			graph: payload.graph || null,
			fileDiags: payload.fileDiags || null,
			syntacticDiags: payload.syntacticDiags || null,
			flags: payload.flags || null,
		fileHashes: payload.fileHashes || null,
		fileStats: payload.fileStats || null,
		programRisky: payload.programRisky || null,
	};
	const dir = path.join(cacheDir, "entries");
	const file = entryPath(cacheDir, key);
	const tmp = path.join(dir, `.${key}.${process.pid}.${Date.now()}.tmp`);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(entry), { flag: "wx" });
	fs.renameSync(tmp, file); // atomic on same volume
	// sidecar hint for the next run's fingerprint pre-screen (best effort)
	writeLatestRootMeta(cacheDir, {
		baseKey: entry.baseKey,
		files: payload.files || null,
		fileStats: payload.fileStats || null,
	});
	// opportunistic pruning, best effort
	try {
		const names = fs.readdirSync(dir).filter(n => n.endsWith(".json"));
		if (names.length > MAX_ENTRIES) {
			const stats = names.map(n => {
				const st = fs.statSync(path.join(dir, n));
				return { n, m: st.mtimeMs };
			}).sort((a, b) => a.m - b.m);
			for (const s of stats.slice(0, names.length - MAX_ENTRIES)) {
				try { fs.unlinkSync(path.join(dir, s.n)); } catch {}
			}
		}
	} catch {}
}

/**
 * Stat-verify the recorded full-program file manifest of an entry.
 * Catches changes to files that are pulled into the program transitively
 * (monorepo workspace packages, node_modules d.ts, ...) and are therefore not
 * part of the tsconfig root file set hashed into the key. A changed size or
 * mtime means the entry must not be reused. Missing manifest (dump patch not
 * applied) → nothing to verify.
 */
function verifyProgramFiles(entry) {
	if (!entry || !Array.isArray(entry.programFiles)) return true;
	for (const [file, size, mtimeMs] of entry.programFiles) {
		let st;
		try { st = fs.statSync(file); } catch { return false; }
		if (st.size !== size || Math.round(st.mtimeMs) !== mtimeMs) return false;
	}
	return true;
}

function clearCache(cacheDir) {
	try {
		fs.rmSync(path.join(cacheDir, "entries"), { recursive: true, force: true });
		removeQuiet(rootMetaPath(cacheDir));
		return true;
	} catch { return false; }
}

function readJson(file) {
	try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function removeQuiet(file) {
	try { fs.unlinkSync(file); } catch {}
}

/**
 * Handle a cache miss: first try the incremental path (bin/cache-incremental.js
 * — re-check only the changed files and their reverse dependents, replay the
 * rest from the previous entry), and fall back to a full run. Either way the
 * captured result is stored as a v2 entry so future runs can replay or
 * incrementally extend it.
 */
function handleMiss({ argv, cacheDir, plan, spawnChild, dumpTmpBase, debug }) {
	const inc = require("./cache-incremental.js");
	if (plan && plan.baseKey && Array.isArray(plan.files) && plan.files.length) {
		try {
			const r = inc.tryIncremental({ argv, cacheDir, plan, tmpBase: dumpTmpBase, spawnChild, readEntry, debug });
			if (r) return r;
		} catch (e) {
			if (debug) debug("incremental attempt threw, falling back to full run: " + String((e && e.stack) || e));
		}
	}

	// full run; the dumps provide the v2 metadata (program file manifest,
	// resolution graph, per-file diagnostics) for future incremental runs
	const progDump = dumpTmpBase + ".progfiles.json";
	const graphDump = dumpTmpBase + ".graph.json";
	const diagDump = dumpTmpBase + ".diags.json";
	const synDump = dumpTmpBase + ".syndiags.json";
	const result = spawnChild(argv, {
		VUE_TSC_GO_INTERNAL_CHILD: "1",
		VUE_TSC_GO_DUMP_FILES: progDump,
		VUE_TSC_GO_DUMP_GRAPH: graphDump,
		VUE_TSC_GO_DUMP_DIAGS: diagDump,
		VUE_TSC_GO_DUMP_SYNDIAGS: synDump,
	});
	if (result.spawnError) return { mode: "full", spawnError: result.spawnError, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
	const programFiles = readJson(progDump);
	const graphDumped = readJson(graphDump);
	const diagsDumped = readJson(diagDump);
	const synDumped = readJson(synDump);
	const rootSet = new Set(plan.files.map(([f]) => canonName(f)));
	const meta = programFiles ? computeFileMeta(programFiles, rootSet) : { hashes: null, risky: null };
	try {
		writeEntry(cacheDir, plan.key, {
			stdoutBase64: Buffer.from(result.stdout, "utf8").toString("base64"),
			stderrBase64: Buffer.from(result.stderr, "utf8").toString("base64"),
			exitCode: result.exitCode,
			programFiles,
			baseKey: plan.baseKey,
			files: plan.files || null,
			fileStats: plan.fileStats || null,
			graph: graphDumped ? inc.canonEdges(graphDumped.edges) : null,
			fileDiags: diagsDumped && !diagsDumped.fileless ? diagsDumped.byFile : null,
			syntacticDiags: synDumped && !synDumped.fileless ? synDumped.byFile : null,
			fileHashes: meta.hashes,
			programRisky: meta.risky,
			flags: plan.files
				? {
					...inc.computeRootFlags(plan.files),
					filelessDiags: diagsDumped ? !!diagsDumped.fileless : true,
					unresolvedRelative: graphDumped ? !!graphDumped.unresolvedRelative : true,
				}
				: null,
		});
	} catch {} // read-only fs / no permission → silent degradation
	removeQuiet(progDump);
	removeQuiet(graphDump);
	removeQuiet(diagDump);
	removeQuiet(synDump);
	return { mode: "full", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

module.exports = {
	isCacheDisableRequested,
	extractCacheArgs,
	buildPlan,
	resolveCacheDir,
	resolveProjectConfigPath,
	readEntry,
	writeEntry,
	verifyProgramFiles,
	isEntryUsable,
	handleMiss,
	computeFileHashes,
	computeFileMeta,
	canonName,
	readLatestRootMeta,
	writeLatestRootMeta,
	clearCache,
	sha1,
};
