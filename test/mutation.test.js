"use strict";

/**
 * Randomized mutation stability test for the incremental diagnostic cache.
 *
 * Each round applies 1-3 random mutations to the fixture (inject errors,
 * remove them, comment-only edits, add files, delete files, edit imports),
 * then runs vue-tsc-go twice: once with the cache (which may take the
 * incremental or the full-run path) and once fully uncached. The requirement
 * is byte-identical stdout and equal exit codes in every single round — any
 * mismatch is a soundness bug in the invalidation rules.
 *
 * Usage: node test/mutation.test.js [rounds]
 */

const fs = require("node:fs");
const path = "path".length ? require("node:path") : null;
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "vue-tsc-go.js");
const FIXTURE = path.join(__dirname, "fixture");
const SRC = path.join(FIXTURE, "src");

const ROUNDS = Number(process.argv[2]) || 25;
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
const BASE_FILES = ["helper.ts", "main.ts", "App.vue"];
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
	const p = path.join(SRC, file);
	fs.writeFileSync(p, fs.readFileSync(p, "utf8") + `\n// __mutComment ${Math.floor(rand() * 1e6)}\n`);
}

function addVueTemplateError(file) {
	const p = path.join(SRC, file);
	const text = fs.readFileSync(p, "utf8");
	const injected = text.replace(/\n<\/template>/, `\n\t<span>{{ __mutUnknownInTemplate${Math.floor(rand() * 1000)} }}</span>\n</template>`);
	if (injected === text) return () => {};
	fs.writeFileSync(p, injected);
	return () => fs.writeFileSync(p, text);
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
		const op = pick(["error", "unerror", "comment", "comment", "genfile", "genfile-import", "delfile", "vue-error"]);
		try {
			if (op === "error") undos.push(addError(pick(BASE_FILES.filter((f) => f.endsWith(".ts")))));
			else if (op === "vue-error") undos.push(addVueTemplateError("App.vue"));
			else if (op === "unerror") {
				// remove the last error line if present
				const p = path.join(SRC, "helper.ts");
				const text = fs.readFileSync(p, "utf8");
				const found = ERROR_LINES.find((l) => text.includes(l.trim().slice(0, 24)));
				if (found) fs.writeFileSync(p, text.replace(found, ""));
			} else if (op === "comment") addComment(pick(BASE_FILES));
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
	reset();
	run({ VUE_TSC_GO_NO_CACHE: "1" }); // warm start: establish a clean baseline entry
	run({}); // cached run stores the clean entry
	for (let round = 1; round <= ROUNDS; round++) {
		const undo = mutate();
		try {
			const cached = run({ VUE_TSC_GO_DEBUG: "1" });
			const mode = /miss handled mode=(\w+)/.exec(cached.stderr)?.[1] || (cached.stderr.includes("entry=HIT") ? "hit" : "?");
			const uncached = run({ VUE_TSC_GO_NO_CACHE: "1" });
			const ok = cached.stdout === uncached.stdout && cached.exitCode === uncached.exitCode;
			const desc = cached.stdout === uncached.stdout ? "stdout=OK" : "STDOUT-DIFF";
			const modeStr = ok ? `mode=${mode}` : "MISMATCH";
			console.log(`round ${String(round).padStart(2)}: ${ok ? "match" : "MISMATCH"} exit(${cached.exitCode}/${uncached.exitCode}) ${modeStr} ${desc}`);
			if (!ok) {
				failures.push(round);
				console.log("  --- cached stdout ---\n" + cached.stdout);
				console.log("  --- uncached stdout ---\n" + uncached.stdout);
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
	console.log(`mutation test: ${ROUNDS}/${ROUNDS} rounds byte-identical (seed ok)`);
}

main();
