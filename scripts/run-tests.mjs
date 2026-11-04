import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = new URL("./", import.meta.url);
const files = readdirSync(directory)
	.filter((name) => name.startsWith("test-") && name.endsWith(".mjs") &&
		name !== "test-compat.mjs" && name !== "test-startup.mjs")
	.sort()
	.map((name) => fileURLToPath(new URL(name, directory)));
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", ...process.argv.slice(2), ...files], {
	stdio: "inherit",
	env: { ...process.env, PI_SAP_AICORE_DEBUG_PAYLOAD: "" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
