import { isDeepStrictEqual } from "node:util";
import { ExecutionGraph } from "./graph.js";
import { createDitto } from "./runtime.js";
import { AgentValidationError, pointer } from "./agent-diagnostics.js";
import { stateDigest } from "./checkpoint.js";
import { agentPlan, executeAgent } from "./agent-execution.js";
import { boolean, expression, fail, fields, lookup, name, pathParts, positive, record, snapshot } from "./agent-expression.js";
/** Resolve only the projected fields, once per expression evaluation. */
function lazyScope(entries) {
    const scope = {};
    for (const [key, resolve] of entries)
        Object.defineProperty(scope, key, {
            enumerable: true, configurable: true,
            get() {
                const value = resolve();
                Object.defineProperty(scope, key, { value, enumerable: true });
                return value;
            },
        });
    return scope;
}
/** Compile JSON into the existing DAG scheduler and one outer Loop, without eval or SDK calls. */
export function compileAgent(source) {
    try {
        return compileDefinition(source);
    }
    catch (error) {
        if (error instanceof AgentValidationError) {
            const match = /^\/graphs\/([^/]+)\/nodes\/(\d+)(?:\/|$)/.exec(error.diagnostic.path);
            if (match) {
                const nodeId = lookup(source, ["graphs", match[1].replace(/~1/g, "/").replace(/~0/g, "~"), "nodes", match[2], "id"]);
                if (typeof nodeId === "string")
                    Object.assign(error.diagnostic, { nodeId });
            }
        }
        throw error;
    }
}
/** Pure compiler validation; returns the first actionable error. Worker preflight happens at execution. */
export function validateAgent(source) {
    try {
        compileAgent(source);
        return [];
    }
    catch (error) {
        if (error instanceof AgentValidationError)
            return [error.diagnostic];
        throw error;
    }
}
function compileDefinition(source) {
    const json = snapshot(source), root = record(json, "");
    fields(root, ["$schema", "version", "id", "graphs", "entry", "loop", "config", "deployment"], "");
    if (root.$schema !== undefined && typeof root.$schema !== "string")
        fail("/$schema", "expected a string");
    if (root.version !== 1)
        fail("/version", "expected 1");
    const id = name(root.id, "/id");
    const config = root.config === undefined ? {} : root.config;
    const expr = (value, roots, where, dependencies, references) => {
        const evaluate = expression(value, [...roots, "config"], where, dependencies, references);
        // Scopes are fresh compiler-owned objects; keep lazy properties intact.
        return scope => evaluate(Object.assign(scope, { config }));
    };
    const deployment = parseDeployment(root.deployment === undefined ? {} : root.deployment);
    if (root.entry !== undefined && (root.entry !== "main" || root.loop !== undefined))
        fail("/entry", "entry must be main and cannot accompany loop");
    const definitions = record(root.graphs, "/graphs");
    if (!Object.hasOwn(definitions, "main"))
        fail("/graphs", "a main Graph is required");
    const parsed = new Map();
    for (const [graphId, raw] of Object.entries(definitions)) {
        const graphPath = pointer("/graphs", graphId);
        name(graphId, graphPath);
        const body = record(raw, graphPath);
        fields(body, ["nodes", "output"], graphPath);
        if (!Array.isArray(body.nodes) || !body.nodes.length)
            fail(`${graphPath}/nodes`, "nodes must be a nonempty array");
        const nodes = new Map();
        for (const [index, rawNode] of body.nodes.entries()) {
            const where = `${graphPath}/nodes/${index}`;
            const node = record(rawNode, where), nodeId = name(node.id, `${where}/id`);
            fields(node, ["id", "kind", "type", "graph", "dependsOn", "input", "require"], where);
            if (nodes.has(nodeId))
                fail(`${where}/id`, "duplicate node ID", "DUPLICATE_NODE");
            if (node.kind !== undefined && node.kind !== "node" && node.kind !== "subgraph")
                fail(where, "invalid kind");
            const dependencies = node.dependsOn === undefined ? [] : node.dependsOn;
            if (!Array.isArray(dependencies))
                fail(`${where}/dependsOn`, "dependsOn must be an array");
            const deps = dependencies.map((d, i) => name(d, `${where}/dependsOn/${i}`));
            if (new Set(deps).size !== deps.length)
                fail(`${where}/dependsOn`, "duplicate dependency");
            if (!Object.hasOwn(node, "input"))
                fail(`${where}/input`, "input is required");
            const input = expr(node.input, ["input", "nodes"], `${where}/input`, deps);
            if (node.kind === "subgraph") {
                if (node.type !== undefined || node.require !== undefined)
                    fail(where, "subgraphs accept graph, not type or require");
                const child = name(node.graph, `${where}/graph`);
                if (!Object.hasOwn(definitions, child))
                    fail(`${where}/graph`, `unknown subgraph ${child}`, "UNKNOWN_GRAPH");
                nodes.set(nodeId, { path: where, id: nodeId, child, dependencies: deps, input });
            }
            else {
                if (node.graph !== undefined || typeof node.type !== "string" || !/^[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)+$/.test(node.type))
                    fail(`${where}/type`, "expected a qualified Node type");
                let validate;
                if (node.require !== undefined) {
                    const requirement = record(node.require, `${where}/require`);
                    fields(requirement, ["path", "equals"], `${where}/require`);
                    if (!Object.hasOwn(requirement, "equals"))
                        fail(`${where}/require/equals`, "require.equals is required");
                    const path = pathParts(requirement.path, `${where}/require/path`);
                    validate = output => { if (!isDeepStrictEqual(lookup(output, path), requirement.equals))
                        fail(`${where}/require`, `output requirement failed: ${String(requirement.path)}`); };
                }
                nodes.set(nodeId, { path: where, id: nodeId, type: node.type, dependencies: deps, input, ...(validate ? { validate } : {}) });
            }
        }
        // Accept canvas order; topologically sort once rather than requiring declaration order.
        const sorted = [], remaining = new Map(), children = new Map();
        for (const node of nodes.values()) {
            remaining.set(node.id, node.dependencies.length);
            if (!node.dependencies.length)
                sorted.push(node);
            for (const dependency of node.dependencies) {
                if (!nodes.has(dependency))
                    fail(`${node.path}/dependsOn`, `unknown dependency ${dependency}`, "UNKNOWN_NODE");
                const list = children.get(dependency) ?? [];
                list.push(node.id);
                children.set(dependency, list);
            }
        }
        for (let i = 0; i < sorted.length; i++)
            for (const child of children.get(sorted[i].id) ?? []) {
                const pending = remaining.get(child) - 1;
                remaining.set(child, pending);
                if (!pending)
                    sorted.push(nodes.get(child));
            }
        if (sorted.length !== nodes.size)
            fail(`${graphPath}/nodes`, "cyclic dependency; use Loop for cycles", "CYCLIC_GRAPH");
        const hasOutput = Object.hasOwn(body, "output");
        const outputReferences = new Set(hasOutput ? [] : ["nodes"]);
        const output = hasOutput
            ? expr(body.output, ["input", "nodes"], `${graphPath}/output`, [...nodes.keys()], outputReferences)
            : (scope) => ({ ...scope.nodes });
        parsed.set(graphId, { nodes: sorted, output, outputReferences });
    }
    const graphs = {};
    const sourceMap = {};
    const projections = new Map();
    let totalLeaves = 0;
    for (const graphId of parsed.keys()) {
        const flat = [];
        const sources = {};
        function expand(key, prefix, getInput, inherited, stack) {
            if (stack.includes(key) || stack.length >= 32)
                fail(pointer("/graphs", key), "recursive or excessively nested subgraph", "CYCLIC_GRAPH");
            const body = parsed.get(key), logical = new Map();
            const start = flat.length;
            for (const node of body.nodes) {
                const expandedId = `${prefix}${node.id}`;
                const dependencies = [...new Set([...inherited, ...node.dependencies.flatMap(d => logical.get(d).leaves)])];
                // Capture only declared dependencies; later siblings never enter this scope.
                const upstream = node.dependencies.map(d => [d, logical.get(d).resolve]);
                const bind = (input, outputs) => node.input({
                    input: getInput(input, outputs),
                    nodes: Object.fromEntries(upstream.map(([key, resolve]) => [key, resolve(input, outputs)])),
                });
                let projected;
                if (node.child)
                    projected = expand(node.child, `${expandedId}/`, bind, dependencies, [...stack, key]);
                else {
                    if (++totalLeaves > 20_000)
                        fail(pointer("/graphs", graphId), "expanded node limit exceeded", "LIMIT_EXCEEDED");
                    sources[expandedId] = Object.freeze({ graphId: key, nodeId: node.id, path: node.path, invocationPath: Object.freeze(expandedId.split("/")) });
                    flat.push({ id: expandedId, type: node.type, dependencies, bind,
                        ...(node.validate ? { validate: node.validate } : {}) });
                    projected = { leaves: [expandedId], requiresInput: false, resolve: (_input, outputs) => outputs[expandedId] };
                }
                logical.set(node.id, projected);
            }
            const entries = [...logical], refs = body.outputReferences;
            const requiresInput = refs.has("input") || entries.some(([key, p]) => p.requiresInput && (refs.has("nodes") || refs.has(`nodes.${key}`)));
            // Own leaves already impose completion barriers. Ancestors are needed only to project input-derived outputs.
            const leaves = flat.slice(start).map(node => node.id);
            return { leaves: requiresInput ? [...new Set([...inherited, ...leaves])] : leaves, requiresInput,
                resolve: (input, outputs) => body.output(lazyScope([
                    ["input", () => getInput(input, outputs)],
                    ["nodes", () => lazyScope(entries.map(([key, p]) => [key, () => p.resolve(input, outputs)]))],
                ])),
            };
        }
        const projection = expand(graphId, "", input => input, [], []);
        const plan = ExecutionGraph.fromTasks(graphId, flat.map(node => ({
            id: node.id, node: node.type, dependencies: node.dependencies, bind: node.bind,
            ...(node.validate ? { validateOutput: node.validate } : {}),
        })));
        graphs[graphId] = plan;
        sourceMap[graphId] = Object.freeze(sources);
        projections.set(graphId, projection.resolve);
    }
    validateBindings(graphs, deployment.bindings ?? {});
    const project = (key, input, outputs) => projections.get(key)(input, outputs);
    let program;
    if (root.loop === undefined) {
        program = { entry: "main", maxIterations: 1, initial: () => ({}), done: () => false,
            graph: step => { if (step !== "main")
                fail("/entry", "unknown step"); return "main"; },
            input: (_step, input) => input, assign: (_step, _input, state) => state,
            next: () => ({ end: "completed" }), output: (_input, frame) => frame.result };
    }
    else {
        const loop = record(root.loop, "/loop");
        fields(loop, ["entry", "maxIterations", "state", "while", "steps", "output"], "/loop");
        const entry = name(loop.entry, "/loop/entry"), maxIterations = positive(loop.maxIterations, "/loop/maxIterations");
        if (!Object.hasOwn(loop, "state"))
            fail("/loop", "state is required");
        const initial = expr(loop.state, ["input"], "/loop/state");
        const condition = loop.while === undefined ? undefined : expr(loop.while, ["input", "state"], "/loop/while");
        const definitions = record(loop.steps, "/loop/steps");
        const steps = new Map();
        for (const [key, raw] of Object.entries(definitions)) {
            const where = pointer("/loop/steps", key);
            name(key, where);
            const step = record(raw, where);
            fields(step, ["graph", "input", "assign", "transitions"], where);
            const target = name(step.graph, `${where}/graph`);
            if (!parsed.has(target))
                fail(`${where}/graph`, `unknown Graph ${target}`, "UNKNOWN_GRAPH");
            if (!Object.hasOwn(step, "input"))
                fail(`${where}/input`, "input is required");
            const input = expr(step.input, ["input", "state"], `${where}/input`);
            const updates = record(step.assign === undefined ? {} : step.assign, `${where}/assign`);
            for (const field of Object.keys(updates))
                name(field, pointer(`${where}/assign`, field));
            const assign = expr(updates, ["input", "state", "result"], `${where}/assign`);
            if (!Array.isArray(step.transitions) || !step.transitions.length)
                fail(`${where}/transitions`, "transitions must be nonempty");
            const transitions = step.transitions.map((raw, i) => {
                const transitionPath = `${where}/transitions/${i}`;
                const t = record(raw, transitionPath);
                fields(t, ["when", "next", "end"], transitionPath);
                if (Object.hasOwn(t, "next") === Object.hasOwn(t, "end"))
                    fail(transitionPath, "transition needs exactly one of next and end");
                if (t.when === undefined && i !== step.transitions.length - 1)
                    fail(transitionPath, "default transition must be last");
                const when = t.when === undefined ? undefined : expr(t.when, ["input", "state", "result"], `${transitionPath}/when`);
                if (t.next !== undefined) {
                    const next = name(t.next, `${transitionPath}/next`);
                    if (!Object.hasOwn(definitions, next))
                        fail(`${transitionPath}/next`, `unknown next step ${next}`);
                    return { ...(when ? { when } : {}), next };
                }
                return { ...(when ? { when } : {}), end: name(t.end, `${transitionPath}/end`) };
            });
            if (transitions.at(-1).when)
                fail(`${where}/transitions`, "last transition must be an unconditional default");
            steps.set(key, { graph: target, input, assign, transitions });
        }
        if (!steps.has(entry))
            fail("/loop/entry", "unknown step");
        if (steps.get(entry).graph !== "main")
            fail("/loop/entry", "first step must execute the main Graph");
        const output = loop.output === undefined ? (scope) => scope.state
            : expr(loop.output, ["input", "state", "result", "termination"], "/loop/output");
        const getStep = (key) => {
            const step = steps.get(key);
            if (!step)
                fail("/loop/steps", `unknown step ${key}`);
            return step;
        };
        program = { entry, maxIterations,
            initial: input => record(initial({ input }), "/loop/state"),
            done: (input, state) => condition ? !boolean(condition({ input, state }), "/loop/while") : false,
            graph: key => getStep(key).graph,
            input: (key, input, state) => getStep(key).input({ input, state }),
            assign: (key, input, state, result) => ({ ...state, ...record(getStep(key).assign({ input, state, result }), `/loop/steps/${key}/assign`) }),
            next: (key, input, state, result) => getStep(key).transitions.find(t => !t.when || boolean(t.when({ input, state, result }), `/loop/steps/${key}/transitions`)),
            output: (input, frame) => output({ input, state: frame.state, result: frame.result, termination: { reason: frame.termination } }), };
    }
    const definitionHash = stateDigest(json);
    const plan = { id, maxIterations: program.maxIterations,
        plan: input => agentPlan(program, graphs, project, input) };
    const compiled = Object.freeze({
        definition: json, graphs: Object.freeze(graphs), sourceMap: Object.freeze(sourceMap), plan: Object.freeze(plan),
        async runGraph(key, runtime, input, options = {}) {
            if (!Object.hasOwn(graphs, key))
                fail("/graphs", `unknown Graph ${key}`);
            const workers = options.workers ?? deployment.bindings?.[key] ?? {};
            preflight({ [key]: graphs[key] }, runtime.workers().map(w => ({ id: w.address.workerId, capabilities: w.capabilities })), { [key]: workers });
            const checkpoint = options.checkpoint;
            const outputs = await runtime.run(graphs[key], input, { ...options, workers,
                ...(checkpoint ? { checkpoint: { ...checkpoint, version: stateDigest([definitionHash, workers, checkpoint.version]) } } : {}),
            });
            return project(key, input, outputs);
        },
        async run(runtime, input, options = {}) {
            if ("checkpoint" in options)
                fail("/checkpoint", "use stateCheckpoint for a configured Agent, or runGraph for a Graph checkpoint");
            const workers = options.workers ?? deployment.bindings ?? {};
            preflight(graphs, runtime.workers().map(w => ({ id: w.address.workerId, capabilities: w.capabilities })), workers);
            const { stateCheckpoint: _checkpoint, onBoundary: _boundary, ...runOptions } = options;
            const offset = options.stateCheckpoint?.resume?.state.iteration ?? 0;
            return runtime.loop({ id, maxIterations: program.maxIterations,
                plan: () => executeAgent(program, graphs, project, stateDigest([definitionHash, workers]), input, options),
            }, input, { ...runOptions, workers,
                ...(options.onGraph ? { onGraph: event => options.onGraph({ ...event, iteration: event.iteration + offset }) } : {}),
            });
        },
    });
    return compiled;
}
function parseDeployment(raw) {
    const deployment = record(raw, "/deployment");
    fields(deployment, ["workers", "bindings"], "/deployment");
    const bindings = record(deployment.bindings === undefined ? {} : deployment.bindings, "/deployment/bindings");
    for (const [key, raw] of Object.entries(bindings)) {
        name(key, pointer("/deployment/bindings", key));
        for (const value of Object.values(record(raw, pointer("/deployment/bindings", key))))
            name(value, pointer("/deployment/bindings", key));
    }
    if (deployment.workers !== undefined) {
        if (!Array.isArray(deployment.workers))
            fail("/deployment/workers", "expected an array");
        const ids = new Set();
        for (const [index, raw] of deployment.workers.entries()) {
            const where = `/deployment/workers/${index}`;
            const entry = record(raw, where);
            fields(entry, ["id", "use", "services"], where);
            const id = name(entry.id, `${where}/id`);
            name(entry.use, `${where}/use`);
            if (entry.services !== undefined)
                name(entry.services, `${where}/services`);
            if (ids.has(id))
                fail(`${where}/id`, "duplicate Worker ID");
            ids.add(id);
        }
    }
    return deployment;
}
function validateBindings(graphs, bindings) {
    for (const [key, mapping] of Object.entries(bindings)) {
        const path = pointer("/deployment/bindings", key);
        if (!Object.hasOwn(graphs, key))
            fail(path, `unknown Graph ${key}`, "UNKNOWN_GRAPH");
        const nodes = new Set(graphs[key].tasks.map(t => t.id));
        for (const nodeId of Object.keys(mapping))
            if (!nodes.has(nodeId))
                fail(pointer(path, nodeId), `unknown node ${key}/${nodeId}`, "UNKNOWN_NODE");
    }
}
function preflight(graphs, workers, bindings) {
    validateBindings(graphs, bindings);
    const providers = new Map();
    for (const worker of workers)
        for (const node of worker.capabilities) {
            let ids = providers.get(node);
            if (!ids) {
                ids = new Set();
                providers.set(node, ids);
            }
            ids.add(worker.id);
        }
    for (const [key, graph] of Object.entries(graphs)) {
        const mapping = bindings[key] ?? {};
        for (const task of graph.tasks) {
            const selected = mapping[task.id];
            const available = providers.get(task.node);
            if (!available || (selected !== undefined && !available.has(selected)))
                fail(pointer(pointer("/deployment/bindings", key), task.id), `no registered Worker exposes ${task.node}${selected === undefined ? "" : ` at ${selected}`}`, "WORKER_BINDING");
        }
    }
}
/** Register trusted definitions separately from JSON structure. Owns and closes its Runtime. */
export async function createAgent(source, options) {
    const compiled = compileAgent(source);
    const { workers: registry, serviceProfiles = {}, ...runtimeOptions } = options;
    const deployment = compiled.definition.deployment ?? {};
    const bindings = deployment.bindings ?? {};
    const requested = deployment.workers ?? Object.keys(registry).map(id => ({ id, use: id }));
    const registrations = requested.map(raw => {
        const entry = record(raw, "/deployment/workers");
        const id = name(entry.id, "/deployment/workers"), use = name(entry.use, "/deployment/workers");
        if (!Object.hasOwn(registry, use))
            fail("/deployment/workers", "unknown host Worker definition");
        const registered = registry[use];
        const descriptor = "definition" in registered ? registered : { definition: registered };
        const profile = entry.services === undefined ? undefined : name(entry.services, "/deployment/workers");
        if (profile && !Object.hasOwn(serviceProfiles, profile))
            fail("/deployment/workers", "unknown host services profile");
        return { id, ...descriptor, ...(profile ? { services: serviceProfiles[profile] } : {}) };
    });
    const workerBindings = bindings;
    preflight(compiled.graphs, registrations.map(w => ({ id: w.id, capabilities: w.definition.capabilities })), workerBindings);
    const runtime = createDitto(runtimeOptions);
    try {
        for (const worker of registrations)
            runtime.register(worker.definition, { id: worker.id,
                ...(worker.services ? { services: worker.services } : {}) });
    }
    catch (error) {
        await runtime.close().catch(() => { });
        throw error;
    }
    return Object.freeze({ compiled, runtime,
        run: (input, runOptions = {}) => compiled.run(runtime, input, { ...runOptions, workers: workerBindings }),
        close: () => runtime.close(), });
}
//# sourceMappingURL=agent.js.map