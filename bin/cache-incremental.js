"use strict";

/**
 * vue-tsc-go incremental diagnostic cache.
 *
 * Upgrades the whole-run cache (bin/cache.js) to an incremental one for the
 * real-world "edit a few files -> run typecheck again" scenario.
 *
 * Idea: tsc prints diagnostics file by file, and a file's semantic diagnostics
 * depend only on its own content plus the contents of its *transitive import
 * closure* (this is the same invariant tsc --incremental / tsserver rely on).
 * So after changing k files, only the changed files and their reverse
 * transitive dependents can possibly have different diagnostics; every other
 * file's diagnostics can be replayed from the previous run.
 *
 * Mechanism:
 *  - Every full run stores (besides the whole-run replay payload) a module
 *    resolution graph (from the Go engine's program resolution info, dumped by
 *    the TNB-GRAPHPATCH bridge patch) and per-file diagnostics (serialized by
 *    the TNB-INCRPATCH bridge patch).
 *  - On the next run with a different file-content set, the parent diffs the
 *    root file hashes, computes the reverse transitive dependent closure of
 *    the changed files over the stored graph, and hands the child process a
 *    manifest: { affected: [...], cached: { file: [serialized diags] } }.
 *  - The patched bridge wrapper then checks only the affected files through
 *    the Go engine's per-file diagnostic API and rehydrates every other
 *    file's diagnostics from the manifest; the tsc driver sees exactly the
 *    same diagnostic multiset as a full run would produce (sorted and
 *    deduplicated downstream), so stdout/exit code are byte-identical.
 *  - The fresh per-file diagnostics of the affected files are dumped back and
 *    merged into the new cache entry, keeping the invariant for the run after.
 *
 * Failure philosophy: any doubt -> full run. The decision procedure below
 * returns null (full run) whenever an invariant cannot be proven (added
 * files, global-scope/augmentation constructs, non-root file changes, missing
 * v2 metadata, oversized affected sets, ...). The bridge-side hook also falls
 * back to the whole-program pass on any error, so a bug can only cost time,
 * never correctness.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const AFFECTED_ABS_MAX = 400; // absolute cap: beyond this a full run is cheaper
const AFFECTED_RATIO_MAX = 0.4; // relative cap on the root file set

function sha1(data) {
	return crypto.createHash("sha1").update(data).digest("hex");
}

function canon(p) {
	const s = String(p).replace(/\\/g, "/");
	return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * Conservative text-level classification of a root source file:
 *  - moduleLike: has a top-level import/export statement looking line. A file
 *    that is not a module participates in global-scope merging, so a change
 *    to it can alter diagnostics of unrelated files -> full run.
 *    .vue files are always fed to the checker as generated module code.
 *  - augmentationRisk: `declare global` / `declare module` — ambient merging
 *    can affect files that do not import this one -> full run.
 *  - emptyish: whitespace/comments only — contributes nothing to the global
 *    scope, so it is exempt from the global-script rule.
 */
const MODULE_RE = /^\s*(?:import|export)\b/m;
const AUGMENT_RE = /(^|[\r\n])\s*declare\s+(?:global|module)\b/;
const TS_TEXT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function classifyRootFile(file) {
	if (file.endsWith(".vue")) return { moduleLike: true, augmentationRisk: false, emptyish: false };
	const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
	if (!TS_TEXT_EXTS.has(ext)) return { moduleLike: true, augmentationRisk: false, emptyish: false };
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { moduleLike: false, augmentationRisk: true, emptyish: false }; // unreadable -> assume the worst
	}
	const emptyish = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim().length === 0;
	return { moduleLike: MODULE_RE.test(text), augmentationRisk: AUGMENT_RE.test(text), emptyish };
}

function computeRootFlags(files) {
	const globalScripts = [];
	const augmentationRisk = [];
	for (const [file] of files) {
		const c = classifyRootFile(file);
		if (!c.moduleLike && !c.emptyish) globalScripts.push(canon(file));
		if (c.augmentationRisk) augmentationRisk.push(canon(file));
	}
	return { globalScripts, augmentationRisk };
}

/**
 * Find cache entries sharing the same baseKey (everything but file hashes is
 * identical). Reads only the first bytes of each entry file: writeEntry
 * serializes { format, key, baseKey, createdAt } first.
 */
