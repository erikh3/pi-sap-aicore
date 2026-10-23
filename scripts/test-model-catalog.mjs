#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";


const model = (id, tool_call = true) => ({
	id,
	name: `Model ${id}`,
	reasoning: true,
	tool_call,
	temperature: false,
	modalities: { input: ["text", "image"], output: ["text"] },
	limit: { context: 128000, output: 16384 },
	cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
});
const sapModels = [
	model("gpt-5.5"),
	model("gemini-3.8-flash"),
	model("gpt-6.1-sol"),
	model("anthropic--claude-5-opus"),
	model("gpt-4.1"),
	model("mistralai--mistral-medium"),
	model("future--model", false),
	model("text-embedding-3-small", false),
];
const fixture = {
	"sap-ai-core": { models: Object.fromEntries(sapModels.map((entry) => [entry.id, entry])) },
	"another-provider": { models: { unrelated: model("unrelated") } },
};
const MODELS_DEV_SOURCE = "https://models.dev/api.json";


test("maintainer snapshot includes every SAP model family without changing tenant runtime policy", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-sap-model-catalog-"));
	try {
		const script = join(directory, "scripts", "update-models.mjs");
		const stub = join(directory, "fetch-stub.mjs");
		mkdirSync(join(directory, "scripts"));
		mkdirSync(join(directory, "src"));
		copyFileSync(new URL("./update-models.mjs", import.meta.url), script);
		writeFileSync(stub, `globalThis.fetch = async (url) => {
			if (url !== ${JSON.stringify(MODELS_DEV_SOURCE)}) throw new Error("Unexpected catalog URL");
			return Response.json(${JSON.stringify(fixture)});
		};\n`);
		execFileSync(process.execPath, ["--import", pathToFileURL(stub).href, script], {
			encoding: "utf8",
			timeout: 10000,
		});
		const snapshot = JSON.parse(readFileSync(join(directory, "src", "models-snapshot.json"), "utf8"));
		assert.equal(snapshot.source, MODELS_DEV_SOURCE);
		assert.equal(snapshot.count, sapModels.length);
		assert.deepEqual(snapshot.models.map(model => model.id), sapModels.map(model => model.id).sort());
		assert.equal(snapshot.models.find(model => model.id === "future--model").tool_call, false);
		assert.equal(snapshot.models.find(model => model.id === "gemini-3.8-flash").reasoning, false);
		assert.equal(snapshot.models.find(model => model.id === "gpt-6.1-sol").cost.cacheRead, 0.1);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
