"use strict";

/**
 * Randomized mutation stability test for the incremental diagnostic cache.
 *
 * Each round applies 1-3 random mutations to the fixture (inject errors,
 * remove them, comment-only edits, add files, delete files, edit imports,
 * change type declarations, add `declare global` augmentations, ...), then
 * runs vue-tsc-go twice: once with the cache (which may take the sub-program
 * incremental path, the full-program incremental path, or the full-run path)
 * and once fully uncached. The requirement is byte-identical stdout and equal
 * exit codes in every single round — any mismatch is a soundness bug in the
 * invalidation rules.
 *
 * Mutation surfaces deliberately cover: plain .ts modules, .vue SFCs (script +
 * template), a barrel (re-export) file, a type-only file, a deep shared module
 * chain (types.ts -> deep.ts -> barrel.ts -> dependents), generated files and
 * `declare global` augmentations (which must force the conservative full-run
 * fallback while still producing identical output).
 *
 * Usage: node test/mutation.test.js [rounds] [seed]
 */

const fs = require("node:fs");
const path = "path".length ? require("node:path") : null;
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "vue-tsc-go.js");
const FIXTURE = path.join(__dirname, "fixture");
const SRC = path.join(FIXTURE, "src");

const ROUNDS = Number(process.argv[2]) || 30;
let seed = Number(process.argv[3]) || 20260919;
function rand() {
	// deterministic PRNG so failures are reproducible
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function run(env) {
	const res = spawnSync(process.execPath, [BIN, "--noEmit"], {
		cwd: FIXTURE,
		env: { ...process.env, ...env },
		encoding: "buffer",
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		stdout: res.stdout ? res.stdout.toString("utf8") : "",
		stderr: res.stderr ? res.stderr.toString("utf8") : "",
		exitCode: typeof res.status === "number" ? res.status : 1,
	};
}

// ── mutation state ──────────────────────────────────────────────────────────
// every static fixture file is backed up; reset() restores all of them
const BASE_FILES = ["helper.ts", "main.ts", "deep.ts", "barrel.ts", "types.ts", "App.vue", "widget.vue"];
const TS_FILES = BASE_FILES.filter((f) => f.endsWith(".ts"));
const backup = {};
for (const f of BASE_FILES) backup[f] = fs.readFileSync(path.join(SRC, f), "utf8");
const generated = new Set(); // extra files created across rounds
let genCounter = 0;

function reset() {
	for (const [f, text] of Object.entries(backup)) fs.writeFileSync(path.join(SRC, f), text);
	for (const f of generated) {
		try { fs.unlinkSync(path.join(SRC, f)); } catch {}
	}
	generated.clear();
}

const ERROR_LINES = [
	'\nexport const __mutErr: number = "x";\n',
	'\nconst __mutErr2: string = 123;\n',
	'\nconsole.log(__totallyUnknownSymbol);\n',
];
function addError(file) {
	const p = path.join(SRC, file);
	let text = fs.readFileSync(p, "utf8");
	const line = pick(ERROR_LINES.filter((l) => !text.includes(l.trim().slice(0, 24)))) || ERROR_LINES[0];
	text += line;
	fs.writeFileSync(p, text);
	return () => {
		const t = fs.readFileSync(p, "utf8");
		fs.writeFileSync(p, t.replace(line, ""));
	};
}

function addComment(file) {
	fs.writeFileSync(path.join(SRC, file), fs.readFileSync(path.join(SRC, file), "utf8") + `\n// __mutComment ${Math.floor(rand() * 1e6)}\n`);
}

function addVueTemplateError(file) {
	const p = path.join(SRC, file);
	const text = fs.readFileSync(p, "utf8");
	const injected = text.replace(/\n<\/template>/, `\n\t<span>{{ __mutUnknownInTemplate${Math.floor(rand() * 1000)} }}</span>\n</template>`);
	if (injected === text) return () => {};
	fs.writeFileSync(p, injected);
	return () => fs.writeFileSync(p, text);
}

/** Type-declaration edit: flips the type of WidgetShape.scale so the error
 *  pattern across the dependents (deep.ts, widget.vue) inverts. */
function changeTypeDecl() {
	const p = path.join(SRC, "types.ts");
	const text = fs.readFileSync(p, "utf8");
	const from = "scale: number";
	const to = "scale: string";
	if (!text.includes(from)) return () => {};
	fs.writeFileSync(p, text.replace(from, to));
	return () => fs.writeFileSync(p, text);
}

/** Global-scope augmentation: `declare global` must force the conservative
 *  full-run fallback (invalidation gate) while output stays identical. */
function addDeclareGlobal(file) {
	const p = path.join(SRC, file);
	const text = fs.readFileSync(p, "utf8");
	const block = `\ndeclare global {\n\tinterface Window {\n\t\t__mutAug${Math.floor(rand() * 1e6)}?: boolean\n\t}\n}\n`;
	fs.writeFileSync(p, text + block);
	return () => {
		const t = fs.readFileSync(p, "utf8");
		fs.writeFileSync(p, t.replace(block, ""));
	};
}

function addGeneratedFile(withImport) {
	const name = `__mutgen${++genCounter}.ts`;
	const exportsSomething = rand() < 0.5;
	let text;
	if (exportsSomething) {
		text = `export function __mutGen${genCounter}(a: string): number { return a.length }\n`;
	} else {
		text = `const __x${genCounter}: number = "type error here";\n`;
	}
	if (withImport) {
		// import through the barrel -> generated file depends on the chain
		text = `import { greet } from './helper'\nconsole.log(greet('x'))\n` + text;
	}
	fs.writeFileSync(path.join(SRC, name), text);
	generated.add(name);
	return () => {
		fs.unlinkSync(path.join(SRC, name));
		generated.delete(name);
	};
}

/** One round of random mutations; returns an undo function. */
function mutate() {
	const undos = [];
	const n = 1 + Math.floor(rand() * 3); // 1..3 mutations
	for (let i = 0; i < n; i++) {
		const op = pick([
			"error", "unerror", "comment", "comment",
			"genfile", "genfile-import", "delfile",
			"vue-error", "widget-error",
			"type-decl", "augment", "barrel-comment", "deep-error",
		]);
		try {
			if (op === "error") undos.push(addError(pick(TS_FILES)));
			else if (op === "vue-error") undos.push(addVueTemplateError("App.vue"));
			else if (op === "widget-error") undos.push(addVueTemplateError("widget.vue"));
			else if (op === "unerror") {
				// remove the first known error line if present
				const p = path.join(SRC, "helper.ts");
				const text = fs.readFileSync(p, "utf8");
				const found = ERROR_LINES.find((l) => text.includes(l.trim().slice(0, 24)));
				if (found) fs.writeFileSync(p, text.replace(found, ""));
			} else if (op === "comment") addComment(pick(BASE_FILES));
			else if (op === "barrel-comment") addComment("barrel.ts");
			else if (op === "deep-error") undos.push(addError("deep.ts"));
			else if (op === "type-decl") undos.push(changeTypeDecl());
			else if (op === "augment") {
				const u = addDeclareGlobal(pick(TS_FILES));
				if (typeof u === "function") undos.push(u);
			}
			else if (op === "genfile") undos.push(addGeneratedFile(false));
			else if (op === "genfile-import") undos.push(addGeneratedFile(true));
			else if (op === "delfile") {
				if (generated.size) {
					const name = pick([...generated]);
					fs.unlinkSync(path.join(SRC, name));
					generated.delete(name);
				}
			}
		} catch {
			// a mutation that cannot apply (e.g. undo on clean file) is fine
		}
	}
	return () => {
		for (const u of undos) { try { u(); } catch {} }
	};
}

function main() {
	const failures = [];
	const modesSeen = new Set();
	reset();
	run({ VUE_TSC_GO_NO_CACHE: "1" }); // warm start: establish a clean baseline entry
	run({}); // cached run stores the clean entry
	for (let round = 1; round <= ROUNDS; round++) {
		const undo = mutate();
		try {
			const cached = run({ VUE_TSC_GO_DEBUG: "1" });
			const mode = /miss handled mode=([\w-]+)/.exec(cached.stderr)?.[1] || (cached.stderr.includes("entry=HIT") ? "hit" : "?");
			const uncached = run({ VUE_TSC_GO_NO_CACHE: "1" });
			const ok = cached.stdout === uncached.stdout && cached.exitCode === uncached.exitCode;
			if (ok) modesSeen.add(mode);
			const desc = cached.stdout === uncached.stdout ? "stdout=OK" : "STDOUT-DIFF";
			const modeStr = ok ? `mode=${mode}` : "MISMATCH";
			console.log(`round ${String(round).padStart(2)}: ${ok ? "match" : "MISMATCH"} exit(${cached.exitCode}/${uncached.exitCode}) ${modeStr} ${desc}`);
			if (!ok) {
				failures.push(round);
				console.log("  --- cached stdout ---\n" + cached.stdout);
				console.log("  --- uncached stdout ---\n" + uncached.stdout);
				console.log("  --- cached stderr (modes) ---\n" + cached.stderr.split(/\r?\n/).filter((l) => l.includes("[vue-tsc-go debug]")).join("\n"));
				console.log("  --- src files ---\n" + fs.readdirSync(SRC).join("\n"));
				for (const f of fs.readdirSync(SRC)) {
					if (f.startsWith("__mutgen")) console.log(`  --- ${f} ---\n` + fs.readFileSync(path.join(SRC, f), "utf8"));
				}
			}
			// undo mutations and let the next round start from a stored entry of
			// THIS round's state (the cached run above already wrote it)
			undo();
			run({}); // re-store the post-undo state so rounds stay independent
		} catch (e) {
			failures.push(round);
			console.log(`round ${round}: threw ${e}`);
			try { undo(); } catch {}
		}
	}
	reset();
	if (failures.length) {
		console.error(`MUTATION TEST FAILED: ${failures.length}/${ROUNDS} rounds mismatched (seed ${seed})`);
		process.exit(1);
	}
	console.log(`mutation test: ${ROUNDS}/${ROUNDS} rounds byte-identical (seed ok; modes: ${[...modesSeen].join(",")})`);
}

main();
