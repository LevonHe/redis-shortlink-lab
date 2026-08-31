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

export const ACCESS_EVENTS_GROUP = "access-log-writers"
export const ACCESS_EVENTS_CONSUMER = process.env.ACCESS_EVENTS_CONSUMER ?? "consumer-1"

// Pending 消息至少空闲 10 秒才允许接管
export const ACCESS_EVENTS_CLAIM_MIN_IDLE_MS = 10_000
// 每次最多尝试接管 10 条
export const ACCESS_EVENTS_CLAIM_BATCH_SIZE = 10

// 最多处理 3 次，首次投递 + 两次重试
export const ACCESS_EVENTS_MAX_DELIVERIES = 3
export const ACCESS_EVENTS_DEAD_LETTER_STREAM_KEY = "shortlink:access-events:dead-letter"

export const ACCESS_EVENTS_DB_PATH = process.env.ACCESS_EVENTS_DB_PATH ?? "data/access-events.db"