function findCandidateEntries(cacheDir, baseKey) {
	const dir = path.join(cacheDir, "entries");
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const out = [];
	for (const n of names) {
		let head;
		try {
			const fd = fs.openSync(path.join(dir, n), "r");
			const buf = Buffer.alloc(1024);
			const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
			fs.closeSync(fd);
			head = buf.toString("utf8", 0, bytesRead);
		} catch {
			continue;
		}
		if (!head.includes(`"baseKey":"${baseKey}"`)) continue;
		const keyMatch = /"key":"([0-9a-f]{40})"/.exec(head);
		const createdMatch = /"createdAt":"([^"]+)"/.exec(head);
		if (!keyMatch) continue;
		out.push({ key: keyMatch[1], createdAt: createdMatch ? createdMatch[1] : "" });
	}
	out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	return out;
}

function buildReverseGraph(graph) {
	const rev = new Map();
	for (const [file, deps] of Object.entries(graph)) {
		for (const d of deps) {
			const c = canon(d);
			let list = rev.get(c);
			if (!list) rev.set(c, (list = []));
			list.push(canon(file));
		}
	}
	return rev;
}

/**
 * Decide whether an incremental run is possible and prepare its manifest.
 * Returns { manifestPath, manifest, cleanup } or null (fall back to full run).
 */
function prepareIncremental({ cacheDir, plan, oldEntry, tmpBase, debug }) {
	// entry-level gates: only metadata completeness (content-level risks are
	// checked per changed/deleted file below and via post-run lost-file analysis)
	const fail = (why) => { if (debug) debug("prepareIncremental: " + why); return null; };
	if (!oldEntry || oldEntry.format !== 2) return fail("no/old-format entry");
	if (!oldEntry.graph || !oldEntry.fileDiags || !oldEntry.flags || !Array.isArray(oldEntry.files)) return fail("incomplete v2 metadata");
	const flags = oldEntry.flags;
	if (flags.filelessDiags) return fail("fileless diags");

	// diff the root file sets (content hashes)
	const oldMap = new Map(oldEntry.files.map(([f, h]) => [canon(f), h]));
	const newMap = new Map(plan.files.map(([f, h]) => [canon(f), h]));
	const changed = [];
	const deleted = [];
	for (const [f, h] of newMap) {
		if (!oldMap.has(f)) return fail("added file: " + f);
		if (oldMap.get(f) !== h) changed.push(f);
	}
	for (const f of oldMap.keys()) {
		if (!newMap.has(f)) deleted.push(f);
	}
	if (!changed.length && !deleted.length) return fail("no content change");

	// stat-verify the old program manifest: non-root program files (node_modules,
	// workspace packages, generated files) must be content-identical — their
	// changes cannot be attributed to the changed-file set. Root files are
	// exempt (their changes are exactly the diff computed above). A stat
	// mismatch on a generated-but-identical file is settled via stored sha1.
	if (Array.isArray(oldEntry.programFiles)) {
		for (const [file, size, mtimeMs] of oldEntry.programFiles) {
			let st;
			try { st = fs.statSync(file); } catch {
				if (!oldMap.has(canon(file))) return fail("non-root file disappeared: " + file);
				continue; // root file gone -> part of the diff
			}
			if (st.size === size && Math.round(st.mtimeMs) === mtimeMs) continue;
			if (oldMap.has(canon(file))) continue; // root file -> part of the diff
			let content;
			try { content = fs.readFileSync(file); } catch { return fail("unreadable program file: " + file); }
			if (!oldEntry.fileHashes || oldEntry.fileHashes[canon(file)] !== sha1(content)) return fail("program file content changed: " + file);
		}
	}

	// changed/deleted files must be provably "local" changes:
	//  - old content must not have participated in global-scope merging
	//    (global script / module augmentation) — such a change (including
	//    *removing* the augmentation) is visible far beyond the import graph
	//  - new content of changed files must neither be a global script with
	//    declarations nor add a module augmentation / declare global
	for (const f of changed) {
		if (flags.globalScripts.includes(f) || flags.augmentationRisk.includes(f)) return fail("changed file has global-scope role: " + f);
		const realPath = plan.files.find(([p]) => canon(p) === f);
		const c = classifyRootFile(realPath ? realPath[0] : f);
		if ((!c.moduleLike && !c.emptyish) || c.augmentationRisk) return fail("changed file not module-like: " + f);
	}
	for (const f of deleted) {
		if (flags.globalScripts.includes(f) || flags.augmentationRisk.includes(f)) return fail("deleted file has global-scope role: " + f);
	}

	// reverse transitive dependent closure of the changed/deleted set
	const rev = buildReverseGraph(oldEntry.graph);
	const affected = new Set(changed);
	const queue = [...changed, ...deleted];
	while (queue.length) {
		const cur = queue.pop();
		for (const dep of rev.get(cur) || []) {
			if (!affected.has(dep)) {
				affected.add(dep);
				queue.push(dep);
			}
		}
	}
	// only files that still exist can be re-checked; deleted files just lose their diags
	const affectedList = [...affected].filter((f) => newMap.has(f));
	if (!affectedList.length) return fail("empty affected set");
	const maxAffected = Math.max(48, Math.ceil(newMap.size * AFFECTED_RATIO_MAX));
	if (affectedList.length > AFFECTED_ABS_MAX || affectedList.length >= newMap.size || affectedList.length > maxAffected) {
		return fail("affected set too large: " + affectedList.length);
	}

	// manifest: cached diagnostics for every unaffected program file
	const cached = {};
	for (const [f, diags] of Object.entries(oldEntry.fileDiags)) {
		if (affected.has(f)) continue;
		if (!newMap.has(f) && !oldEntry.graph[f]) continue; // file left the program entirely
		cached[f] = diags;
	}
	// optional per-file syntactic diagnostics (available when the entry was
	// produced by a session worker that dumped them) — lets the incremental run
	// replay the whole-program syntactic pass as well
	const cachedSyntactic = {};
	if (oldEntry.syntacticDiags) {
		for (const [f, diags] of Object.entries(oldEntry.syntacticDiags)) {
			if (affected.has(f)) continue;
			if (!newMap.has(f) && !oldEntry.graph[f]) continue;
			cachedSyntactic[f] = diags;
		}
	}

	const manifestPath = tmpBase + ".incr-manifest.json";
	const freshDump = tmpBase + ".incr-fresh.json";
	const freshSyntacticDump = tmpBase + ".incr-synfresh.json";
	fs.writeFileSync(manifestPath, JSON.stringify({
		affected: affectedList.sort(),
		cached,
		freshDump,
		...(oldEntry.syntacticDiags ? { cachedSyntactic, freshSyntacticDump } : {}),
	}));
	return {
		manifestPath,
		freshDump,
		freshSyntacticDump: oldEntry.syntacticDiags ? freshSyntacticDump : null,
		affectedList,
		deleted,
		cachedManifest: cached,
		cachedSyntactic: oldEntry.syntacticDiags ? cachedSyntactic : null,
	};
}

