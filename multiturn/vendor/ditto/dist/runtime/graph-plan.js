/** Yield a typed Graph to its owning Loop; returned values resume the plan. */
export function* graphStep(plan, input, options = {}) {
    const output = yield Object.freeze({
        kind: "graph",
        graph: plan,
        input,
        options: Object.freeze({ ...options }),
    });
    return output;
}
export async function runGraphPlan(definition, input, run, signal, onGraph) {
    const maximum = definition.maxIterations ?? 32;
    if (!definition.id.trim() || !Number.isSafeInteger(maximum) || maximum < 1)
        throw new Error("Loop ID and positive maxIterations are required");
    signal?.throwIfAborted();
    const iterator = definition.plan(input);
    let step;
    try {
        step = await iterator.next();
        for (let iteration = 0; !step.done; iteration++) {
            signal?.throwIfAborted();
            if (iteration >= maximum)
                throw new Error("Loop iteration limit reached");
            const call = step.value;
            if (!call || call.kind !== "graph" || !call.graph?.tasks)
                throw new Error("Loop plan must yield graphStep invocations");
            const event = {
                loopId: definition.id,
                iteration,
                graphId: call.graph.id,
                nodes: call.graph.tasks.map((t) => t.id),
            };
            onGraph?.({ ...event, status: "started" });
            let output;
            try {
                output = await run(call.graph, call.input, call.options);
            }
            catch (error) {
                onGraph?.({ ...event, status: "failed" });
                signal?.throwIfAborted(); // Whole-Loop cancellation cannot be swallowed by a plan.
                step = await iterator.throw(error);
                continue;
            }
            signal?.throwIfAborted();
            onGraph?.({ ...event, status: "completed" });
            step = await iterator.next(output);
        }
        signal?.throwIfAborted();
        return step.value;
    }
    finally {
        // Drain cleanup; never execute a yielded Graph after termination.
        await iterator.return(undefined);
    }
}
//# sourceMappingURL=graph-plan.js.map