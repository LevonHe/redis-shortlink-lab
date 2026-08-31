import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS } from "../config"
import { redisClient } from "../redis"
import type { RateLimiter } from "./types"

const RATE_LIMIT_SCRIPT = `
local current = redis.call("INCR", KEYS[1])

if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end

if current > tonumber(ARGV[1]) then
  return 0
end

return 1
`

export function createLuaFixedWindowRateLimiter(): RateLimiter {
    return {
        async check(clientIp: string): Promise<boolean> {
            const key = `shortlink:rate:${clientIp}`
        
            const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
                keys: [key],
                arguments: [String(RATE_LIMIT_MAX_REQUESTS), String(RATE_LIMIT_WINDOW_SECONDS)]
            })
        
            return result === 1
        }
    }
}
