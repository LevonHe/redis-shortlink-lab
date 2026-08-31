import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from "../config"
import { redisClient } from "../redis"
import type { RateLimiter } from "./types"

export function createRedisFixedWindowRateLimiter(): RateLimiter {
    return {
        async check(clientIp: string): Promise<boolean> {
            const key = `shortlink:rate:${clientIp}`
            const count = await redisClient.incr(key)
        
            if (count === 1) {
                await redisClient.expire(key , RATE_LIMIT_WINDOW_SECONDS)
            }
        
            return count <= RATE_LIMIT_MAX_REQUESTS
        }
    }
}
