"use strict";

/**
 * Patches the typescript-native-bridge bundles (lib/typescript.js and
 * lib/_tsc.js) with a JS-side comment-directive alignment layer
 * (TNB-PATCH markers). Run: node scripts/patch-tnb-directives.js
 *
 * Background / root cause (verified with probes against the tsgo engine):
 * 1. The tsgo (Go) checker reports TS2769 "No overload matches this call" at
 *    a failing-argument position *inside* a multi-line call, while original
 *    (stock) tooling either does not produce the error at all or reports it
 *    closer to the call head. Go's own @ts-ignore handling is line-based on
 *    its (shifted) start position, so a `// @ts-ignore` on the line directly
 *    above the call fails to suppress it (element-plus trigger.vue).
 * 2. Go may also judge a @ts-expect-error directive "unused" (TS2578) in the
 *    same situations where stock tooling would have used it.
 *
 * Fix: after converting Go diagnostics, re-apply stock-style directive
 * semantics on the JS side, on the exact overlay text the engine checked:
 * walking back from a diagnostic's start line, blank lines, comment lines and
 * call-argument continuation lines (ending with ",", "(", "[") are skipped,
 * so an error inside a call expression guarded by @ts-ignore/@ts-expect-error
 * is suppressed; a Go TS2578 whose directive actually suppressed something
 * here is dropped. This is a semantic alignment (error code + directive
 * context based, no file whitelists), not a hardcoded diagnostic filter.
 *
 * Known limitation (documented in README): for a multi-line call guarded by
 * @ts-ignore where original vue-tsc still reports an error at a failing
 * argument (i.e. the ignore does not cover the failing part in original
 * tooling), this shim suppresses the error while original vue-tsc would
 * print it.
 */

const fs = require("node:fs");
const path = require("node:path");

const libDir = path.join(__dirname, "..", "node_modules", "typescript-native-bridge", "lib");

const HELPERS = `
  // ── TNB-PATCH: JS-side comment-directive alignment (added by patch script) ──
  function tnbLineOf(lineStarts, pos) {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const tnbDirectiveScanCache = new Map();
  function tnbGetDirectiveScan(hostFileName) {
    if (tnbDirectiveScanCache.has(hostFileName)) return tnbDirectiveScanCache.get(hostFileName);
    let result;
    try {
      let text;
      try {
        const sf = host == null ? void 0 : host.getSourceFile == null ? void 0 : host.getSourceFile(hostFileName, options.target ?? 99);
        if (sf && typeof sf.text === "string") text = sf.text;
      } catch {}
      if (typeof text !== "string") {
        text = host == null ? void 0 : host.readFile == null ? void 0 : host.readFile(hostFileName);
      }
      if (typeof text === "string") {
        const lineStarts = [0];
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
        const directives = new Map();
        const re = /^\\s*(?:\\/\\/\\/?|\\/\\*+|\\*+)?\\s*@(ts-expect-error|ts-ignore)\\b/;
        for (let ln = 0; ln < lineStarts.length; ln++) {
          const eol = ln + 1 < lineStarts.length ? lineStarts[ln + 1] - 1 : text.length;
          const m = re.exec(text.slice(lineStarts[ln], eol));
          if (m) directives.set(ln, m[1]);
        }
        result = { text, lineStarts, directives };
      }
    } catch {}
    tnbDirectiveScanCache.set(hostFileName, result);
    return result;
  }
  function tnbLineText(scan, line) {
    const eol = line + 1 < scan.lineStarts.length ? scan.lineStarts[line + 1] - 1 : scan.text.length;
    return scan.text.slice(scan.lineStarts[line], eol).trim();
  }
  function tnbWalkToDirective(scan, start) {
    let line = tnbLineOf(scan.lineStarts, start) - 1;
    while (line >= 0) {
      const kind = scan.directives.get(line);
      if (kind) return { line, kind };
      const t = tnbLineText(scan, line);
      if (t === "" || /^\\/\\//.test(t) || /[,(\\[]$/.test(t)) { line--; continue; }
      return void 0;
    }
    return void 0;
  }
  function tnbAlignCommentDirectives(diags) {
    if (!(diags == null ? void 0 : diags.length)) return diags;
    const byFile = new Map();
    for (const d of diags) {
      const fn = d.file && d.file.fileName;
      if (fn && typeof d.start === "number") {
        let list = byFile.get(fn);
        if (!list) byFile.set(fn, list = []);
        list.push(d);
      }
    }
    if (!byFile.size) return diags;
    const dropped = new Set();
    const usedExpect = new Set();
    for (const [fn, list] of byFile) {
      const scan = tnbGetDirectiveScan(fn);
      if (!scan) continue;
      for (const d of list) {
        if (d.code === 2578) continue;
        const hit = tnbWalkToDirective(scan, d.start);
        if (hit) {
          dropped.add(d);
          if (hit.kind === "ts-expect-error") usedExpect.add(fn + "\\u0000" + hit.line);
        }
      }
    }
    if (!dropped.size && !usedExpect.size) return diags;
    return diags.filter((d) => {
      if (dropped.has(d)) return false;
      if (d.code === 2578 && d.file && typeof d.start === "number") {
        const scan = tnbGetDirectiveScan(d.file.fileName);
        if (scan) {
          const line = tnbLineOf(scan.lineStarts, d.start) - 1;
          for (let l = line; l >= line - 2 && l >= 0; l--) {
            if (scan.directives.get(l) === "ts-expect-error" && usedExpect.has(d.file.fileName + "\\u0000" + l)) return false;
          }
        }
      }
      return true;
    });
  }
  const mapTsgoDiagsAligned = (raw) => tnbAlignCommentDirectives(mapTsgoDiagnostics(raw, getDiagnosticSourceFile));
  // ── end TNB-PATCH ──
`;

