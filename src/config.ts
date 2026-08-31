export const RATE_LIMIT_MAX_REQUESTS = 5
export const RATE_LIMIT_WINDOW_MS = 1000

export const RATE_LIMIT_WINDOW_SECONDS = 1

export const SHORT_URL_TTL_SECONDS = 24 * 60 * 60

export const RANKING_KEY = "shortlink:ranking"

// 请求体限制为 10kb，避免客户端无限发送数据占用内存
export const MAX_BODY_BYTES = 10 * 1024
export const RANKING_LIMIT = 10

export const ACCESS_EVENTS_STREAM_KEY = "shortlink:access-events"
export const ACCESS_EVENTS_MAX_LENGTH = 10_000 // 避免实验运行久了之后 Stream 无限增长
