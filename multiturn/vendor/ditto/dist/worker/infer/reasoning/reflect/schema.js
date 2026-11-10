import { common, object, check, message, steps, list, text, number } from "../../validation.js";
export function validateReflect(input) {
    const v = common(input);
    if (v.messages !== undefined) {
        list(v.messages, "messages");
        v.messages.forEach(message);
    }
    const t = object(v.target, "target");
    check(t.result !== undefined || t.trajectory !== undefined || Object.hasOwn(t, "artifact"), "target requires result, trajectory or artifact");
    if (t.result !== undefined)
        message(t.result);
    if (t.trajectory !== undefined)
        steps(t.trajectory);
    check(["critique", "verify", "revise"].includes(String(v.mode)), "Invalid reflection mode");
    if (v.criteria !== undefined) {
        list(v.criteria, "criteria");
        const ids = new Set();
        for (const raw of v.criteria) {
            const c = object(raw);
            text(c.id, "criterion.id");
            text(c.description, "criterion.description");
            check(!ids.has(c.id), "Duplicate criterion ID");
            ids.add(c.id);
            if (c.weight !== undefined)
                number(c.weight, "weight", 0);
        }
    }
}
export function validateReflectOutput(v, mode) {
    const a = object(v.assessment, "assessment");
    text(a.summary, "assessment.summary", true);
    if (a.passed !== undefined)
        check(typeof a.passed === "boolean", "assessment.passed must be boolean");
    if (mode === "verify")
        check(typeof a.passed === "boolean", "verify requires assessment.passed");
    list(v.issues, "issues");
    for (const raw of v.issues) {
        const i = object(raw);
        check(["info", "warning", "error"].includes(String(i.severity)), "Invalid issue severity");
        text(i.description, "issue.description");
        if (i.suggestedFix !== undefined)
            text(i.suggestedFix, "suggestedFix", true);
    }
    if (v.revisedResult !== undefined)
        message(v.revisedResult);
    if (mode === "revise")
        message(v.revisedResult);
}
//# sourceMappingURL=schema.js.map