const ANCHOR = '  const tsgoFileArg = (fileName) => fileName ? toTsgoFileName(fileName) : fileName;\n';

const REPLACEMENTS = [
	['result = mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10, tsgoFileArg(fileName)), getDiagnosticSourceFile);',
	 'result = mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10, tsgoFileArg(fileName)));'],
	['result = mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getSemanticDiagnostics) == null ? void 0 : _b2.call(_a10, tsgoFileArg(fileName)), getDiagnosticSourceFile);',
	 'result = mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSemanticDiagnostics) == null ? void 0 : _b2.call(_a10, tsgoFileArg(fileName)));'],
	['const syntactic = mapTsgoDiagnostics(entry.syntactic, getDiagnosticSourceFile);',
	 'const syntactic = mapTsgoDiagsAligned(entry.syntactic);'],
	['const semantic = mapTsgoDiagnostics(entry.semantic, getDiagnosticSourceFile);',
	 'const semantic = mapTsgoDiagsAligned(entry.semantic);'],
	['return mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getSemanticDiagnostics) == null ? void 0 : _b2.call(_a10), getDiagnosticSourceFile);',
	 'return mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSemanticDiagnostics) == null ? void 0 : _b2.call(_a10));'],
	['return mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10), getDiagnosticSourceFile);',
	 'return mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10));'],
	['...mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10), getDiagnosticSourceFile),',
	 '...mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSyntacticDiagnostics) == null ? void 0 : _b2.call(_a10)),'],
	['...mapTsgoDiagnostics((_d = (_c2 = proj.program).getSemanticDiagnostics) == null ? void 0 : _d.call(_c2), getDiagnosticSourceFile)',
	 '...mapTsgoDiagsAligned((_d = (_c2 = proj.program).getSemanticDiagnostics) == null ? void 0 : _d.call(_c2))'],
	['programDiagnosticsCache = { proj, result: mapTsgoDiagnostics((_b2 = (_a10 = proj.program).getProgramDiagnostics) == null ? void 0 : _b2.call(_a10), getDiagnosticSourceFile) };',
	 'programDiagnosticsCache = { proj, result: mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getProgramDiagnostics) == null ? void 0 : _b2.call(_a10)) };'],
];

