#!/usr/bin/env node
// Loads this extension explicitly (`pi -e ./index.ts`) and checks both providers
// register their models. Complements test-startup.mjs, which loads the working
// tree the way pi normally would, alongside every other installed extension.
//
// Replaces the old inline `pi -e ./index.ts --list-models ...` npm script, which
// invoked bare `pi` and so broke whenever the PATH shim could not run.

import { spawnSync } from "node:child_process";
import { requirePi } from "./resolve-pi.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pi = requirePi();
console.log(`pi ${pi.version} (${pi.bin})${pi.bundled ? " [bundled]" : ""}\n`);

let failures = 0;
for (const provider of ["sap-aicore", "sap-aicore-foundation"]) {
	const result = spawnSync(
		pi.bin,
		["-e", `${ROOT}/index.ts`, "--list-models", provider, "--offline"],
		{ encoding: "utf8", timeout: 180_000 },
	);
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	const listed = output.split("\n").filter((l) => l.startsWith(provider)).length;
	console.log(`  ${listed > 0 ? "✓" : "❌"} ${provider}: ${listed} model(s)`);
	if (listed === 0) {
		failures++;
		console.error(output.trim().split("\n").slice(0, 6).join("\n"));
	}
}

if (failures > 0) process.exit(1);
console.log("\nBoth providers register under an explicit -e load");
