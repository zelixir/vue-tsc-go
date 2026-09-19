"use strict";

/**
 * Randomized mutation stability test for the RESIDENT SESSION WORKER
 * (bin/worker.js). Mirrors test/mutation.test.js, but the worker process stays
 * alive across all rounds (forced via VUE_TSC_GO_WORKER=1): every round runs
 * the cached pipeline THROUGH the worker (replay / incremental / full path)
 * and requires byte-identical stdout and equal exit codes versus a fresh
 * fully uncached --no-cache run.
 *
 * Usage: node test/mutation-worker.test.js [rounds]
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "vue-tsc-go.js");
const FIXTURE = path.join(__dirname, "fixture");
const SRC = path.join(FIXTURE, "src");

const ROUNDS = Number(process.argv[2]) || 25;
let seed = Number(process.argv[3]) || 20260919;
function rand() {
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

// ── mutation state (same rules as mutation.test.js) ─────────────────────────
const BASE_FILES = ["helper.ts", "main.ts", "App.vue"];
const backup = {};
for (const f of BASE_FILES) backup[f] = fs.readFileSync(path.join(SRC, f), "utf8");
const generated = new Set();
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
	"\nconst __mutErr2: string = 123;\n",
	"\nconsole.log(__totallyUnknownSymbol);\n",
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

function mutate() {
	const undos = [];
	const n = 1 + Math.floor(rand() * 3);
	for (let i = 0; i < n; i++) {
		const op = pick(["error", "unerror", "comment", "comment", "genfile", "genfile-import", "delfile", "vue-error"]);
		try {
			if (op === "error") undos.push(addError(pick(BASE_FILES.filter((f) => f.endsWith(".ts")))));
			else if (op === "vue-error") undos.push(addVueTemplateError("App.vue"));
			else if (op === "unerror") {
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
		} catch {}
	}
	return () => {
		for (const u of undos) { try { u(); } catch {} }
	};
}

function workerPids() {
	// find live worker pids via the cache dir meta files (fixture cache dir)
	const dir = path.join(FIXTURE, ".vue-tsc-go-cache", "worker");
	let out = [];
	try {
		for (const n of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
			try {
				const m = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
				if (m && Number.isInteger(m.pid)) out.push({ pid: m.pid, meta: path.join(dir, n) });
			} catch {}
		}
	} catch {}
	return out;
}

function shutdownWorkers() {
	for (const { pid } of workerPids()) {
		try { process.kill(pid); } catch {}
	}
	// wait briefly for exit
	for (let i = 0; i < 20; i++) {
		if (!workerPids().length) break;
		spawnSync(process.execPath, ["-e", "setTimeout(()=>{},100)"]);
	}
}

function stripDebug(s) {
	return s.split(/\r?\n/).filter((l) => !l.startsWith("[vue-tsc-go debug]")).join("\n");
}

function main() {
	const failures = [];
	let modesSeen = new Set();
	reset();
	// establish baseline: uncached full run, then a worker run (spawns worker, full in-worker)
	run({ VUE_TSC_GO_NO_CACHE: "1" });
	run({ VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
	try {
		for (let round = 1; round <= ROUNDS; round++) {
			const undo = mutate();
			try {
				const workerRun = run({ VUE_TSC_GO_WORKER: "1", VUE_TSC_GO_DEBUG: "1" });
				const mode = /worker mode=(\w+)/.exec(workerRun.stderr)?.[1] || "?";
				const uncached = run({ VUE_TSC_GO_NO_CACHE: "1" });
				const ok = workerRun.stdout === uncached.stdout && workerRun.exitCode === uncached.exitCode
					&& stripDebug(workerRun.stderr) === stripDebug(uncached.stderr);
				if (ok) modesSeen.add(mode);
				console.log(`round ${String(round).padStart(2)}: ${ok ? "match" : "MISMATCH"} exit(${workerRun.exitCode}/${uncached.exitCode}) mode=${mode}`);
				if (!ok) {
					failures.push(round);
					console.log("  --- worker stdout ---\n" + workerRun.stdout);
					console.log("  --- uncached stdout ---\n" + uncached.stdout);
					console.log("  --- worker stderr ---\n" + workerRun.stderr);
					console.log("  --- uncached stderr ---\n" + uncached.stderr);
				}
				undo();
				run({ VUE_TSC_GO_WORKER: "1" }); // re-store post-undo state via worker
			} catch (e) {
				failures.push(round);
				console.log(`round ${round}: threw ${e}`);
				try { undo(); } catch {}
			}
		}
	} finally {
		reset();
		shutdownWorkers();
		try { fs.rmSync(path.join(FIXTURE, ".vue-tsc-go-cache", "worker"), { recursive: true, force: true }); } catch {}
	}
	if (failures.length) {
		console.error(`WORKER MUTATION TEST FAILED: ${failures.length}/${ROUNDS} rounds mismatched (seed ${seed})`);
		process.exit(1);
	}
	console.log(`worker mutation test: ${ROUNDS}/${ROUNDS} rounds byte-identical (modes: ${[...modesSeen].join(",") || "none"})`);
}

main();
