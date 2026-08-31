import { ACCESS_EVENTS_STREAM_KEY, ACCESS_EVENTS_MAX_LENGTH } from "../config"
import { redisClient } from "../redis"
import type { AccessEvent } from "./types"

export async function publishAccessEvent(event: AccessEvent): Promise<string> {
    return redisClient.xAdd(
        ACCESS_EVENTS_STREAM_KEY,
        "*",
        {
            code: event.code,
            ip: event.clientIp,
            target: event.target,
            accessed_at: event.accessedAt
        },
        {
            TRIM: {
                strategy: "MAXLEN",
                strategyModifier: "~",
                threshold: ACCESS_EVENTS_MAX_LENGTH
            }
        }
    )
}
