import { ScenarioApi } from "@sap-ai-sdk/ai-api";

import { readSharedServiceKeyFromStore } from "./auth.ts";
import {
	adaptTenantModel,
	SAP_TENANT_SOURCE,
	type SapModelsSnapshot,
	shouldIncludeTenantModel,
	type TenantModelResource,
} from "./model-catalog.ts";
import { ensureServiceKey, resolveResourceGroup } from "./stream.ts";

const FOUNDATION_MODELS_SCENARIO = "foundation-models";

/**
 * Query the live SAP AI Core tenant for every foundation model it exposes.
 *
 * Authenticates with the primary provider's stored service key (or
 * `AICORE_SERVICE_KEY`), so this only succeeds once the user is logged in. The
 * `scenarioQueryModels` call has no native abort hook, so cancellation is
 * cooperative: the controller checks `signal.aborted` around this call.
 */
export async function queryTenantModels(
	signal?: AbortSignal,
): Promise<TenantModelResource[]> {
	const key = ensureServiceKey(readSharedServiceKeyFromStore());
	process.env.AICORE_SERVICE_KEY = key.raw;
	const resourceGroup = resolveResourceGroup(key) ?? "default";
	const response = await ScenarioApi.scenarioQueryModels(
		FOUNDATION_MODELS_SCENARIO,
		{ "AI-Resource-Group": resourceGroup },
	).execute();
	if (signal?.aborted) return [];
	return (response?.resources ?? []) as TenantModelResource[];
}

/**
 * Build a model snapshot from the live tenant: the source of truth for which
 * models this SAP subscription can actually call. Replaces the old models.dev
 * fetch — the tenant is authoritative for existence, context length, input
 * modalities, reasoning/streaming support, and CU cost.
 */
export async function fetchTenantSapSnapshot(
	signal?: AbortSignal,
): Promise<SapModelsSnapshot> {
	const resources = await queryTenantModels(signal);
	const models = resources
		.filter(shouldIncludeTenantModel)
		.map(adaptTenantModel)
		.sort((a, b) => a.id.localeCompare(b.id));
	return {
		source: SAP_TENANT_SOURCE,
		fetchedAt: new Date().toISOString(),
		count: models.length,
		models,
	};
}
