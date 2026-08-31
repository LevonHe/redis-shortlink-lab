import { randomUUID } from "node:crypto"
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_MS } from "../config"
import { redisClient } from "../redis"
import type { RateLimiter } from "./types"

const SLIDING_WINDOW_SCRIPT = `
-- 使用 Redis 时间: 使用 Redis 服务器时间，而不是 Node.js 的 Date.now()，可以避免多个应用实例时钟不一致
local time = redis.call("TIME")
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
-- 删除窗口外请求: 窗口为 1000 ms 时，只保留 (now_ms - 1000, now_ms]，恰好落在左边界的记录会被删除
local window_start = now_ms - tonumber(ARGV[2])

redis.call(
  "ZREMRANGEBYSCORE",
  KEYS[1],
  "-inf",
  window_start
)

local current = redis.call("ZCARD", KEYS[1])

-- 判断请求数: 被拒绝的请求不会写入 ZSet。因此 ZSet 最多大致保存 limit 条有效请求，而固定窗口版本会继续 INCR 被拒绝的请求
if current >= tonumber(ARGV[1]) then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return {0, current, now_ms}
end

-- 添加本次请求
redis.call(
  "ZADD",
  KEYS[1],
  now_ms,
  ARGV[3]
)

redis.call("PEXPIRE", KEYS[1], ARGV[2])

return {1, current + 1, now_ms}
`

export function createLuaSlidingWindowRateLimiter(): RateLimiter {
    return {
        async check(clientIp: string): Promise<boolean> {
            const key = `shortlink:rate:sliding:${clientIp}`
            const requestId = randomUUID()

            const result = await redisClient.eval(
                SLIDING_WINDOW_SCRIPT,
                {
                    keys: [key],
                    arguments: [
                        String(RATE_LIMIT_MAX_REQUESTS),
                        String(RATE_LIMIT_WINDOW_MS),
                        requestId
                    ]
                }
            )

            if (!Array.isArray(result) || typeof result[0] !== "number") {
                throw new Error("Unexpected sliding window script result")
            }

            return result[0] === 1
        }
    }
}
