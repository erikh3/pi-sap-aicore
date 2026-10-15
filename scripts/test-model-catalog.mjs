#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createSapModelCatalogController } from "../src/model-catalog-controller.ts";
import { adaptModelsDevModel, mergeSapModels, MODELS_DEV_SOURCE } from "../src/model-catalog.ts";

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
const expectedModels = sapModels.map(adaptModelsDevModel).sort((a, b) => a.id.localeCompare(b.id));

test("forced refresh publishes every SAP entry regardless of family, generation, or tool support", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async (url) => {
		assert.equal(url, MODELS_DEV_SOURCE);
		requests++;
		return Response.json(fixture);
	};
	try {
		let cache = { fetchedAt: new Date().toISOString(), models: [] };
		const controller = createSapModelCatalogController({
			loadCatalog: () => ({
				models: mergeSapModels({ packaged: [], cache: cache.models }),
				foundationModelIds: new Set(),
				sources: { packaged: { models: [] }, cache },
			}),
			writeSnapshot: (snapshot) => { cache = snapshot; },
		});
		const snapshot = await controller.refresh({ allowNetwork: true, force: true });
		assert.equal(requests, 1);
		assert.equal(snapshot.source, MODELS_DEV_SOURCE);
		assert.equal(snapshot.count, sapModels.length);
		assert.deepEqual(snapshot.models, expectedModels);
		assert.deepEqual(controller.getCatalog().models, expectedModels);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("maintainer snapshot includes the same complete SAP catalog as runtime refresh", () => {
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
		assert.deepEqual(snapshot.models, expectedModels);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
