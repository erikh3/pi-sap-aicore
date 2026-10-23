#!/usr/bin/env node
// Finds a runnable pi.
//
// `pi` is on PATH even when it cannot run: mise installs a shim for every tool
// it knows about, and the shim fails at runtime ("No version is set for shim")
// when the active node has no pi installed. So a PATH lookup proves nothing —
// each candidate has to actually execute. Both bundled (`dist/bundle/cli.js`)
// and npm (`dist/cli.js`) layouts are searched, since they resolve extension
// imports differently and it is worth knowing which one a check ran against.
//
// Set PI_BIN to force a specific pi.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolvePi() {
	const candidates = [];
	if (process.env.PI_BIN) candidates.push(process.env.PI_BIN);
	candidates.push("pi");
	const miseNode = join(homedir(), ".local/share/mise/installs/node");
	if (existsSync(miseNode)) {
		for (const version of readdirSync(miseNode)) {
			const pkg = join(
				miseNode,
				version,
				"lib/node_modules/@earendil-works/pi-coding-agent",
			);
			for (const entry of ["dist/cli.js", "dist/bundle/cli.js"]) {
				const path = join(pkg, entry);
				if (existsSync(path)) candidates.push(path);
			}
		}
	}
	for (const bin of candidates) {
		const probe = spawnSync(bin, ["--version"], {
			encoding: "utf8",
			timeout: 60_000,
		});
		if (probe.status === 0) {
			return { bin, version: probe.stdout.trim(), bundled: bin.includes("/bundle/") };
		}
	}
	return null;
}

export function requirePi() {
	const pi = resolvePi();
	if (!pi) {
		console.error("❌ no runnable pi found — set PI_BIN to a pi executable");
		process.exit(1);
	}
	return pi;
}
