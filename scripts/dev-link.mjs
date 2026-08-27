#!/usr/bin/env node
// Swaps the npm-installed copy of this extension for a symlink to the working
// tree, so a normal `pi` run (all extensions discovered, no -e, no -ne) loads
// the code you are editing.
//
//   node scripts/dev-link.mjs link     # working tree becomes the live extension
//   node scripts/dev-link.mjs unlink   # restore the published copy
//   node scripts/dev-link.mjs status
//
// The published copy is renamed aside rather than deleted, and `link` refuses to
// run if a backup is already parked there, so an interrupted run can never lose
// it. Nothing in pi's settings.json is touched: `pi list` still shows the same
// npm:pi-sap-aicore entry, it just points at this repo now.

import { existsSync, lstatSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const INSTALLED = join(
	homedir(),
	".pi/agent/npm/node_modules/pi-sap-aicore",
);
const BACKUP = `${INSTALLED}.dev-link-backup`;

const isLink = (path) => existsSync(path) && lstatSync(path).isSymbolicLink();

export function status() {
	if (isLink(INSTALLED)) return "linked";
	if (existsSync(BACKUP)) return "inconsistent";
	if (existsSync(INSTALLED)) return "published";
	return "missing";
}

export function link() {
	const state = status();
	if (state === "linked") return false;
	if (state === "inconsistent") {
		throw new Error(
			`A backup is parked at ${BACKUP} but ${INSTALLED} is not a link. ` +
				`Resolve by hand before linking.`,
		);
	}
	if (state === "missing") {
		throw new Error(
			`${INSTALLED} does not exist — install the extension first ` +
				`(pi install npm:pi-sap-aicore).`,
		);
	}
	renameSync(INSTALLED, BACKUP);
	symlinkSync(REPO, INSTALLED, "dir");
	return true;
}

export function unlink() {
	if (!isLink(INSTALLED)) return false;
	rmSync(INSTALLED);
	if (existsSync(BACKUP)) renameSync(BACKUP, INSTALLED);
	return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const command = process.argv[2];
	if (command === "link") {
		console.log(link() ? `linked ${INSTALLED} -> ${REPO}` : "already linked");
	} else if (command === "unlink") {
		console.log(unlink() ? `restored published copy at ${INSTALLED}` : "not linked");
	} else if (command === "status") {
		console.log(`${status()} (${INSTALLED})`);
	} else {
		console.error("usage: dev-link.mjs link|unlink|status");
		process.exit(1);
	}
}
