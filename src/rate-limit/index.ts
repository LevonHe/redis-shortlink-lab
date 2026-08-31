import { createLocalFixedWindowRateLimiter } from "./local-fixed-window";
import { createLuaFixedWindowRateLimiter } from "./lua-fixed-window";
import { createRedisFixedWindowRateLimiter } from "./redis-fixed-window";
import { RateLimiter } from "./types";

export function createRateLimiter(strategy: string): RateLimiter {
    switch (strategy) {
        case "local":
            return createLocalFixedWindowRateLimiter()
        case "redis":
            return createRedisFixedWindowRateLimiter()
        case "lua":
            return createLuaFixedWindowRateLimiter()
        default:
            throw new Error(`Unsupported rate limit strategy: ${strategy}`)
    }
}