for (const base of ["typescript.js", "_tsc.js"]) {
	const file = path.join(libDir, base);
	let src = fs.readFileSync(file, "utf8");
	if (src.includes("TNB-PATCH")) {
		console.log(`${base}: already patched, skipping`);
	} else {
		if (!src.includes(ANCHOR)) {
			console.error(`${base}: anchor not found!`);
			process.exit(1);
		}
		let count = 0;
		for (const [from, to] of REPLACEMENTS) {
			if (!src.includes(from)) {
				console.error(`${base}: call site not found: ${from.slice(0, 80)}...`);
				process.exit(1);
			}
			src = src.replace(from, to);
			count++;
		}
		src = src.replace(ANCHOR, ANCHOR + HELPERS);
		fs.writeFileSync(file, src);
		console.log(`${base}: patched (${count} call sites wrapped)`);
	}
}

// ── Second pass: TNB-DUMPPATCH ──────────────────────────────────────────────
// When vue-tsc-go's cache parent sets VUE_TSC_GO_DUMP_FILES=<path>, the check
// run writes the full program file list ([path, size, mtimeMs] tuples) to that
// file after diagnostics are computed. The cache parent stores this manifest
// in the cache entry and stat-verifies every file on a cache hit, so files
// pulled into the program transitively (monorepo workspace packages,
// node_modules d.ts) also invalidate the cache even though they are not part
// of the tsconfig root file set.
const DUMP_MARKER = "TNB-DUMPPATCH";
// line-ending agnostic anchor (_tsc.js uses CRLF)
const DUMP_ANCHOR_RE = /[ \t]*_projectCache\.set\(configFilePath, project\);\r?\n[ \t]*_overlaySyncByConfig\.set\(configFilePath, pushHostOverlayToTsgo\);/;
const DUMP_CODE = `

  // ── TNB-DUMPPATCH: program file-list dump for the vue-tsc-go cache ──
  if (process.env.VUE_TSC_GO_DUMP_FILES) {
    try {
      const tnbFs = require("node:fs");
      const tnbProgram = project && project.program;
      const tnbNames = (tnbProgram && typeof tnbProgram.getSourceFileNames === "function") ? tnbProgram.getSourceFileNames() : [];
      const tnbSeen = /* @__PURE__ */ new Set();
      const tnbFiles = [];
      for (const f of tnbNames) {
        if (typeof f !== "string" || !f || tnbSeen.has(f)) continue;
        tnbSeen.add(f);
        let size = 0, mtimeMs = 0;
        try { const st = tnbFs.statSync(f); size = st.size; mtimeMs = Math.round(st.mtimeMs); } catch {}
        tnbFiles.push([f, size, mtimeMs]);
      }
      if (tnbFiles.length) tnbFs.writeFileSync(process.env.VUE_TSC_GO_DUMP_FILES, JSON.stringify(tnbFiles));
      else tnbFs.writeFileSync(process.env.VUE_TSC_GO_DUMP_FILES, "[]");
    } catch (tnbE) { try { require("node:fs").writeFileSync(process.env.VUE_TSC_GO_DUMP_FILES + ".err", String(tnbE && tnbE.stack || tnbE)); } catch {} }
  }
  // ── end TNB-DUMPPATCH ──`;

for (const base of ["typescript.js", "_tsc.js"]) {
	const file = path.join(libDir, base);
	let src = fs.readFileSync(file, "utf8");
	// strip a previously applied dump patch so it can be replaced idempotently
	src = src.replace(/\/\/ ── TNB-DUMPPATCH[\s\S]*?── end TNB-DUMPPATCH ──\r?\n?/, "");
	if (!DUMP_ANCHOR_RE.test(src)) {
		console.error(`${base}: dump anchor not found (directive patch must run first)!`);
		process.exit(1);
	}
	src = src.replace(DUMP_ANCHOR_RE, m => m + DUMP_CODE);
	fs.writeFileSync(file, src);
	console.log(`${base}: dump patch applied`);
}

