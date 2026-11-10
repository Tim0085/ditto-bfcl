import { checkpointState, restoreState } from "./checkpoint.js";
export function loop(definition) {
    return Object.freeze({ ...definition });
}
export async function runLoop(definition, initialState, run, signal, checkpoint) {
    const { graph, bind, update, done, maxIterations = 32 } = definition;
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
        throw new Error("maxIterations must be a positive integer");
    }
    const restored = checkpoint?.resume ? restoreState(checkpoint.resume, `loop:${checkpoint.id}`, checkpoint.version) : undefined;
    if (restored && (!Number.isSafeInteger(restored.iteration) || restored.iteration < 0 || restored.iteration > maxIterations))
        throw new Error("Invalid loop checkpoint iteration");
    let state = restored ? restored.state : initialState;
    if (restored?.completed)
        return state;
    for (let iteration = restored?.iteration ?? 0; iteration < maxIterations; iteration++) {
        signal?.throwIfAborted();
        const plan = typeof graph === "function" ? graph(state) : graph;
        const output = await run(plan, bind(state));
        signal?.throwIfAborted();
        state = update(state, output);
        const completed = done(state, output);
        if (checkpoint)
            await checkpoint.save(checkpointState(`loop:${checkpoint.id}`, checkpoint.version, { iteration: iteration + 1, state, completed }));
        if (completed)
            return state;
    }
    throw new Error("Loop iteration limit reached");
}
//# sourceMappingURL=loop.js.map