// omp compatibility adapter.
//
// This extension was written against upstream pi 0.81's `pi.registerProvider(providerObject)`
// single-argument contract, where a `Provider` object carries `getModels()`,
// `refreshModels()`, `stream()`/`streamSimple()`, and an `auth` block. oh-my-pi
// (omp) is a fork whose extension host exposes a different, two-argument shape:
//
//     pi.registerProvider(name: string, config: ProviderConfig): void
//
// where `config` is `{ baseUrl, apiKey, api, models[], streamSimple, oauth, ... }`.
// Passing the upstream `Provider` object straight through makes omp read
// `config.streamSimple` off `undefined` and crash.
//
// This module translates the upstream `Provider` objects produced by
// `createSapProviders(...)` into omp's `(name, ProviderConfig)` registration,
// bridging three gaps:
//
//   1. Registration shape   — Provider object -> (name, ProviderConfig).
//   2. Model list           — Provider.getModels() -> ProviderConfig.models[]
//                             (a static array; refreshed via re-register).
//   3. Auth                 — Provider.auth.{apiKey,oauth} -> ProviderConfig.oauth,
//                             returning the service-key JSON as a plain string so
//                             omp feeds it back through streamSimple's options.apiKey,
//                             which the existing stream code reads via ensureServiceKey.
//
// Kept in a separate file so the upstream `src/` tree stays untouched and
// mergeable against future pi-sap-aicore releases.

import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { parseAndValidateServiceKey } from "./src/auth.ts";
import type { SapModelCatalogController } from "./src/model-catalog-controller.ts";
import { createSapProviders, FOUNDATION_PROVIDER_ID, SAP_PROVIDER_ID } from "./src/providers.ts";

const AICORE_SERVICE_KEY_ENV = "AICORE_SERVICE_KEY";

/**
 * Minimal structural view of omp's ExtensionAPI.registerProvider. We keep this
 * local (rather than importing omp's types, which are not on this extension's
 * dependency path) and cast the injected `pi` object to it at the call site.
 */
interface OmpProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	baseUrl?: string;
	reasoning: boolean;
	thinking?: unknown;
	input: ("text" | "image")[];
	supportsTools?: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

interface OmpOAuthLoginCallbacks {
	onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) => Promise<string>;
}

interface OmpProviderConfig {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => unknown;
	models?: OmpProviderModelConfig[];
	oauth?: {
		name: string;
		login(callbacks: OmpOAuthLoginCallbacks): Promise<string>;
		getApiKey?(credentials: unknown): string;
	};
}

export interface OmpExtensionApi {
	registerProvider(name: string, config: OmpProviderConfig): void;
}

/**
 * The subset of an upstream pi `Provider` object this adapter consumes. Declared
 * structurally to avoid coupling to the exact upstream `Provider<Api>` generic.
 */
interface UpstreamProvider {
	id: string;
	name: string;
	baseUrl?: string;
	getModels(): Model<Api>[];
	streamSimple: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => unknown;
}

/**
 * Read the service-key JSON that omp made available for this request. omp resolves
 * `oauth.getApiKey(...)` (or a config `apiKey`) into `options.apiKey` before calling
 * `streamSimple`. Fall back to the environment for parity with the upstream path.
 */
function resolveServiceKey(options: SimpleStreamOptions | undefined): string | undefined {
	const fromOptions = typeof options?.apiKey === "string" ? options.apiKey : undefined;
	return fromOptions ?? process.env[AICORE_SERVICE_KEY_ENV];
}

/**
 * Build a streamSimple that re-hydrates the rich model from the catalog before
 * delegating. omp's `ProviderModelConfig` has no slot for this extension's custom
 * `thinkingLevelMap`, so omp strips it when it reconstructs `Model` objects from
 * the registered config. The SAP stream code reads `model.thinkingLevelMap`, so we
 * look the full model up by id from the live catalog and merge it back in.
 */
