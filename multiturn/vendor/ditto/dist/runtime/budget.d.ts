import type { ModelProvider } from "../worker/infer/providers/types.js";
import type { SampleInput } from "../worker/infer/reasoning/sample/types.js";
import type { Usage } from "../worker/infer/types.js";
export interface BudgetScope {
    readonly runId: string;
    readonly branchId?: string;
    readonly label?: string;
}
export interface BudgetRecord {
    readonly id: number;
    readonly scope: BudgetScope;
    readonly reserved: number;
    readonly charged: number;
    readonly status: "known" | "unknown" | "exceeded";
    readonly usage?: Usage;
}
export declare class BudgetExceededError extends Error {
}
/** Reservations are synchronous and atomic in one JS authority. Share this object across providers. */
export declare class TokenBudget {
    #private;
    readonly limit: number;
    constructor(limit: number);
    get spent(): number;
    get remaining(): number;
    get records(): readonly BudgetRecord[];
    reserve(tokens: number, scope: BudgetScope): (usage?: Usage) => void;
}
export interface BudgetedProviderOptions {
    /** Must bound input + maximum output, including protocol overhead/reasoning tokens.
     * Unknown provider bounds cannot provide a strict physical token guarantee.
     */
    readonly reserveTokens: (input: SampleInput) => number;
    readonly scope: BudgetScope | ((input: SampleInput) => BudgetScope);
    readonly requireUsage?: boolean;
}
/** Failed/cancelled requests without usage retain their reservation as an unknown charge.
 * Streaming intentionally falls back to invoke so accounting has one terminal settlement.
 */
export declare function budgetedProvider(provider: ModelProvider, budget: TokenBudget, options: BudgetedProviderOptions): ModelProvider;
//# sourceMappingURL=budget.d.ts.map