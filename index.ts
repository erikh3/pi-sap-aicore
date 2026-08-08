import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type OmpExtensionApi, registerSapProvidersForOmp } from "./omp-adapter.ts";
import { createSapModelCatalogController } from "./src/model-catalog-controller.ts";
import { createSapProviders } from "./src/providers.ts";
import { registerSapModelCommands } from "./src/sap-model-commands.ts";

/**
 * omp's `registerProvider(name, config)` takes two arguments; upstream pi 0.81's
 * `registerProvider(providerObject)` takes one. Detect the host by arity so a
 * single build works on both. `Function.length` excludes optional/rest params,
 * so omp's `(name, config, sourceId?)` reports 2 and pi's `(provider)` reports 1.
 */
function isOmpHost(pi: ExtensionAPI): boolean {
	return typeof pi.registerProvider === "function" && pi.registerProvider.length >= 2;
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
