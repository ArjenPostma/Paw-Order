import { positiveIntEnv } from "@/config/env";
import { dailyBudget } from "@/http/rate_limit";

/**
 * The global 24h ceiling on generation, in a module of its own rather than
 * beside the other limiters in the router.
 *
 * Two callers need it and they sit on opposite sides of the request: the router
 * mounts it to charge a slot, and case_service hands one back when a generation
 * that was already answered 202 dies without spending anything. Declaring it in
 * the router would make that a cycle - the router imports case_service.
 */
export const generationDailyBudget = dailyBudget({
    dailyMax: () => positiveIntEnv("GENERATION_MAX_PER_DAY", 50),
    refundOnRejection: true,
});
