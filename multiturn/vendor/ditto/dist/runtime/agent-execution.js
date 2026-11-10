import { randomUUID } from "node:crypto";
import { graphStep } from "./graph-plan.js";
import { checkpointState, restoreState, stateDigest } from "./checkpoint.js";
import { boolean, fields, record, snapshot } from "./agent-expression.js";
export class AgentPausedError extends Error {
    checkpoint;
    code = "AGENT_PAUSED";
    constructor(checkpoint) {
        super("Agent paused at a saved execution boundary");
        this.checkpoint = checkpoint;
        this.name = "AgentPausedError";
    }
}
export function* agentPlan(program, graphs, project, input) {
    let frame = { definitionHash: "", inputHash: "", iteration: 0,
        step: program.entry, state: program.initial(input), result: null, phase: "ready" };
    while (!program.done(input, frame.state)) {
        if (frame.iteration >= program.maxIterations)
            throw new Error("Loop iteration limit reached");
        const graph = program.graph(frame.step), value = program.input(frame.step, input, frame.state);
        const result = project(graph, value, yield* graphStep(graphs[graph], value));
        frame = { ...frame, state: program.assign(frame.step, input, frame.state, result), result, iteration: frame.iteration + 1 };
        const transition = program.next(frame.step, input, frame.state, result);
        if (transition.end)
            return program.output(input, { ...frame, termination: transition.end });
        frame = { ...frame, step: transition.next };
    }
    return program.output(input, { ...frame, termination: "completed" });
}
export async function* executeAgent(program, graphs, project, definitionHash, input, options) {
    const checkpoint = options.stateCheckpoint, executionId = checkpoint?.id ?? randomUUID();
    if (checkpoint && (!checkpoint.id.trim() || !checkpoint.version.trim()))
        throw new Error("Checkpoint ID and version are required");
    const scope = `agent:${executionId}`, inputHash = checkpoint ? stateDigest(input) : "";
    let frame = checkpoint?.resume ? restoreState(checkpoint.resume, scope, checkpoint.version)
        : { definitionHash, inputHash, iteration: 0, step: program.entry, state: program.initial(input), result: null, phase: "ready" };
    if (frame.definitionHash !== definitionHash || frame.inputHash !== inputHash)
        throw new Error("Agent checkpoint definition or input is incompatible");
    if (!Number.isSafeInteger(frame.iteration) || frame.iteration < 0 || frame.iteration > program.maxIterations
        || !["ready", "running", "boundary", "completed"].includes(frame.phase)
        || (frame.phase === "running" && !frame.graphCheckpoint))
        throw new Error("Invalid Agent checkpoint execution state");
    program.graph(frame.step); // Validate the cursor before any work, including completed resumes.
    const save = async () => {
        if (!checkpoint)
            return undefined;
        const saved = checkpointState(scope, checkpoint.version, frame);
        await checkpoint.save(saved);
        return saved;
    };
    while (frame.phase !== "completed") {
        options.signal?.throwIfAborted();
        if (frame.phase === "ready") {
            if (program.done(input, frame.state)) {
                frame = { ...frame, phase: "completed", termination: "completed" };
                await save();
                break;
            }
            if (frame.iteration >= program.maxIterations)
                throw new Error("Loop iteration limit reached");
        }
        if (frame.phase !== "boundary") {
            const key = program.graph(frame.step), value = program.input(frame.step, input, frame.state);
            const outputs = yield { kind: "graph", graph: graphs[key], input: value, options: checkpoint ? { checkpoint: {
                        version: stateDigest([definitionHash, checkpoint.version]),
                        ...(frame.graphCheckpoint ? { resume: frame.graphCheckpoint } : {}),
                        save: async (graphCheckpoint) => {
                            frame = { ...frame, phase: "running", graphCheckpoint };
                            await save();
                        },
                    } } : {} };
            const result = project(key, value, outputs);
            const { graphCheckpoint: _previous, ...completed } = frame;
            frame = { ...completed, state: program.assign(frame.step, input, frame.state, result), result,
                iteration: frame.iteration + 1, phase: "boundary" };
            await save();
        }
        const decision = await options.onBoundary?.(Object.freeze({ id: `${executionId}:${frame.iteration}`, iteration: frame.iteration,
            step: frame.step, state: snapshot(frame.state), result: snapshot(frame.result) }));
        options.signal?.throwIfAborted();
        if (decision !== undefined) {
            fields(record(decision, "/boundary"), ["update", "pause"], "/boundary");
            if (decision.pause !== undefined)
                boolean(decision.pause, "/boundary/pause");
        }
        if (decision?.pause && !checkpoint)
            throw new Error("Pausing requires an Agent stateCheckpoint");
        if (decision?.update !== undefined)
            frame = { ...frame, state: { ...frame.state, ...record(snapshot(decision.update), "/boundary/update") } };
        const transition = program.next(frame.step, input, frame.state, frame.result);
        frame = transition.end ? { ...frame, phase: "completed", termination: transition.end }
            : { ...frame, phase: "ready", step: transition.next };
        const saved = await save();
        if (decision?.pause)
            throw new AgentPausedError(saved);
    }
    return program.output(input, frame);
}
//# sourceMappingURL=agent-execution.js.map