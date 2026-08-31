import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "../config"
import type { RateLimiter } from "./types"

type RateLimitRecord = {
    count: number
    windowStart: number
}

export function createLocalFixedWindowRateLimiter(): RateLimiter {
    const store = new Map<string, RateLimitRecord>()

    return {
        async check(clientIp: string): Promise<boolean> {
            const now = Date.now()
            const record = store.get(clientIp)

            if (!record || now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
                store.set(clientIp, { count: 1, windowStart: now })
                return true
            }

            if (record.count >= RATE_LIMIT_MAX_REQUESTS) return false

            record.count += 1
            return true
        }
    }
}