// ── Third pass: TNB-INCRPATCH ───────────────────────────────────────────────
// Incremental diagnostic mixing for the vue-tsc-go cache (bin/cache-incremental.js).
// The tsc driver collects semantic diagnostics with a single no-arg
// `program.getSemanticDiagnostics()` call; this pass routes that call through
// `tnbSemanticDiagnosticsHook`. Without VUE_TSC_GO_INCREMENTAL the hook is a
// pass-through (plus an optional per-file diagnostics dump for cache writing,
// VUE_TSC_GO_DUMP_DIAGS). With it, the hook checks only the files listed as
// "affected" in the incremental manifest (per-file Go checker calls) and
// rehydrates the previous run's diagnostics for every other file from the
// manifest — those files' transitive import closure is unchanged, so their
// diagnostics are provably identical (verified by test/cache.test.js mutation
// rounds). Any failure falls back to the whole-program pass, so the hook can
// only ever slow things down, never corrupt output.
const INCR_MARKER = "TNB-INCRPATCH";
const INCR_ANCHOR = "  const mapTsgoDiagsAligned = (raw) => tnbAlignCommentDirectives(mapTsgoDiagnostics(raw, getDiagnosticSourceFile));";
const INCR_HELPERS = `

  // ── ${INCR_MARKER}: incremental semantic-diagnostic hook ──
  const tnbCanonName = (name) => {
    const s = String(name).replace(/\\\\/g, "/");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const tnbSerializeMessage = (m) => typeof m === "string"
    ? m
    : { category: m.category, code: m.code, messageText: tnbSerializeMessage(m.messageText), next: m.next ? m.next.map(tnbSerializeMessage) : 0 };
  const tnbRehydrateMessage = (m) => typeof m === "string"
    ? m
    : { category: m.category, code: m.code, messageText: tnbRehydrateMessage(m.messageText), next: m.next ? m.next.map(tnbRehydrateMessage) : void 0 };
  const tnbSerializeDiag = (d) => [
    d.file && d.file.fileName, d.start, d.length, d.code, d.category,
    tnbSerializeMessage(d.messageText),
    d.reportsUnnecessary ? 1 : 0, d.reportsDeprecated ? 1 : 0,
    d.relatedInformation ? d.relatedInformation.map(tnbSerializeDiag) : 0,
  ];
  const tnbRehydrateDiag = (s) => ({
    file: s[0] ? getDiagnosticSourceFile(s[0]) : void 0,
    start: s[1],
    length: s[2],
    code: s[3],
    category: s[4],
    messageText: tnbRehydrateMessage(s[5]),
    reportsUnnecessary: s[6] || void 0,
    reportsDeprecated: s[7] || void 0,
    relatedInformation: s[8] ? s[8].map(tnbRehydrateDiag) : void 0,
  });
  const tnbDumpDiagsByFile = (diags) => {
    const tnbDumpPath = process.env.VUE_TSC_GO_DUMP_DIAGS;
    if (!tnbDumpPath || !diags) return diags;
    try {
      const tnbFs = require("node:fs");
      const tnbByFile = {};
      let tnbFileless = false;
      for (const tnbD of diags) {
        const tnbFn = tnbD.file && tnbD.file.fileName;
        if (!tnbFn) { tnbFileless = true; continue; }
        const tnbCn = tnbCanonName(tnbFn);
        (tnbByFile[tnbCn] || (tnbByFile[tnbCn] = [])).push(tnbSerializeDiag(tnbD));
      }
      tnbFs.writeFileSync(tnbDumpPath, JSON.stringify({ byFile: tnbByFile, fileless: tnbFileless }));
    } catch (tnbDumpE) {
      try { require("node:fs").writeFileSync(tnbDumpPath + ".err", String(tnbDumpE && tnbDumpE.stack || tnbDumpE)); } catch {}
    }
    return diags;
  };
  const tnbSemanticDiagnosticsHook = (proj) => {
    const tnbWhole = () => tnbDumpDiagsByFile(mapTsgoDiagsAligned(proj.program.getSemanticDiagnostics()));
    const tnbIncFile = process.env.VUE_TSC_GO_INCREMENTAL;
    if (!tnbIncFile) return tnbWhole();
    try {
      const tnbFs = require("node:fs");
      const tnbMan = JSON.parse(tnbFs.readFileSync(tnbIncFile, "utf8"));
      const tnbAffected = new Set(tnbMan.affected);
      const tnbFresh = {};
      const tnbResult = [];
      for (const tnbName of getSourceFileNames()) {
        const tnbCn = tnbCanonName(tnbName);
        if (tnbAffected.has(tnbCn)) {
          const tnbDiags = getSemanticDiagnosticsForFile(proj, tnbName);
          tnbResult.push(...tnbDiags);
          tnbFresh[tnbCn] = tnbDiags.map(tnbSerializeDiag);
        } else {
          const tnbCached = tnbMan.cached[tnbCn];
          if (tnbCached) {
            for (const tnbS of tnbCached) {
              const tnbD = tnbRehydrateDiag(tnbS);
              if (tnbS[0] && !tnbD.file) throw new Error("rehydrated diagnostic lost its file: " + tnbS[0]);
              tnbResult.push(tnbD);
            }
          }
        }
      }
      if (tnbMan.freshDump) tnbFs.writeFileSync(tnbMan.freshDump, JSON.stringify(tnbFresh));
      return tnbResult;
    } catch (tnbIncE) {
      try { if (process.env.VUE_TSC_GO_INCREMENTAL_ERR) require("node:fs").writeFileSync(process.env.VUE_TSC_GO_INCREMENTAL_ERR, String(tnbIncE && tnbIncE.stack || tnbIncE)); } catch {}
      return tnbWhole();
    }
  };
  // ── end ${INCR_MARKER} ──`;

