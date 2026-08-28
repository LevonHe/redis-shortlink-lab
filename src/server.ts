import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { connectRedis, disconnectRedis, redisClient } from "./redis"

const port = Number(process.env.PORT ?? 3003)

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)
    if (req.method === "GET" && requestUrl.pathname === "/health") {
        if (!redisClient.isReady) {
            sendJson(res, 503, { status: "unavailable", redis: "disconnected" })
            return
        }
        try {
            const redisStatus = await redisClient.ping()
            sendJson(res, 200, { status: "ok", redis: redisStatus })
        } catch {
            sendJson(res, 503, { status: "unavailable", redis: "disconnected" })
        }
        return
    }
    sendJson(res, 404, { error: "Not Found" })
}

const server = createServer(handleRequest)

async function start(): Promise<void> {
    await connectRedis()
    server.listen(port, () => {
        console.log(`Server is running on http://localhost:${port}`)
    })
}

start().catch((error: unknown) => {
    console.error("Failed to start application:", error)
    process.exitCode = 1
})

// 关闭时不仅要停止 HTTP 服务，也要断开 Redis
// isShuttingDown 用于防止连续收到多个信号时重复关闭资源
let isShuttingDown = false

async function shutdown(): Promise<void> {
    if (isShuttingDown) return

    isShuttingDown = true
    console.log("Shutting down server...")

    server.close(async (error) => {
        if (error) {
            console.error("Failed to close server:", error)
            process.exitCode = 1
        }

        try {
            await disconnectRedis()
        } catch (redisError) {
            console.error("Failed to disconnect Redis:", redisError)
            process.exitCode = 1
        }
    })
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
