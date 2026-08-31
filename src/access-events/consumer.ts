import { ACCESS_EVENTS_CONSUMER, ACCESS_EVENTS_GROUP, ACCESS_EVENTS_STREAM_KEY } from "../config"
import { connectRedis, disconnectRedis, redisClient } from "../redis"
import type { StreamMessage } from "./types"

async function processAccessEvent(streamMessage: StreamMessage): Promise<void> {
    const { id, message } = streamMessage

    const code = message.code
    const ip = message.ip
    const target = message.target
    const accessedAt = message.accessed_at

    if (!code || !ip || !target || !accessedAt) {
        throw new Error(`Invalid access event: ${id}`)
    }

    console.log("Processed access event", { id, code, ip, target, accessedAt })
}

async function handleMessage(id: string, message: Record<string, string>) {
    try {
        await processAccessEvent({ id, message })
    } catch (error) {
        console.error("Failed to process access event", { id, error })
        return
    }

    try {
        // XACK 返回本次实际确认的消息数量
        // 1：成功从该组的 PEL 中移除
        // 0：该消息不在这个组的 PEL 中（可能已经被 ACK、消息 ID 错误、使用了错误的 group、消息尚未投递给这个 group）
        const acknowledged = await redisClient.xAck(ACCESS_EVENTS_STREAM_KEY, ACCESS_EVENTS_GROUP, id)

        if (acknowledged !== 1) {
            console.warn("Message was not acknowledged", { id })
            return
        }

        console.log("Acknowledged access event", { id })
    } catch (error) {
        console.error("Failed to acknowledge access event", { id, error })
    }
}

// stream key: shortlink:access-events
// group:      access-log-writers
// 起始 ID:    0
// MKSTREAM:   Stream 不存在时自动创建
// 起始 ID 使用 "0" 表示组创建后可以消费 Stream 中已有的全部消息。
// 如果只想消费组创建之后的新消息，可以使用：$
// BUSYGROUP 表示组已经存在，不应视为启动失败。
async function ensureConsumerGroup(): Promise<void> {
    try {
        await redisClient.xGroupCreate(ACCESS_EVENTS_STREAM_KEY, ACCESS_EVENTS_GROUP, "0", { MKSTREAM: true })
        console.log(`Created consumer group: ${ACCESS_EVENTS_GROUP}`)
    } catch (error) {
        if(error instanceof Error && error.message.includes("BUSYGROUP")) {
            return
        }
        throw error
    }
}

// id: ">" 表示读取从未分配给组内任何消费者的新消息
// BLOCK: 5000 表示最多阻塞 5 秒等待新消息，超时后返回 null，然后循环继续
// COUNT: 10 每次最多请求 10 条，但它更接近提示值，不要把它理解为绝对批次协议
async function readNewMessages(): Promise<void> {
    const response = await redisClient.xReadGroup(ACCESS_EVENTS_GROUP, ACCESS_EVENTS_CONSUMER, { key: ACCESS_EVENTS_STREAM_KEY, id: ">" }, { COUNT: 10, BLOCK: 5000 })
    if (response === null) return
    for (const stream of response) {
        for (const message of stream.messages) {
            await handleMessage(message.id, message.message)
        }
    }
}

let isShuttingDown = false

function requestShutdown(): void {
    if (isShuttingDown) return

    isShuttingDown = true
    console.log("Shutting down consumer...")
}

async function run(): Promise<void> {
    await connectRedis()

    try {
        await ensureConsumerGroup()
        console.log(`Consumer ${ACCESS_EVENTS_CONSUMER} is running`)

        while(!isShuttingDown) {
            await readNewMessages()
        }
    } finally {
        await disconnectRedis()
    }
}

process.on("SIGINT", requestShutdown)
process.on("SIGTERM", requestShutdown)

void run().catch((error: unknown) => {
    console.error("Consumer failed:", error)
    process.exitCode = 1
})
