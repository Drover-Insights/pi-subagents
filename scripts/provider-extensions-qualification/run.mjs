#!/usr/bin/env node
/**
 * Provider-extension qualification runner (issue #40).
 *
 *   node scripts/provider-extensions-qualification/run.mjs \
 *     --root <qualification root> --run-id <id> --host <version> \
 *     --suite <generic|consumer> --mode <background|interactive|resume> \
 *     [--scenario <name>]... [--deadline-seconds <n>]
 *
 * `<root>/hosts/host-<version>` must hold a provisioned, read-only Pi host.
 * Fixtures go to `<root>/runs/<id>/fixtures/`, results to `<root>/runs/<id>/evidence/`.
 * The runner re-executes itself inside `unshare` with its own network and PID
 * namespaces: only loopback exists, and every process it started dies with it.
 * Every Node process it starts preloads the network guard.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	collectObservations,
	prepareCell,
	runInteractiveParent,
	runPrintParent,
	startEndpoints,
	stopTmux,
	stopTmuxSession,
	writeEndpointConfig,
	writePlan,
} from "./cell.mjs";
import { consumerScenariosFor } from "./consumer-scenarios.mjs";
import { scenariosFor as genericScenariosFor } from "./scenarios.mjs";

const VALUE_FLAGS = { "--root": "root", "--run-id": "runId", "--host": "host", "--suite": "suite", "--mode": "mode" };

function parseArgs(argv) {
	const options = { scenarios: [], deadlineSeconds: 120 };
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (key === "--inner") {
			options.inner = true;
			continue;
		}
		const value = argv[++index];
		if (key === "--scenario") options.scenarios.push(value);
		else if (key === "--deadline-seconds") options.deadlineSeconds = Number(value);
		else if (VALUE_FLAGS[key]) options[VALUE_FLAGS[key]] = value;
		else throw new Error(`unknown argument ${key}`);
	}
	for (const required of ["root", "runId", "host", "suite", "mode"]) {
		if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
	}
	// Both become path segments under the root.
	for (const name of ["runId", "host"]) {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options[name])) {
			throw new Error(`--${name === "runId" ? "run-id" : name} must be a plain name`);
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

if (!options.inner) {
	const self = fileURLToPath(import.meta.url);
	const inner = [process.execPath, self, "--inner", ...process.argv.slice(2)]
		.map((part) => `'${String(part).replaceAll("'", "'\\''")}'`)
		.join(" ");
	const result = spawnSync(
		"unshare",
		["-rn", "--pid", "--fork", "--mount-proc", "--kill-child", "sh", "-c", `ip link set lo up && exec ${inner}`],
		{
			stdio: "inherit",
			timeout: (options.deadlineSeconds * 40 + 120) * 1000,
			killSignal: "SIGKILL",
		},
	);
	process.exit(result.status ?? 1);
}

// Refuse to run outside the namespaces the outer runner sets up.
const interfaces = Object.keys(networkInterfaces());
if (interfaces.some((name) => name !== "lo") || process.pid !== 1) {
	throw new Error(`--inner must run inside the runner's namespaces (interfaces: ${interfaces.join(",")}, pid ${process.pid})`);
}

/** Kill every process a cell recorded that is still alive, so none outlives its verdict. */
function killCellProcesses(cell) {
	const dir = join(cell.evidenceDir, "processes");
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		let pid;
		try {
			pid = JSON.parse(readFileSync(join(dir, file), "utf8")).pid;
		} catch {
			pid = Number(file.replace(/\.json$/, ""));
		}
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

const hostDir = join(options.root, "hosts", `host-${options.host}`);
if (!existsSync(join(hostDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"))) {
	throw new Error(`no provisioned Pi host at ${hostDir}`);
}
const runDir = join(options.root, "runs", options.runId);
const summary = [];
// One private tmux server per run, its socket under the run's fixtures.
const socket = join(runDir, "fixtures", "tmux.sock");
if (socket.length > 100) throw new Error(`tmux socket path too long (${socket.length}); use a shorter --run-id`);
mkdirSync(join(runDir, "fixtures"), { recursive: true });
let lastCell;
const scenariosFor = options.suite === "consumer" ? consumerScenariosFor : genericScenariosFor;
try {
	for (const [cellIndex, scenario] of scenariosFor(options).entries()) {
		const cellName = `${options.suite}-${options.host}-${options.mode}-${scenario.name}`;
		const cellDir = join(runDir, "fixtures", cellName);
		const evidenceDir = join(runDir, "evidence", cellName);
		if (existsSync(evidenceDir)) throw new Error(`evidence for ${cellName} already exists in run ${options.runId}`);
		mkdirSync(evidenceDir, { recursive: true });
		const setup = scenario.setup({ fixtures: cellDir, hostDir, root: options.root, evidenceDir });
		const phases = setup.phases ?? [{ steps: setup.steps }];
		const cell = prepareCell({ cellDir, evidenceDir, host: hostDir, ...setup });
		writePlan(cell, phases[0].steps);
		const session = `cell${cellIndex}`;
		lastCell = cell;
		let parent;
		let endpoints;
		try {
			endpoints = await startEndpoints(cell);
			writeEndpointConfig(cell, endpoints.port);
			if (options.mode === "interactive") {
				parent = await runInteractiveParent(cell, socket, options.deadlineSeconds * 1000, session);
			} else {
				parent = { phases: [] };
				for (const [index, phase] of phases.entries()) {
					writePlan(cell, phase.steps);
					const result = await runPrintParent(cell, options.deadlineSeconds * 1000, phase.parentModel, index);
					parent.phases.push(result);
					if (result.timedOut) parent.timedOut = true;
				}
			}
		} catch (error) {
			parent = { error: String(error?.stack ?? error) };
		} finally {
			if (options.mode === "interactive") stopTmuxSession(cell, socket, session);
			killCellProcesses(cell);
			endpoints?.stop();
		}
		const observations = collectObservations(cell, parent);
		const verdict = scenario.judge(observations, { host: options.host, mode: options.mode, cell });
		const row = { cell: cellName, scenario: scenario.name, ...verdict };
		writeFileSync(join(evidenceDir, "verdict.json"), JSON.stringify(row, null, 2));
		summary.push(row);
		console.log(`${row.result.toUpperCase()} ${cellName}${row.reasons?.length ? `: ${row.reasons.join("; ")}` : ""}`);
	}
} finally {
	if (lastCell) stopTmux(lastCell, socket);
}
process.exit(summary.every((row) => row.result === "pass") ? 0 : 1);