/**
 * Check that the incremental run's program did not silently gain files that
 * have no cached diagnostics (a change can pull new files into the program,
 * e.g. a newly imported module's d.ts). If it did, the run must be redone as
 * a full run to stay byte-identical.
 */
function programGainedUnknownFiles(newProgramFiles, oldEntry, plan) {
	if (!Array.isArray(newProgramFiles)) return false;
	const known = new Set();
	if (Array.isArray(oldEntry.programFiles)) {
		for (const [f] of oldEntry.programFiles) known.add(canon(f));
	}
	for (const [f] of plan.files) known.add(canon(f));
	for (const f of Object.keys(oldEntry.graph || {})) known.add(canon(f));
	for (const [f] of newProgramFiles) {
		if (!known.has(canon(f))) return true;
	}
	return false;
}

/**
 * Post-run safety net: files that were in the old program but left it. Regular
 * type information flows through import edges (covered by the reverse-closure
 * recheck), but a file carrying global-scope contributions (ambient globals,
 * `declare global` / `declare module` augmentations) can change diagnostics of
 * files with no import path to it. If any such risky file left the program,
 * the run must be redone as a full run.
 */
function programLostRiskyFiles(newProgramFiles, oldEntry, plan) {
	if (!Array.isArray(newProgramFiles) || !Array.isArray(oldEntry.programFiles)) return true;
	const rootSet = new Set(plan.files.map(([f]) => canon(f)));
	const newNames = new Set(newProgramFiles.map(([f]) => canon(f)));
	for (const [file] of oldEntry.programFiles) {
		const c = canon(file);
		if (newNames.has(c) || rootSet.has(c)) continue;
		// non-root file left the program: classify its text
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			return true; // unreadable -> assume the worst
		}
		const emptyish = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").trim().length === 0;
		if (emptyish) continue;
		if (AUGMENT_RE.test(text)) return true;
		if (!MODULE_RE.test(text)) return true; // global script with (presumably) declarations
	}
	return false;
}

function mergeFileDiags(cachedManifest, freshDumpPath, deleted, affectedSet) {
	const merged = {};
	for (const [f, diags] of Object.entries(cachedManifest)) merged[f] = diags;
	try {
		const fresh = JSON.parse(fs.readFileSync(freshDumpPath, "utf8"));
		for (const [f, diags] of Object.entries(fresh)) merged[f] = diags;
	} catch {
		return null; // fresh dump missing -> entry without fileDiags
	}
	for (const f of deleted) delete merged[f];
	return merged;
}

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function removeQuiet(file) {
	try {
		fs.unlinkSync(file);
	} catch {}
}

