import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type OmpExtensionApi, registerSapProvidersForOmp } from "./omp-adapter.ts";
import { createSapModelCatalogController } from "./src/model-catalog-controller.ts";
import { createSapProviders } from "./src/providers.ts";
import { registerSapModelCommands } from "./src/sap-model-commands.ts";

/**
 * Detect an oh-my-pi (omp) host vs upstream pi (coding-agent).
 *
 * The previous arity check (`pi.registerProvider.length >= 2`) was wrong: BOTH
 * hosts expose an arity-2 `registerProvider` at runtime (coding-agent's is
 * `(providerOrName, config)` with a `Provider`-object overload), so it flagged
 * upstream pi as omp and routed it through the omp adapter. That adapter maps
 * the provider apiKey field to the env-var NAME `AICORE_SERVICE_KEY` (per omp's
 * env-var-name-first resolver), which upstream pi instead treated as a literal
 * key — producing the "Got: AICORE_SERVICE_KEY..." service-key parse error.
 *
 * Detect omp positively instead, by an omp-exclusive extension-API member:
 * `getServiceTiers`/`setServiceTier` exist only on omp's injected API object
 * (upstream pi has neither; it has `registerEntryRenderer`). Anything that is
 * not positively omp falls through to the original upstream Provider-object
 * path, preserving default behavior.
 */
function isOmpHost(pi: ExtensionAPI): boolean {
	const host = pi as unknown as Record<string, unknown>;
	return (
		typeof host.getServiceTiers === "function" &&
		typeof host.setServiceTier === "function"
	);
}

export default function (pi: ExtensionAPI) {
	const catalogController = createSapModelCatalogController();

	if (isOmpHost(pi)) {
		registerSapProvidersForOmp(pi as unknown as OmpExtensionApi, catalogController);
		registerSapModelCommands(pi, catalogController);
		return;
	}

	const providers = createSapProviders(catalogController);

	// coding-agent ships a nested exact pi-ai dependency, so strict resolvers can
	// see two nominally distinct Provider type identities. The runtime contract is
	// the same 0.81 object; isolate the package-boundary cast here.
	const registerNativeProvider = pi.registerProvider.bind(pi) as unknown as (
		provider: Provider,
	) => void;
	registerNativeProvider(providers.orchestration);
	registerNativeProvider(providers.foundation);
	registerSapModelCommands(pi, catalogController);
}
