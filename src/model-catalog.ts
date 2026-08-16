import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type SapModel = {
	id: string;
	name: string;
	reasoning: boolean;
	tool_call: boolean;
	temperature: boolean;
	modalities: {
		input: ("text" | "image" | "pdf")[];
		output: "text"[];
	};
	limit: {
		context: number;
		output: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

export type SapModelOverlay = {
	models?: SapModel[];
	overrides?: Record<string, Partial<SapModel>>;
	exclude?: string[];
	foundation?: {
		enabledModelIds?: string[];
	};
};

export type SapModelsSnapshot = {
	source?: string;
	fetchedAt?: string;
	count?: number;
	models?: SapModel[];
};

export const SAP_TENANT_SOURCE = "sap-ai-core/foundation-models";
export const DEFAULT_FOUNDATION_MODEL_IDS = ["gpt-5.5"] as const;

const SAP_EFFORT_BY_LEVEL: SapModel["thinkingLevelMap"] = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
};

function packageDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

export function sapModelsDir(): string {
	return join(getAgentDir(), "pi-sap-aicore");
}

export function userOverlayPath(): string {
	return join(sapModelsDir(), "models.json");
}

export function userCachePath(): string {
	return join(sapModelsDir(), "models-cache.json");
}

export function packagedSnapshotPath(): string {
	return join(packageDir(), "models-snapshot.json");
}

export function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch (error) {
		console.warn(
			`Ignoring invalid JSON file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function readUserJsonFile<T>(path: string, label: string): T | undefined {
	try {
		return readJsonFile<T>(path);
	} catch (error) {
		console.warn(
			`Ignoring invalid pi-sap-aicore ${label} file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

export function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function loadPackagedSnapshot(): SapModelsSnapshot {
	return (
		readJsonFile<SapModelsSnapshot>(packagedSnapshotPath()) ?? { models: [] }
	);
}

export function loadUserCache(): SapModelsSnapshot | undefined {
	return readUserJsonFile<SapModelsSnapshot>(userCachePath(), "cache");
}

export function loadUserOverlay(): SapModelOverlay | undefined {
	const overlay = readUserJsonFile<SapModelOverlay>(
		userOverlayPath(),
		"overlay",
	);
	if (!overlay) return undefined;
	return {
		...overlay,
		models: overlay.models ?? [],
		overrides: overlay.overrides ?? {},
		exclude: overlay.exclude ?? [],
		foundation: {
			...overlay.foundation,
			enabledModelIds: overlay.foundation?.enabledModelIds ?? [],
		},
	};
}

function mergeModel(base: SapModel, override: Partial<SapModel>): SapModel {
	return {
		...base,
		...override,
		modalities: override.modalities
			? {
					input: override.modalities.input ?? base.modalities.input,
					output: override.modalities.output ?? base.modalities.output,
				}
			: base.modalities,
		limit: override.limit ? { ...base.limit, ...override.limit } : base.limit,
		cost: override.cost ? { ...base.cost, ...override.cost } : base.cost,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...base.thinkingLevelMap, ...override.thinkingLevelMap }
			: base.thinkingLevelMap,
	};
}

export function mergeSapModels(options: {
	packaged: SapModel[];
	cache?: SapModel[];
	overlay?: SapModelOverlay;
}): SapModel[] {
	const byId = new Map<string, SapModel>();
	// The tenant cache, once fetched, is the authoritative set of callable
	// models — it fully replaces the bundled snapshot rather than unioning with
	// it, so models.dev entries the tenant does not expose never leak back in as
	// uncallable phantoms. The packaged snapshot is only the pre-credential /
	// offline fallback used until the first refresh writes a cache.
	const base = options.cache ?? options.packaged;
	for (const model of base) byId.set(model.id, model);
	for (const model of options.overlay?.models ?? []) byId.set(model.id, model);

	for (const [id, override] of Object.entries(
		options.overlay?.overrides ?? {},
	)) {
		const existing = byId.get(id);
		if (existing) byId.set(id, mergeModel(existing, override));
	}

	for (const id of options.overlay?.exclude ?? []) byId.delete(id);

	return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export type LoadedSapModelCatalog = {
	models: SapModel[];
	foundationModelIds: Set<string>;
	sources: {
		packaged: SapModelsSnapshot;
		cache?: SapModelsSnapshot;
		overlay?: SapModelOverlay;
	};
};

function snapshotTimestamp(snapshot: SapModelsSnapshot | undefined): number | undefined {
	if (!snapshot?.fetchedAt) return undefined;
	const timestamp = Date.parse(snapshot.fetchedAt);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Persisted metadata may overlay the bundled snapshot only when it is not older. */
export function shouldUseCachedSnapshot(
	packaged: SapModelsSnapshot,
	cache: SapModelsSnapshot | undefined,
): boolean {
	if (!cache?.models) return false;
	const packagedAt = snapshotTimestamp(packaged);
	const cacheAt = snapshotTimestamp(cache);
	if (packagedAt === undefined || cacheAt === undefined) return true;
	return cacheAt >= packagedAt;
}

export function loadModelCatalog(): LoadedSapModelCatalog {
	const packaged = loadPackagedSnapshot();
	const cache = loadUserCache();
	const overlay = loadUserOverlay();
	const models = mergeSapModels({
		packaged: packaged.models ?? [],
		cache: shouldUseCachedSnapshot(packaged, cache) ? cache?.models : undefined,
		overlay,
	});
	const foundationModelIds = new Set([
		...DEFAULT_FOUNDATION_MODEL_IDS,
		...(overlay?.foundation?.enabledModelIds ?? []),
	]);
	return { models, foundationModelIds, sources: { packaged, cache, overlay } };
}

function thinkingMapFor(
	reasoning: boolean,
): SapModel["thinkingLevelMap"] | undefined {
	return reasoning ? { ...SAP_EFFORT_BY_LEVEL } : undefined;
}

/** Tenant `scenarioQueryModels` resource shape (structural subset we consume). */
export type TenantModelResource = {
	model: string;
	displayName?: string;
	versions?: Array<{
		name?: string;
		isLatest?: boolean;
		contextLength?: number;
		inputTypes?: string[];
		capabilities?: string[];
		cost?: Array<Record<string, string>>;
		streamingSupported?: boolean;
	}>;
	allowedScenarios?: Array<{ scenarioId?: string }>;
};

function latestVersion(
	resource: TenantModelResource,
): NonNullable<TenantModelResource["versions"]>[number] | undefined {
	const versions = resource.versions ?? [];
	return versions.find((version) => version.isLatest) ?? versions[0];
}

// SAP orchestration accepts Anthropic's `thinking + output_config` and OpenAI's
// `reasoning_effort`. Gemini's reasoning shape via SAP is undocumented, so we
// leave reasoning OFF for gemini-* (mirrors the maintainer snapshot script);
// otherwise pi's Shift+Tab cycle would silently no-op. If/when SAP confirms the
// passthrough, wire it in stream.ts:reasoningParams and drop the gemini gate.
function supportsReasoning(id: string, capabilities: string[]): boolean {
	if (!capabilities.includes("reasoning")) return false;
	if (id.startsWith("gemini-")) return false;
	return true;
}

// Parse the tenant `cost` array (`[{inputCost:"0.00367"},{outputCost:"..."}]`)
// into CU per 1M tokens. Values are quoted CU per 1k tokens, so multiply by
// 1000. The tenant never reports cache costs; the overlay supplies those.
function parseTenantCost(
	cost: Array<Record<string, string>> | undefined,
): SapModel["cost"] {
	const flat: Record<string, string> = {};
	for (const entry of cost ?? []) Object.assign(flat, entry);
	const perMillion = (raw: string | undefined): number => {
		const value = Number.parseFloat(raw ?? "");
		return Number.isFinite(value) ? value * 1000 : 0;
	};
	return {
		input: perMillion(flat.inputCost),
		output: perMillion(flat.outputCost),
		cacheRead: 0,
		cacheWrite: 0,
	};
}

// The tenant exposes context length but NOT the max-output-token cap, so it
// lives here as an explicit table (grounded in models.dev's published limits)
// with per-family fallbacks for ids the tenant adds before this map catches up.
// Used as the default max_tokens when pi passes no budget (stream.ts:445).
const OUTPUT_LIMITS: Record<string, number> = {
	"anthropic--claude-3-haiku": 4096,
	"anthropic--claude-4.6-opus": 128000,
	"anthropic--claude-4.7-opus": 128000,
	"anthropic--claude-4.8-opus": 128000,
	"gpt-4o": 16384,
	"gpt-4o-mini": 16384,
	"gpt-4.1": 32768,
	"gpt-4.1-mini": 32768,
	"gpt-4.1-nano": 32768,
};

export function outputLimitFor(id: string): number {
	const explicit = OUTPUT_LIMITS[id];
	if (explicit) return explicit;
	if (id.startsWith("gpt-5")) return 128000;
	if (id.startsWith("gpt-")) return 32768;
	if (id.startsWith("gemini-")) return 65536;
	if (id.startsWith("qwen")) return 32768;
	if (id.startsWith("anthropic--claude-4")) return 64000;
	if (id.startsWith("anthropic--claude-")) return 8192;
	return 8192;
}

export function adaptTenantModel(resource: TenantModelResource): SapModel {
	const id = resource.model;
	const version = latestVersion(resource);
	const capabilities = version?.capabilities ?? [];
	const input = (version?.inputTypes ?? ["text"]).filter(
		(m): m is "text" | "image" | "pdf" =>
			m === "text" || m === "image" || m === "pdf",
	);
	const reasoning = supportsReasoning(id, capabilities);
	const adapted: SapModel = {
		id,
		name: resource.displayName ?? id,
		reasoning,
		// The tenant does not advertise tool-calling; every chat model in the
		// allowlisted families supports it via orchestration.
		tool_call: true,
		// gpt-* rejects a custom `temperature` on SAP orchestration
		// (stream.ts:modelSupportsTemperature); everything else accepts it.
		temperature: !id.startsWith("gpt-"),
		modalities: {
			input: input.length > 0 ? input : ["text"],
			output: ["text"],
		},
		limit: {
			context: version?.contextLength ?? 0,
			output: outputLimitFor(id),
		},
		cost: parseTenantCost(version?.cost),
	};
	const thinkingMap = thinkingMapFor(reasoning);
	if (thinkingMap) adapted.thinkingLevelMap = thinkingMap;
	return adapted;
}

// A tenant model reaches pi's orchestration catalog only when it is (1) in an
// allowlisted family, (2) not an embedding model, (3) reachable through the
// orchestration scenario, and (4) a text-generation chat model — which drops
// image-generation and speech-only variants that share a family prefix.
export function shouldIncludeTenantModel(resource: TenantModelResource): boolean {
	const id = resource.model;
	if (id.includes("embed")) return false;
	const inFamily =
		id.startsWith("anthropic--claude-") ||
		id.startsWith("gpt-") ||
		id.startsWith("gemini-") ||
		id.startsWith("qwen");
	if (!inFamily) return false;
	const orchestrationCapable = (resource.allowedScenarios ?? []).some(
		(scenario) => scenario.scenarioId === "orchestration",
	);
	if (!orchestrationCapable) return false;
	return (latestVersion(resource)?.capabilities ?? []).includes(
		"text-generation",
	);
}
