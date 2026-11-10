import { validateSample, validateSampleOutput } from "../reasoning/sample/schema.js";
import { abortable, InferError, number } from "../validation.js";
import { openai } from "./openai.js";
import { anthropic } from "./anthropic.js";
import { gemini } from "./gemini.js";
import { readSse } from "./sse.js";
const protocols = { "openai-compatible": openai, anthropic, gemini };
function endpoint(value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new InferError("INVALID_INPUT", "Invalid provider URL");
    return url.href.replace(/\/$/, "");
}
/** One transport and public interface, with three wire protocols and no vendor SDKs. */
export function createHttpProvider(options) {
    const base = endpoint(options.baseUrl);
    const origin = new URL(base).origin;
    if (!Object.hasOwn(protocols, options.kind))
        throw new InferError("INVALID_INPUT", "Unsupported provider kind");
    const protocol = protocols[options.kind];
    const timeoutMs = options.timeoutMs ?? 30_000;
    number(timeoutMs, "timeoutMs", 1, 2 ** 31 - 1, true);
    if (options.idleTimeoutMs !== undefined)
        number(options.idleTimeoutMs, "idleTimeoutMs", 1, 2 ** 31 - 1, true);
    const idleTimeoutMs = options.idleTimeoutMs;
    const signalFor = (signal) => AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    async function request(input, signal, streaming) {
        validateSample(input);
        if (input.model.endpoint !== undefined && endpoint(input.model.endpoint) !== base)
            throw new InferError("ENDPOINT_MISMATCH", "model.endpoint must match the configured provider URL");
        options.sandbox.assert("network", origin);
        const configured = { ...input, model: { ...input.model, providerOptions: { ...options.providerOptions, ...input.model.providerOptions } } };
        const body = protocol.body(configured, streaming);
        if (options.kind === "openai-compatible" && options.maxTokensField === "max_tokens" && input.generation?.maxTokens !== undefined) {
            body.max_tokens = input.generation.maxTokens;
            delete body.max_completion_tokens;
        }
        const response = await abortable(() => (options.fetch ?? globalThis.fetch)(base + protocol.path(input.model.model, streaming), {
            method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", ...protocol.headers(options.apiKey) },
            body: JSON.stringify(body),
        }), signal);
        if (!response.ok) {
            await response.body?.cancel();
            throw new InferError("PROVIDER_HTTP_ERROR", `Model provider returned HTTP ${response.status}`);
        }
        return response;
    }
    return {
        async invoke(input, options) {
            const signal = signalFor(options.signal);
            const response = await request(input, signal, false);
            let raw;
            try {
                raw = await abortable(() => response.json(), signal);
            }
            catch {
                signal.throwIfAborted();
                throw new InferError("INVALID_MODEL_OUTPUT", "Provider returned invalid JSON");
            }
            const output = protocol.parse(raw);
            validateSampleOutput(output);
            return output;
        },
        async *stream(input, options) {
            const idle = new AbortController();
            const signal = AbortSignal.any([signalFor(options.signal), idle.signal]);
            let timer;
            const refresh = () => {
                if (idleTimeoutMs === undefined)
                    return;
                clearTimeout(timer);
                timer = setTimeout(() => idle.abort(new InferError("PROVIDER_IDLE_TIMEOUT", "Provider stream made no generation progress")), idleTimeoutMs);
                timer.unref();
            };
            refresh();
            try {
                const response = await request(input, signal, true);
                for await (const event of protocol.stream(readSse(response, signal))) {
                    if (event.type === "result" || event.delta.length)
                        refresh();
                    if (event.type === "result")
                        validateSampleOutput(event.output);
                    yield event;
                }
            }
            catch (error) {
                if (error instanceof InferError && error.code === "INVALID_INPUT")
                    throw new InferError("INVALID_MODEL_OUTPUT", error.message);
                throw error;
            }
            finally {
                clearTimeout(timer);
            }
        },
    };
}
//# sourceMappingURL=http.js.map