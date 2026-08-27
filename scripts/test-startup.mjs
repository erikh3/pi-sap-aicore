#!/usr/bin/env node
// Boots the real pi with every installed extension enabled — no -e, no -ne —
// against the working tree, and fails if anything did not load.
//
// This is the gate the -e/-ne workflows cannot be: `pi -e ./index.ts` loads this
// extension *instead of* the installed set, so it proves nothing about how the
// working tree behaves next to the other twenty packages, and `-ne` proves less
// still. Here the working tree is temporarily swapped in as the live
// npm:pi-sap-aicore (see dev-link.mjs) and pi discovers it the way it does on a
// normal launch.
//
// What it catches: syntax and load-time errors, activation crashes, provider
// registrations that collide with another extension, anything that only shows up
// with the full extension set present.
//
// What it does NOT catch: module-resolution mistakes. A symlinked working tree
// still has this repo's devDependencies on its real path, so a value import of
// an unmapped pi specifier resolves here and would not on a user's machine.
// `test-transform-messages.mjs` covers that statically; it has to, because
// whether a boot test catches it depends on the local pi's build.
//
// Set PI_BIN to pick a specific pi.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { link, status, unlink } from "./dev-link.mjs";
import { resolvePi } from "./resolve-pi.mjs";

let failures = 0;
function check(condition, message) {
	console.log(`  ${condition ? "✓" : "❌"} ${message}`);
	if (!condition) failures++;
}

// This gate needs a machine with pi actually installed as a user would have it:
// an extension directory to swap, and a runnable pi. CI has neither — a runner
// has no ~/.pi at all — so it skips rather than fails. `test-compat.mjs` carries
// the credential-free load assertion that does run everywhere.
const pi = resolvePi();
const installState = status();
if (!pi || installState === "missing") {
	console.log(
		`skipped: ${!pi ? "no runnable pi" : "no installed pi-sap-aicore to swap"}` +
			" — this gate needs a local pi install (see test-compat.mjs for the" +
			" assertion that runs everywhere)",
	);
	process.exit(0);
}
console.log(`pi ${pi.version} (${pi.bin})${pi.bundled ? " [bundled]" : ""}\n`);

// A neutral cwd: no project-local .pi/settings.json, no AGENTS.md discovery
// bleeding into the run.
const cwd = mkdtempSync(join(tmpdir(), "pi-startup-"));
const linked = link();
console.log(linked ? "working tree linked in as npm:pi-sap-aicore\n" : "already linked\n");
try {
	const run = (args) =>
		spawnSync(pi.bin, [...args, "--offline"], {
			cwd,
			encoding: "utf8",
			timeout: 180_000,
		});

	// Probe 1: the real startup path. `-p` runs pi non-interactively and reports
	// extension load failures exactly as an interactive launch does — this is the
	// probe that reproduces the user-facing error verbatim. The bogus provider
	// makes pi stop right after extensions are loaded, so nothing reaches a model:
	// no network, no tokens, ~2s.
	const boot = run(["-p", "ping", "--provider", "__none__", "--model", "__none__"]);
	const bootOutput = `${boot.stdout || ""}${boot.stderr || ""}`;
	const loadErrors = bootOutput
		.split("\n")
		.filter((line) => /Failed to load extension|Cannot find module/i.test(line));
	check(
		loadErrors.length === 0,
		loadErrors.length === 0
			? "every extension loaded"
			: `extension load failure:\n      ${loadErrors.join("\n      ")}`,
	);
	// Guards the probe itself: if pi ever stops reaching provider resolution, the
	// check above would pass vacuously on a silent startup.
	check(
		/Unknown provider/i.test(bootOutput),
		"pi reached provider resolution (probe still valid)",
	);

	// Probe 2: `--list-models` swallows extension load errors — a broken provider
	// just never registers — so it cannot replace probe 1, but it does catch an
	// extension that loads without registering what it should.
	const models = run(["--list-models"]);
	const modelOutput = `${models.stdout || ""}${models.stderr || ""}`;
	for (const provider of ["sap-aicore", "sap-aicore-foundation"]) {
		const listed = modelOutput
			.split("\n")
			.filter((line) => line.startsWith(provider)).length;
		check(listed > 0, `${provider}: ${listed} model(s) registered`);
	}
	check(models.status === 0, `pi --list-models exited ${models.status}`);
} finally {
	if (linked) unlink();
	rmSync(cwd, { recursive: true, force: true });
	console.log(`\npublished copy restored (dev-link: ${status()})`);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\npi starts cleanly with the working tree and all extensions");
