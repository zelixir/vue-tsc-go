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
const SUB_ROOT_ABS_MAX = 1500; // ambient-risky roots cap for the sub-program tier

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
const UMD_GLOBAL_RE = /(^|[\r\n])[ \t]*export\s+as\s+namespace\b/;
const TS_TEXT_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Ambient-risk classification of a program file's text (see computeFileMeta):
 * a file participates in the *global* scope beyond its imports when it is a
 * global script, carries `declare global` / `declare module` augmentations, or
 * is a UMD global. Such files are always added as roots of an incremental
 * sub-program so its global scope matches the full program's.
 */
function isAmbientRiskyText(text) {
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, "\n")
		.replace(/\/\/[^\n]*/g, "");
	if (!MODULE_RE.test(stripped)) return true; // global script
	if (AUGMENT_RE.test(stripped)) return true; // declare global / declare module
	return UMD_GLOBAL_RE.test(stripped);
}

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

	// manifest: cached diagnostics for every unaffected program file. Files that
	// no longer exist on disk must not be kept (the hook would rehydrate their
	// stale diagnostics into the output — phantom errors).
	const fileKnown = (f) => newMap.has(f) || fs.existsSync(f);
	const cached = {};
	for (const [f, diags] of Object.entries(oldEntry.fileDiags)) {
		if (affected.has(f)) continue;
		if (!newMap.has(f) && !oldEntry.graph[f]) continue; // file left the program entirely
		if (!fileKnown(f)) continue;
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
			if (!fileKnown(f)) continue;
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
		changed,
		deleted,
		oldMap,
		newMap,
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
 * Stat-verify the recorded program manifest of an entry against the old root
 * map: non-root program files must be content-identical (their changes cannot
 * be attributed to the changed-file set). Shared by the sub-program and the
 * full-program incremental tiers.
 */
function verifyProgramManifest(oldEntry, oldMap, fail) {
	if (!Array.isArray(oldEntry.programFiles)) return true;
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
	return true;
}

/**
 * Build the shared diff/gates of both incremental tiers: old/new root diff,
 * global-scope role gates for changed/deleted files, and the reverse
 * transitive dependent closure. Returns null via `fail` on any doubt.
 */
function diffAndClose(plan, oldEntry, fail) {
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

	for (const f of changed) {
		if (oldEntry.flags.globalScripts.includes(f) || oldEntry.flags.augmentationRisk.includes(f)) return fail("changed file has global-scope role: " + f);
		const realPath = plan.files.find(([p]) => canon(p) === f);
		const c = classifyRootFile(realPath ? realPath[0] : f);
		if ((!c.moduleLike && !c.emptyish) || c.augmentationRisk) return fail("changed file not module-like: " + f);
	}
	for (const f of deleted) {
		if (oldEntry.flags.globalScripts.includes(f) || oldEntry.flags.augmentationRisk.includes(f)) return fail("deleted file has global-scope role: " + f);
	}

	if (!verifyProgramManifest(oldEntry, oldMap, fail)) return null;

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
	const affectedList = [...affected].filter((f) => newMap.has(f));
	if (!affectedList.length) return fail("empty affected set");
	const maxAffected = Math.max(48, Math.ceil(newMap.size * AFFECTED_RATIO_MAX));
	if (affectedList.length > AFFECTED_ABS_MAX || affectedList.length >= newMap.size || affectedList.length > maxAffected) {
		return fail("affected set too large: " + affectedList.length);
	}
	return { oldMap, newMap, changed, deleted, affected, affectedList };
}

/** Cached-diagnostic maps (semantic + optional syntactic) for unaffected files.
 *  Files that no longer exist on disk (deleted roots, gone non-root files) must
 *  never be kept: the checker hook would rehydrate their stale diagnostics into
 *  the run output (phantom errors). */
function buildCachedMaps(oldEntry, affected, newMap) {
	const pick = (byFile) => {
		const out = {};
		for (const [f, diags] of Object.entries(byFile || {})) {
			if (affected.has(f)) continue;
			if (!newMap.has(f) && !oldEntry.graph[f]) continue; // file left the program entirely
			if (!newMap.has(f) && !fs.existsSync(f)) continue; // deleted/gone file: never replay
			out[f] = diags;
		}
		return out;
	};
	const cached = pick(oldEntry.fileDiags);
	const cachedSyntactic = oldEntry.syntacticDiags ? pick(oldEntry.syntacticDiags) : null;
	return { cached, cachedSyntactic };
}

/**
 * Tier 1 — sub-program incremental run ("affected closure program"):
 * instead of building the full program again, build a much smaller program
 * whose roots are the affected files plus every ambient-risky program file
 * (global scripts / `declare global`-`declare module` / UMD globals, from the
 * previous entry's metadata). Plain modules contributing to the affected
 * files' types arrive via their imports (forward closure), which the program
 * builder pulls in automatically with identical compilerOptions — so the
 * diagnostics of the affected files are computed in exactly the same type
 * environment, at a fraction of the memory/time. All other files' diagnostics
 * are rehydrated from the previous entry. Anything unprovable falls back to
 * the full-program incremental tier below.
 */
function prepareSubProgram({ plan, oldEntry, tmpBase, debug }) {
	const fail = (why) => { if (debug) debug("sub-program: " + why); return null; };
	if (!oldEntry || oldEntry.format !== 2) return fail("no/old-format entry");
	if (!oldEntry.graph || !oldEntry.fileDiags || !oldEntry.flags || !Array.isArray(oldEntry.files)) return fail("incomplete v2 metadata");
	if (!oldEntry.syntacticDiags) return fail("no cached syntactic diagnostics");
	if (!Array.isArray(oldEntry.programRisky)) return fail("no ambient-risk metadata");
	if (oldEntry.flags.filelessDiags) return fail("fileless diags");
	if (!Array.isArray(oldEntry.programFiles) || !oldEntry.programFiles.length) return fail("no program manifest");

	const diff = diffAndClose(plan, oldEntry, fail);
	if (!diff) return null;
	const { oldMap, newMap, deleted, affected, affectedList } = diff;

	// original (non-canon) paths for all known program files
	const origOf = new Map();
	for (const [f] of oldEntry.programFiles) origOf.set(canon(f), f);
	for (const [f] of oldEntry.files) origOf.set(canon(f), f);

	// sub-program roots: affected files + every ambient-risky file (they shape
	// the global scope; without them the sub-program's checker would disagree
	// with the full program on ambient globals)
	const roots = [];
	const seenRoot = new Set();
	const pushRoot = (c) => {
		if (seenRoot.has(c)) return;
		seenRoot.add(c);
		const orig = origOf.get(c);
		if (!orig) return fail("risky file without original path: " + c);
		if (!fs.existsSync(orig)) return fail("risky file missing on disk: " + orig);
		roots.push(orig);
	};
	for (const c of oldEntry.programRisky) {
		const r = pushRoot(c);
		if (r === null) return null;
	}
	for (const c of [...oldEntry.flags.globalScripts, ...oldEntry.flags.augmentationRisk]) {
		const r = pushRoot(c);
		if (r === null) return null;
	}
	if (roots.length > SUB_ROOT_ABS_MAX) return fail("too many ambient-risky roots: " + roots.length);
	for (const f of affectedList) {
		const orig = origOf.get(f);
		if (!orig || !fs.existsSync(orig)) return fail("affected file missing on disk: " + f);
		roots.push(orig);
	}

	const { cached, cachedSyntactic } = buildCachedMaps(oldEntry, affected, newMap);

	// The tsgo engine builds its program from the tsconfig file, not from
	// rootNames — so the sub-program needs its own config: a generated sibling
	// of the real tsconfig ("extends" it, explicit absolute "files") so module
	// resolution, typeRoots and vueCompilerOptions resolve identically.
	const subDir = path.dirname(plan.tsconfigPath);
	// sweep sub-program configs of dead processes (interrupted earlier runs);
	// live pids (parallel worktree runs) are never touched
	try {
		for (const n of fs.readdirSync(subDir)) {
			const m = /^\.vue-tsc-go-sub-(\d+)-\d+\.json$/.exec(n);
			if (!m) continue;
			const pid = Number(m[1]);
			let alive = true;
			try { process.kill(pid, 0); } catch { alive = false; }
			if (!alive) removeQuiet(path.join(subDir, n));
		}
	} catch {}
	const subConfigPath = path.join(subDir, `.vue-tsc-go-sub-${process.pid}-${Date.now()}.json`);
	try {
		fs.writeFileSync(subConfigPath, JSON.stringify({
			extends: plan.tsconfigPath,
			compilerOptions: { noEmit: true },
			// include/exclude MUST be emptied explicitly: an inherited `include`
			// stays active alongside `files` in this TS version and would pull
			// the whole project back in
			include: [],
			exclude: [],
			files: roots,
		}));
	} catch (e) {
		return fail("cannot write sub-program tsconfig: " + String((e && e.message) || e));
	}

	const manifestPath = tmpBase + ".sub-manifest.json";
	const freshDump = tmpBase + ".sub-fresh.json";
	const freshSyntacticDump = tmpBase + ".sub-synfresh.json";
	fs.writeFileSync(manifestPath, JSON.stringify({
		roots,
		configPath: subConfigPath,
		affected: affectedList.slice().sort(),
		cached,
		freshDump,
		cachedSyntactic,
		freshSyntacticDump,
	}));
	return {
		tier: "sub",
		manifestPath,
		roots,
		configPath: subConfigPath,
		freshDump,
		freshSyntacticDump,
		affectedList,
		changed: diff.changed,
		deleted,
		oldMap: diff.oldMap,
		newMap: diff.newMap,
		cachedManifest: cached,
		cachedSyntactic,
	};
}

/**
 * Root flags for the NEW root set, derived from the previous entry's flags:
 * unchanged files keep their classification (content identical -> identical
 * classification), changed files are reclassified, deleted files are dropped.
 * Avoids re-reading every root file on every incremental merge.
 */
function carryRootFlags(oldEntry, changed, deleted, plan) {
	const oldFlags = oldEntry.flags;
	if (!oldFlags || !Array.isArray(oldFlags.globalScripts) || !Array.isArray(oldFlags.augmentationRisk)) {
		return computeRootFlags(plan.files);
	}
	const gone = new Set([...changed, ...deleted]);
	const flags = {
		globalScripts: oldFlags.globalScripts.filter((f) => !gone.has(f)),
		augmentationRisk: oldFlags.augmentationRisk.filter((f) => !gone.has(f)),
	};
	for (const c of changed) {
		const realPath = plan.files.find(([p]) => canon(p) === c);
		const cl = classifyRootFile(realPath ? realPath[0] : c);
		if (!cl.moduleLike && !cl.emptyish && !flags.globalScripts.includes(c)) flags.globalScripts.push(c);
		if (cl.augmentationRisk && !flags.augmentationRisk.includes(c)) flags.augmentationRisk.push(c);
	}
	return flags;
}

/** Post-run guards + entry merge for the sub-program tier. Returns null to abort. */
function finishSubProgram({ plan, oldEntry, prep, result, graphDumped, programFiles, debug }) {
	const fail = (why) => { if (debug) debug("sub-program: aborted: " + why); return null; };
	if (!graphDumped || !programFiles) return fail("missing dumps");
	if (!fs.existsSync(prep.freshDump)) return fail("no fresh dump");

	if (programGainedUnknownFiles(programFiles, oldEntry, plan)) return fail("program gained unknown files");

	// every affected file and every declared sub root (affected + ambient-risky)
	// must be inside the sub-program (otherwise the type environment was not
	// what we assumed)
	const subNames = new Set(programFiles.map(([f]) => canon(f)));
	for (const f of prep.affectedList) {
		if (!subNames.has(f)) return fail("affected file not in sub program: " + f);
	}
	for (const r of prep.roots) {
		if (!subNames.has(canon(r))) return fail("declared sub root missing from program: " + r);
	}

	// resolution stability: unchanged affected files must resolve exactly as in
	// the full program (changed files may legitimately import differently now)
	for (const f of prep.affectedList) {
		if (oldEntry.graph[f] === undefined) continue;
		if (prep.oldMap.get(f) === prep.newMap.get(f)) {
			const before = (oldEntry.graph[f] || []).slice().sort();
			const after = (graphDumped.edges[f] || []).map(canon).slice().sort();
			if (before.length !== after.length || before.some((x, i) => x !== after[i])) {
				return fail("resolution changed for unchanged affected file: " + f);
			}
		}
	}

	const affected = new Set(prep.affectedList);
	const fileDiags = mergeFileDiags(prep.cachedManifest, prep.freshDump, prep.deleted, affected);
	if (!fileDiags) return fail("fresh dump unreadable");
	const syntacticDiags = prep.cachedSyntactic
		? mergeFileDiags(prep.cachedSyntactic, prep.freshSyntacticDump, prep.deleted, affected)
		: null;
	if (prep.cachedSyntactic && !syntacticDiags) return fail("fresh syntactic dump unreadable");

	// merged program manifest: full-program coverage (never weaker hit
	// verification than the previous entry) with fresh stats from the sub run
	const deletedSet = new Set(prep.deleted);
	const subStat = new Map(programFiles.map(([f, s, m]) => [canon(f), [f, s, m]]));
	const mergedProgramFiles = [];
	for (const rec of oldEntry.programFiles) {
		const c = canon(rec[0]);
		if (deletedSet.has(c)) continue;
		mergedProgramFiles.push(subStat.get(c) || rec);
	}

	// merged graph: old edges stay valid for unchanged files (their import
	// closure is disjoint from the changed set); affected files get the fresh
	// sub-run edges; deleted files are dropped
	const graph = {};
	for (const [f, deps] of Object.entries(oldEntry.graph)) {
		if (deletedSet.has(f) || affected.has(f)) continue;
		graph[f] = deps;
	}
	for (const f of prep.affectedList) {
		graph[f] = (graphDumped.edges[f] || []).map(canon);
	}

	const { computeFileHashes, canonName } = require("./cache.js");
	const rootSet = new Set(plan.files.map(([f]) => canon(f)));
	// only re-hash sub-program files whose stat actually changed vs the previous
	// manifest; unchanged files keep their previous content hash
	const prevStat = new Map((oldEntry.programFiles || []).map((r) => [canonName(r[0]), r]));
	const freshHashes = computeFileHashes(
		programFiles.filter(([f, size, mtimeMs]) => {
			const prev = prevStat.get(canonName(f));
			return !prev || prev[1] !== size || prev[2] !== mtimeMs || oldEntry.fileHashes == null || oldEntry.fileHashes[canonName(f)] === undefined;
		}),
		rootSet,
	);
	const entry = {
		stdoutBase64: Buffer.from(result.stdout, "utf8").toString("base64"),
		stderrBase64: Buffer.from(result.stderr, "utf8").toString("base64"),
		exitCode: result.exitCode,
		programFiles: mergedProgramFiles,
		baseKey: plan.baseKey,
		files: plan.files,
		fileStats: plan.fileStats || null,
		graph: graph,
		fileDiags,
		syntacticDiags,
		fileHashes: { ...(oldEntry.fileHashes || {}), ...freshHashes },
		flags: {
			...carryRootFlags(oldEntry, prep.changed, prep.deleted, plan),
			filelessDiags: false,
			unresolvedRelative: !!graphDumped.unresolvedRelative,
		},
		programRisky: oldEntry.programRisky,
	};
	return entry;
}

/**
 * Attempt the incremental path for a cache miss. Two tiers, most efficient
 * first; any doubt at any tier falls through to the next, ultimately to a
 * full run:
 *  1. sub-program: build only the affected closure + ambient globals;
 *  2. full-program: full program, per-file re-check of the affected closure.
 * Returns { mode, stdout, stderr, exitCode } or null (caller falls back to a
 * full run).
 */
function tryIncremental({ argv, cacheDir, plan, tmpBase, spawnChild, readEntry, debug }) {
	const candidates = findCandidateEntries(cacheDir, plan.baseKey);
	for (const candidate of candidates) {
		const oldEntry = readEntry(cacheDir, candidate.key);
		if (!oldEntry) continue;

		// ── tier 1: sub-program ──
		let sub = null;
		try { sub = prepareSubProgram({ plan, oldEntry, tmpBase, debug }); } catch (e) { if (debug) debug("sub-program prep threw: " + String((e && e.stack) || e)); sub = null; }
		if (sub) {
			if (debug) debug(`sub-program: candidate=${candidate.key.slice(0, 8)} affected=${sub.affectedList.length} roots=${sub.roots.length} of ${plan.filesCount}`);
			const r = runIncrementalTier({ tier: "sub", argv, cacheDir, plan, oldEntry, prep: sub, tmpBase, spawnChild, debug });
			if (r) return r;
		}

		// ── tier 2: full-program incremental ──
		let prep = null;
		try { prep = prepareIncremental({ cacheDir, plan, oldEntry, tmpBase, debug }); } catch (e) { if (debug) debug("prepareIncremental threw: " + String((e && e.stack) || e)); prep = null; }
		if (!prep) continue;
		if (debug) debug(`incremental: candidate=${candidate.key.slice(0, 8)} affected=${prep.affectedList.length} of ${plan.filesCount}`);
		const r = runIncrementalTier({ tier: "full", argv, cacheDir, plan, oldEntry, prep, tmpBase, spawnChild, debug });
		if (r) return r;
		// this candidate cannot serve; trying older candidates with a *different*
		// content set only makes sense when no checker ran at all — one did, so
		// bail to a full run.
		return null;
	}
	return null;
}

/**
 * Run one incremental tier through the checker and, on success, write the
 * merged v2 cache entry. Returns the run result or null (caller falls back).
 */
function runIncrementalTier({ tier, argv, cacheDir, plan, oldEntry, prep, tmpBase, spawnChild, debug }) {
	const { writeEntry } = require("./cache.js");
	const isSub = tier === "sub";
	const graphDump = tmpBase + (isSub ? ".sub.graph.json" : ".graph.json");
	const progDump = tmpBase + (isSub ? ".sub.prog.json" : ".prog.json");
	const incrErr = tmpBase + (isSub ? ".sub.err" : ".incr.err");
	const t0 = Date.now();
	const result = spawnChild(argv, {
		VUE_TSC_GO_DUMP_FILES: progDump,
		VUE_TSC_GO_DUMP_GRAPH: graphDump,
		...(isSub
			? { VUE_TSC_GO_SUBPROGRAM: prep.manifestPath, VUE_TSC_GO_MIX_SYNTACTIC: "1" }
			: {
				VUE_TSC_GO_INCREMENTAL: prep.manifestPath,
				...(oldEntry.syntacticDiags ? { VUE_TSC_GO_MIX_SYNTACTIC: "1" } : {}),
			}),
		VUE_TSC_GO_INCREMENTAL_ERR: incrErr,
	});

	const tDone = Date.now();
	const graphDumped = readJson(graphDump);
	const programFiles = readJson(progDump);
	let ok = !result.spawnError;
	if (ok && (!graphDumped || !programFiles)) ok = false;
	if (ok && fs.existsSync(incrErr)) ok = false; // hook fallback marker
	if (ok && !fs.existsSync(prep.freshDump)) ok = false;

	if (ok) {
		let entry = null;
		try {
			entry = isSub
				? finishSubProgram({ plan, oldEntry, prep, result, graphDumped, programFiles, debug })
				: finishFullProgramTier({ plan, oldEntry, prep, result, graphDumped, programFiles });
		} catch (e) {
			if (debug) debug(`${tier} entry merge threw: ` + String((e && e.stack) || e));
		}
		if (entry) {
			if (debug) debug(`${tier}: run=${tDone - t0}ms merge+write=${Date.now() - tDone}ms program=${(programFiles || []).length} files`);
			writeEntry(cacheDir, plan.key, entry);
			cleanupTmp(tmpBase, prep, isSub);
			return { mode: isSub ? "incremental-sub" : "incremental", stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
		}
		if (debug) debug(`${tier}: guards failed -> ${isSub ? "full-program tier" : "full run"}`);
	} else if (debug) {
		debug(`${tier}: spawn/dump problem -> ${isSub ? "full-program tier" : "full run"}`);
	}
	cleanupTmp(tmpBase, prep, isSub);
	return null;
}

/**
 * Entry merge for the full-program incremental tier (previous default path).
 */
function finishFullProgramTier({ plan, oldEntry, prep, result, graphDumped, programFiles }) {
	const { computeFileHashes, canonName } = require("./cache.js");
	if (programGainedUnknownFiles(programFiles, oldEntry, plan)) return null;
	if (programLostRiskyFiles(programFiles, oldEntry, plan)) return null;
	const fileDiags = mergeFileDiags(prep.cachedManifest, prep.freshDump, prep.deleted, new Set(prep.affectedList));
	if (!fileDiags) return null;
	const syntacticDiags = prep.cachedSyntactic
		? mergeFileDiags(prep.cachedSyntactic, prep.freshSyntacticDump, prep.deleted, new Set(prep.affectedList))
		: null;
	if (prep.cachedSyntactic && !syntacticDiags) return null;
	const rootSet = new Set(plan.files.map(([f]) => canon(f)));
	const prevStat = new Map((oldEntry.programFiles || []).map((r) => [canonName(r[0]), r]));
	return {
		stdoutBase64: Buffer.from(result.stdout, "utf8").toString("base64"),
		stderrBase64: Buffer.from(result.stderr, "utf8").toString("base64"),
		exitCode: result.exitCode,
		programFiles,
		baseKey: plan.baseKey,
		files: plan.files,
		fileStats: plan.fileStats || null,
		graph: canonEdges(graphDumped.edges),
		fileDiags,
		syntacticDiags,
		fileHashes: {
			...(oldEntry.fileHashes || {}),
			...computeFileHashes(
				(programFiles || []).filter(([f, size, mtimeMs]) => {
					const prev = prevStat.get(canonName(f));
					return !prev || prev[1] !== size || prev[2] !== mtimeMs || oldEntry.fileHashes == null || oldEntry.fileHashes[canonName(f)] === undefined;
				}),
				rootSet,
			),
		},
		flags: {
			...carryRootFlags(oldEntry, prep.changed, prep.deleted, plan),
			filelessDiags: false,
			unresolvedRelative: !!graphDumped.unresolvedRelative,
		},
		programRisky: oldEntry.programRisky || null,
	};
}

function cleanupTmp(tmpBase, prep, isSub) {
	removeQuiet(tmpBase + (isSub ? ".sub.graph.json" : ".graph.json"));
	removeQuiet(tmpBase + (isSub ? ".sub.prog.json" : ".prog.json"));
	removeQuiet(tmpBase + (isSub ? ".sub.err" : ".incr.err"));
	if (prep) {
		removeQuiet(prep.manifestPath);
		removeQuiet(prep.freshDump);
		if (prep.freshSyntacticDump) removeQuiet(prep.freshSyntacticDump);
		// the generated sub-program tsconfig lives in the PROJECT directory —
		// always clean it up (its content is fully described by the debug log)
		if (prep.configPath) removeQuiet(prep.configPath);
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
	prepareSubProgram,
	isAmbientRiskyText,
	mergeFileDiags,
	programGainedUnknownFiles,
	programLostRiskyFiles,
	canon,
	canonEdges,
	sha1,
};
