"use strict";

/**
 * Incremental-cache scenario benchmark: real-world "edit a few files -> run
 * typecheck again" for the bench projects. Managed mutations (backup/restore),
 * byte-for-byte comparison of the incremental run against the uncached run,
 * and timing collection.
 *
 * Usage: node test/incremental.bench.js <scenario...>
 *   scenarios: ep-leaf ep-hub vueuse-export vben-vue
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "vue-tsc-go.js");

const TS_ERROR = '\nconst __vtscgoProbe: number = "x";\n';
const TS_EXPORT = '\nexport function __vtscgoProbeExport(x: string): number { return x.length }\n';

const PROJECTS = {
	ep: {
		dir: "D:/Code/vue-tsc-go/bench/element-plus",
		args: ["-p", "tsconfig.web.json", "--composite", "false", "--noEmit"],
	},
	vueuse: {
		dir: "D:/Code/vue-tsc-go/bench/vueuse",
		args: ["--noEmit"],
	},
	vben: {
		dir: "D:/Code/vue-tsc-go/bench/vue-vben-admin/apps/web-antd",
		args: ["--noEmit", "--skipLibCheck"],
	},
};

function findFile(dir, fragments) {
	// small helper to locate a file by path fragments
	const queue = [dir];
	while (queue.length) {
		const d = queue.shift();
		let entries;
		try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			if (e.name === "node_modules") continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) queue.push(p);
			else {
				const rel = path.relative(dir, p).replace(/\\/g, "/");
				if (fragments.every((f) => rel.includes(f))) return p;
			}
		}
	}
	throw new Error("file not found: " + fragments.join("/"));
}

const SCENARIOS = {
	"ep-leaf": {
		project: "ep",
		label: "element-plus leaf .ts (menu-bar.ts, 14 transitive dependents)",
		file: () => findFile(PROJECTS.ep.dir, ["components/menu/src/utils/menu-bar.ts"]),
		mutate: (text) => text + TS_ERROR,
	},
	"ep-hub": {
		project: "ep",
		label: "element-plus shared .vue (button.vue, 104 transitive dependents)",
		file: () => findFile(PROJECTS.ep.dir, ["components/button/src/button.vue"]),
		mutate: (text) => text.replace(/\n<\/template>/, '\n  <span v-if="false">{{ loading.toFixed(1) }}</span>\n</template>'),
	},
	"vueuse-export": {
		project: "vueuse",
		label: "vueuse add valid export in shared .ts (component.ts, closure 5)",
		file: () => findFile(PROJECTS.vueuse.dir, ["core", "onClickOutside", "component.ts"]),
		mutate: (text) => text + TS_EXPORT,
	},
	"vueuse-error": {
		project: "vueuse",
		label: "vueuse inject type error in shared .ts (component.ts)",
		file: () => findFile(PROJECTS.vueuse.dir, ["core", "onClickOutside", "component.ts"]),
		mutate: (text) => text + TS_ERROR,
	},
	"vueuse-hub": {
		project: "vueuse",
		label: "vueuse shared utils barrel (packages/shared/utils/index.ts, closure 630) — expected full-run fallback",
		file: () => findFile(PROJECTS.vueuse.dir, ["shared", "utils", "index.ts"]),
		mutate: (text) => text + TS_ERROR,
	},
	"vben-vue": {
		project: "vben",
		label: "vben apps/web-antd single .vue",
		file: () => findFile(PROJECTS.vben.dir, ["src", "views", "dashboard", "analytics", "index.vue"]),
		mutate: (text) => text.replace(/\n<\/template>/, '\n  <span v-if="false">{{ notDefinedAnywhere.toFixed(1) }}</span>\n</template>'),
	},
};

function runVueTscGo(project, args, env) {
	const t0 = Date.now();
	const res = spawnSync(process.execPath, [BIN, ...args], {
		cwd: project.dir,
		env: { ...process.env, ...(env || {}) },
		encoding: "buffer",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	return {
		stdout: res.stdout ? res.stdout.toString("utf8") : "",
		stderr: res.stderr ? res.stderr.toString("utf8") : "",
		exitCode: typeof res.status === "number" ? res.status : 1,
		ms: Date.now() - t0,
	};
}

function runScenario(name) {
	const sc = SCENARIOS[name];
	const project = PROJECTS[sc.project];
	const file = sc.file();
	const backup = fs.readFileSync(file, "utf8");
	const restore = () => fs.writeFileSync(file, backup);
	const results = {};
	try {
		// 1. cold full run (fresh cache) -> baseline
		restore();
		runVueTscGo(project, ["--clear-cache"]);
		const cold = runVueTscGo(project, project.args);
		results.coldMs = cold.ms;
		results.baseline = cold.stdout;

		// 2. unchanged hit
		const hit = runVueTscGo(project, project.args);
		results.hitMs = hit.ms;

		// 3. mutate -> incremental run vs uncached full run
		fs.writeFileSync(file, sc.mutate(backup));
		const incr = runVueTscGo(project, project.args, { VUE_TSC_GO_DEBUG: "1" });
		results.incrMs = incr.ms;
		results.incrMode = /mode=([\w-]+)/.exec(incr.stderr)?.[1] || "?";
		results.incrAffected = /affected=(\d+)/.exec(incr.stderr)?.[1] || "?";
		const full = runVueTscGo(project, project.args, { VUE_TSC_GO_NO_CACHE: "1" });
		results.fullMs = full.ms;
		results.incrEqFull = incr.stdout === full.stdout && incr.exitCode === full.exitCode;
		results.mutatedOutput = incr.stdout;
		results.incrExit = incr.exitCode;
		results.fullExit = full.exitCode;

		// 4. restore -> incremental run must reproduce the baseline byte for byte
		restore();
		const back = runVueTscGo(project, project.args, { VUE_TSC_GO_DEBUG: "1" });
		results.restoreMs = back.ms;
		results.restoreMode = /mode=([\w-]+)/.exec(back.stderr)?.[1] || "?";
		results.restoreEqBaseline = back.stdout === results.baseline && back.exitCode === cold.exitCode;

		// 5. confirm a plain hit still replays exactly
		const hit2 = runVueTscGo(project, project.args);
		results.hit2EqBaseline = hit2.stdout === results.baseline && hit2.exitCode === cold.exitCode;
	} finally {
		restore();
	}
	return results;
}

function main() {
	const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
	for (const name of names) {
		const r = runScenario(name);
		console.log(`\n=== ${name}: ${SCENARIOS[name].label}`);
		console.log(`  cold(full) = ${r.coldMs}ms | hit = ${r.hitMs}ms`);
		console.log(`  mutated: incremental = ${r.incrMs}ms (mode=${r.incrMode}, affected=${r.incrAffected}, exit=${r.incrExit}) vs full = ${r.fullMs}ms (exit=${r.fullExit}) -> byte-identical: ${r.incrEqFull}`);
		console.log(`  mutated stdout:\n${r.mutatedOutput.split("\n").map((l) => "    " + l).join("\n")}`);
		console.log(`  restored: incremental = ${r.restoreMs}ms (mode=${r.restoreMode}) -> equals baseline: ${r.restoreEqBaseline}; subsequent hit equals baseline: ${r.hit2EqBaseline}`);
	}
}

main();
