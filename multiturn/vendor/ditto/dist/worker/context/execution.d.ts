import type { Context, ContextItem, ContextSource, MessageContent } from "../../contracts/common.js";
import type { ContextExecution, ContextPolicy, ContextServices } from "./types.js";
export declare const DEFAULT_CONTEXT_POLICY: ContextPolicy;
export declare function createContextExecution(policy?: Partial<ContextPolicy>, services?: ContextServices): ContextExecution;
export declare function stableContextId(prefix: string, value: unknown): string;
export declare function snapshotItem(item: ContextItem): ContextItem;
export declare function snapshotContext(items: readonly ContextItem[]): Context;
export declare function normalizeSource(source: ContextSource, execution: ContextExecution): ContextItem;
export declare function checkedItem(item: ContextItem, execution: ContextExecution): ContextItem;
export declare function putItem(items: Map<string, ContextItem>, item: ContextItem, policy: ContextPolicy): void;
export declare function estimateTokens(content: MessageContent, execution: ContextExecution): Promise<number>;
export declare function numericMetadata(item: ContextItem, key: string): number;
export declare function booleanMetadata(item: ContextItem, key: string): boolean;
export declare function textContent(content: MessageContent): string;
//# sourceMappingURL=execution.d.ts.map