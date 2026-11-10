import { STAGES, graphId, type Stage } from "./graphs.ts";
export type Group = "Monolithic" | "Uniform" | "Targeted";
export type Assignment = { worker: string } | { context: string; interaction: string; memory: string };
export function createBindings(group: Group, assignment: Assignment): Readonly<Record<string, Readonly<Record<string,string>>>> {
  if (!["Monolithic","Uniform","Targeted"].includes(group)) throw new Error("未知部署组");
  const table: Record<string,Record<string,string>> = {};
  for (const [stage,steps] of Object.entries(STAGES)) {
    const row: Record<string,string> = {};
    for (const step of steps) {
      let id: string | undefined;
      if (group === "Monolithic") id = "worker" in assignment ? assignment.worker : undefined;
      else if (!("worker" in assignment)) {
        if (step.node.startsWith("CONTEXT.")) id = assignment.context;
        if (step.node === "INTERACTION.ACT.TOOL") id = assignment.interaction;
        if (step.node.startsWith("MEMORY.")) id = assignment.memory;
        if (step.node === "INFER.REASONING.SAMPLE" || step.node === "INTERACTION.OBSERVE") continue;
      }
      if (typeof id !== "string" || !id.trim()) throw new Error("缺少固定步骤所属份");
      row[step.id] = id;
    }
    table[graphId(stage as Stage)] = Object.freeze(row);
  }
  return Object.freeze(table);
}
export function cleanupOwners(bindings: Readonly<Record<string,Readonly<Record<string,string>>>>): string[] {
  const ids = [bindings[graphId("open")]?.load,bindings[graphId("open")]?.init,bindings[graphId("save")]?.save];
  if (ids.some(id=>!id)) throw new Error("清理需要 Context、ACT.TOOL 和 Memory 的固定绑定");
  return [...new Set(ids)];
}
