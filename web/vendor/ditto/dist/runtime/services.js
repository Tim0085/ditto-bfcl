/**
 * Explicit host config wins; otherwise load ./ditto.yaml with process.env once
 * per Runtime. A missing default file uses env + built-ins; invalid files fail.
 * Importing the package does not read files. .env loading stays with the application.
 * Host providers/sandbox options override the corresponding config-derived services.
 */
import { ProviderRegistry, createHttpProvider } from "../worker/infer/providers/index.js";
import { Sandbox } from "./sandbox/index.js";
import { loadRuntimeConfig, loadRuntimeConfigFile } from "./config.js";
function defaultConfig() {
    try {
        return loadRuntimeConfigFile();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return loadRuntimeConfig();
    }
}
export function createRuntimeServices(options) {
    const config = options.config ?? defaultConfig();
    const sandbox = new Sandbox(config.workspace, options.sandbox ?? config.sandbox, options.sandboxExecutor);
    const providers = options.providers ?? new ProviderRegistry();
    if (!options.providers) {
        for (const [name, provider] of Object.entries(config.providers)) {
            providers.register(name, createHttpProvider({ ...provider, sandbox, timeoutMs: config.timeoutMs }));
        }
    }
    return Object.freeze({ config, sandbox, providers });
}
//# sourceMappingURL=services.js.map