// The no-arg semantic call inside the tsgo program wrapper (exact text after
// the TNB-PATCH directive pass). Replaced in both bundles.
const INCR_CALL_SITE = [
	"    getSemanticDiagnostics: (sourceFile) => {",
	"      var _a10, _b2;",
	"      const proj = liveProject();",
	"      if (sourceFile == null ? void 0 : sourceFile.fileName) return getSemanticDiagnosticsForFile(proj, sourceFile.fileName);",
	"      return mapTsgoDiagsAligned((_b2 = (_a10 = proj.program).getSemanticDiagnostics) == null ? void 0 : _b2.call(_a10));",
	"    },",
].join("\n");
const INCR_CALL_SITE_REPLACED = [
	"    getSemanticDiagnostics: (sourceFile) => {",
	"      var _a10, _b2;",
	"      const proj = liveProject();",
	"      if (sourceFile == null ? void 0 : sourceFile.fileName) return getSemanticDiagnosticsForFile(proj, sourceFile.fileName);",
	"      return tnbSemanticDiagnosticsHook(proj);",
	"    },",
].join("\n");

for (const base of ["typescript.js", "_tsc.js"]) {
	const file = path.join(libDir, base);
	let src = fs.readFileSync(file, "utf8");
	// strip previously applied incr patch so it can be replaced idempotently
	src = src.replace(/\/\/ ── TNB-INCRPATCH[\s\S]*?── end TNB-INCRPATCH ──\r?\n?/, "");
	src = src.replace(INCR_CALL_SITE_REPLACED, INCR_CALL_SITE);
	if (!src.includes(INCR_ANCHOR)) {
		console.error(`${base}: incr anchor not found (directive patch must run first)!`);
		process.exit(1);
	}
	if (!src.includes(INCR_CALL_SITE)) {
		console.error(`${base}: incr call site not found!`);
		process.exit(1);
	}
	src = src.replace(INCR_ANCHOR, INCR_ANCHOR + INCR_HELPERS);
	src = src.replace(INCR_CALL_SITE, INCR_CALL_SITE_REPLACED);
	fs.writeFileSync(file, src);
	console.log(`${base}: incr patch applied`);
}