/**
 * Attempt the incremental path for a cache miss. Returns
 * { mode: "incremental", stdout, stderr, exitCode } or null (caller falls back
 * to the full-run path).
 */
function tryIncremental({ argv, cacheDir, plan, tmpBase, spawnChild, readEntry, debug }) {
	const candidates = findCandidateEntries(cacheDir, plan.baseKey);
	for (const candidate of candidates) {
		const oldEntry = readEntry(cacheDir, candidate.key);
		if (!oldEntry) continue;
		let prep;
		try {
			prep = prepareIncremental({ cacheDir, plan, oldEntry, tmpBase });
		} catch {
			prep = null;
		}
		if (!prep) continue;

		if (debug) debug(`incremental: candidate=${candidate.key.slice(0, 8)} affected=${prep.affectedList.length} of ${plan.filesCount}`);

		const graphDump = tmpBase + ".graph.json";
		const progDump = tmpBase + ".prog.json";
		const incrErr = tmpBase + ".incr.err";
		const result = spawnChild(argv, {
			VUE_TSC_GO_INTERNAL_CHILD: "1",
			VUE_TSC_GO_DUMP_FILES: progDump,
			VUE_TSC_GO_DUMP_GRAPH: graphDump,
			VUE_TSC_GO_INCREMENTAL: prep.manifestPath,
			VUE_TSC_GO_INCREMENTAL_ERR: incrErr,
		});

		const graphDumped = readJson(graphDump);
		const programFiles = readJson(progDump);
		let ok = !result.spawnError;
		if (ok && (!graphDumped || !programFiles)) ok = false;
		if (ok && programGainedUnknownFiles(programFiles, oldEntry, plan)) {
			if (debug) debug("incremental: program gained unknown files -> full rerun");
			ok = false;
		}
		if (ok && programLostRiskyFiles(programFiles, oldEntry, plan)) {
			if (debug) debug("incremental: program lost a risky (global/augmentation) file -> full rerun");
			ok = false;
		}
		// a hook failure falls back to the whole pass inside the child; that is
		// still correct output, but we must not store it as per-file diags of an
		// incremental run — detect it via the missing fresh dump and fall through
		// to a full run for a clean entry.
		if (ok && !fs.existsSync(prep.freshDump)) ok = false;

		if (ok) {
			const fileDiags = mergeFileDiags(prep.cachedManifest, prep.freshDump, prep.deleted, new Set(prep.affectedList));
			if (fileDiags) {
				const { writeEntry } = require("./cache.js");
				writeEntry(cacheDir, plan.key, {
					stdoutBase64: Buffer.from(result.stdout, "utf8").toString("base64"),
					stderrBase64: Buffer.from(result.stderr, "utf8").toString("base64"),
					exitCode: result.exitCode,
					programFiles,
					baseKey: plan.baseKey,
					files: plan.files,
					graph: canonEdges(graphDumped.edges),
					fileDiags,
					fileHashes: (() => {
						const rootSet = new Set(plan.files.map(([f]) => canon(f)));
						const { computeFileHashes } = require("./cache.js");
						return computeFileHashes(programFiles, rootSet);
					})(),
					flags: {
						...computeRootFlags(plan.files),
						filelessDiags: false,
						unresolvedRelative: !!graphDumped.unresolvedRelative,
					},
				});
				cleanupTmp(tmpBase, prep);
				return { mode: "incremental", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
			}
		}
		if (debug) debug(`incremental: aborted (${ok ? "no fresh dump" : "spawn/dump problem"}) -> full run`);
		// fall through: this candidate cannot serve; try older candidates that
		// might have a *different* content set closer to the current one only
		// makes sense when the current attempt did not run the checker at all —
		// it did, so just bail to full run.
		cleanupTmp(tmpBase, prep);
		return null;
	}
	return null;
}

function cleanupTmp(tmpBase, prep) {
	removeQuiet(tmpBase + ".graph.json");
	removeQuiet(tmpBase + ".prog.json");
	removeQuiet(tmpBase + ".incr.err");
	if (prep) {
		removeQuiet(prep.manifestPath);
		removeQuiet(prep.freshDump);
	}
}

function canonEdges(edges) {
	const out = {};
	for (const [f, deps] of Object.entries(edges || {})) {
		out[canon(f)] = deps.map(canon);
	}
	return out;
}

module.exports = {
	tryIncremental,
	computeRootFlags,
	prepareIncremental,
	mergeFileDiags,
	programGainedUnknownFiles,
	programLostRiskyFiles,
	canon,
	canonEdges,
	sha1,
};