function wrapStream(
	provider: UpstreamProvider,
): NonNullable<OmpProviderConfig["streamSimple"]> {
	return (model, context, options) => {
		const rich = provider.getModels().find((m) => m.id === model.id);
		const effectiveModel = rich ? { ...model, ...rich } : model;
		// Mirror the resolved service key into the env the SAP SDK reads, matching
		// the upstream provider's stream path (see stream.ts ensureServiceKey).
		const serviceKey = resolveServiceKey(options);
		if (serviceKey) process.env[AICORE_SERVICE_KEY_ENV] = serviceKey;
		return provider.streamSimple(effectiveModel, context, options);
	};
}

function toOmpModels(provider: UpstreamProvider): OmpProviderModelConfig[] {
	return provider.getModels().map((model) => ({
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	}));
}

/**
 * omp OAuth provider that accepts the SAP BTP service-key JSON as a single-line
 * secret and stores it verbatim (returned as a plain string). On each request
 * omp hands the stored string back through `streamSimple`'s `options.apiKey`.
 */
function serviceKeyOAuth(providerLabel: string): NonNullable<OmpProviderConfig["oauth"]> {
	return {
		name: `${providerLabel} service key`,
		async login(callbacks) {
			const raw = (
				await callbacks.onPrompt({
					message: `Paste your SAP BTP service-key JSON (single line) for ${providerLabel}`,
					placeholder: '{ "clientid": "…", "clientsecret": "…", … }',
				})
			).trim();
			parseAndValidateServiceKey(raw);
			return raw;
		},
		getApiKey(credentials) {
			return typeof credentials === "string" ? credentials : "";
		},
	};
}

function registerOne(
	pi: OmpExtensionApi,
	provider: UpstreamProvider,
	options: { withLogin: boolean },
): void {
	// omp requires a provider-level `api` when a streamSimple handler is set. The
	// SAP models each carry their own custom Api id (orchestration vs foundation);
	// reuse the first model's api as the provider default so registration passes.
	const models = toOmpModels(provider);
	const providerApi = models[0]?.api;
	const config: OmpProviderConfig = {
		baseUrl: provider.baseUrl,
		api: providerApi,
		models,
		streamSimple: wrapStream(provider),
	};
	// omp gates on getApiKey(model) BEFORE calling streamSimple, and its resolver
	// does not know about AICORE_SERVICE_KEY. A provider-level `apiKey` is resolved
	// env-var-name-first (per omp models.md), so naming the env var here lets a
	// shell-exported service key satisfy auth without an interactive /login. The
	// resolved value flows into streamSimple's options.apiKey, which the SAP stream
	// code reads via ensureServiceKey. oauth still provides the /login path.
	config.apiKey = AICORE_SERVICE_KEY_ENV;
	if (options.withLogin) config.oauth = serviceKeyOAuth(provider.name);
	pi.registerProvider(provider.id, config);
}

/**
 * Register the SAP AI Core orchestration + foundation providers with omp.
 *
 * @param pi         The omp ExtensionAPI (structurally typed here).
 * @param controller Shared model-catalog controller (also drives model list).
 */
export function registerSapProvidersForOmp(
	pi: OmpExtensionApi,
	controller: SapModelCatalogController,
): void {
	const providers = createSapProviders(controller);
	// Orchestration owns the /login credential; foundation reads the shared key,
	// so only orchestration exposes an interactive login to avoid a second prompt.
	// omp requires every provider that defines models to declare its own auth
	// (`apiKey` or `oauth`); unlike upstream pi, foundation cannot silently borrow
	// orchestration's stored credential at registration time. Give both their own
	// service-key login. They accept the same BTP JSON, so a user logs in to each
	// once via /login (or sets AICORE_SERVICE_KEY to cover both without prompting).
	registerOne(pi, providers.orchestration as unknown as UpstreamProvider, {
		withLogin: true,
	});
	registerOne(pi, providers.foundation as unknown as UpstreamProvider, {
		withLogin: true,
	});
	void SAP_PROVIDER_ID;
	void FOUNDATION_PROVIDER_ID;
}