// ── Fourth pass: TNB-GRAPHPATCH ─────────────────────────────────────────────
// Module resolution graph dump for the vue-tsc-go incremental cache. When the
// cache parent sets VUE_TSC_GO_DUMP_GRAPH=<path>, the run writes
// { edges: { [file]: [resolvedFile...] }, unresolvedRelative: bool } derived
// from the Go engine's program resolution info (modules + type reference
// directives). The parent uses the graph to compute, for the next run, the
// reverse transitive dependents of changed files — exactly the set whose
// diagnostics may have changed.
const GRAPH_MARKER = "TNB-GRAPHPATCH";
const GRAPH_ANCHOR = "  // ── end TNB-DUMPPATCH ──";
const GRAPH_CODE = `

  // ── ${GRAPH_MARKER}: module resolution graph dump for the vue-tsc-go cache ──
  if (process.env.VUE_TSC_GO_DUMP_GRAPH) {
    try {
      const tnbGraphFs = require("node:fs");
      const tnbGraphProgram = project && project.program;
      const tnbRes = tnbGraphProgram && tnbGraphProgram.getProgramResolutionInfo && tnbGraphProgram.getProgramResolutionInfo();
      const tnbEdges = {};
      let tnbUnresolvedRelative = false;
      const tnbScan = (tnbGroups) => {
        for (const tnbM of tnbGroups || []) {
          if (!tnbM || !tnbM.file) continue;
          const tnbList = tnbEdges[tnbM.file] || (tnbEdges[tnbM.file] = []);
          for (const tnbR of tnbM.resolutions || []) {
            if (tnbR && tnbR.resolvedFileName) tnbList.push(tnbR.resolvedFileName);
            else if (/^\\.\\.?[\\\\/]/.test(String((tnbR && tnbR.moduleName) || ""))) tnbUnresolvedRelative = true;
          }
        }
      };
      tnbScan(tnbRes && tnbRes.modules);
      tnbScan(tnbRes && tnbRes.typeReferenceDirectives);
      tnbGraphFs.writeFileSync(process.env.VUE_TSC_GO_DUMP_GRAPH, JSON.stringify({ edges: tnbEdges, unresolvedRelative: tnbUnresolvedRelative }));
    } catch (tnbGraphE) {
      try { require("node:fs").writeFileSync(process.env.VUE_TSC_GO_DUMP_GRAPH + ".err", String(tnbGraphE && tnbGraphE.stack || tnbGraphE)); } catch {}
    }
  }
  // ── end ${GRAPH_MARKER} ──`;

for (const base of ["typescript.js", "_tsc.js"]) {
	const file = path.join(libDir, base);
	let src = fs.readFileSync(file, "utf8");
	// strip a previously applied graph patch so it can be replaced idempotently
	src = src.replace(/\/\/ ── TNB-GRAPHPATCH[\s\S]*?── end TNB-GRAPHPATCH ──\r?\n?/, "");
	// strip the temporary TNB-PROBEPATCH segment if present (dev leftover)
	src = src.replace(/\/\/ ── TNB-PROBEPATCH[\s\S]*?── end TNB-PROBEPATCH ──\r?\n?/, "");
	if (!src.includes(GRAPH_ANCHOR)) {
		console.error(`${base}: graph anchor not found (dump patch must run first)!`);
		process.exit(1);
	}
	src = src.replace(GRAPH_ANCHOR, GRAPH_ANCHOR + GRAPH_CODE);
	fs.writeFileSync(file, src);
	console.log(`${base}: graph patch applied`);
}
