import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { connectRedis, disconnectRedis, redisClient } from "./redis"

const port = Number(process.env.PORT ?? 3003)

// crypto.randomBytes() 生成随机短码
// 请求体限制为 10kb，避免客户端无限发送数据占用内存
// 最多尝试 5 次短码，防止碰撞时无限循环
const SHORT_CODE_LENGTH = 6
const SHORT_URL_TTL_SECONDS = 24 * 60 * 60
const MAX_BODY_BYTES = 10 * 1024
const MAX_CODE_ATTEMPTS = 5
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// Node.js 原生 HTTP 不会自动解析 JSON，请求体通过多个数据块达到，需要收集这些数据块
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let totalBytes = 0

    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        totalBytes += buffer.length

        if (totalBytes > MAX_BODY_BYTES) {
            throw new Error("REQUEST_BODY_TOO_LARGE")
        }

        chunks.push(buffer)
    }

    const text = Buffer.concat(chunks).toString("utf-8")

    if (text.length === 0) {
        throw new Error("EMPTY_REQUEST_BODY")
    }

    return JSON.parse(text)
}

function parseTargetUrl(body: unknown): string | null {
    if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") return null
    try {
        const url = new URL(body.url)
        if (url.protocol !== "http:" && url.protocol !== "https:") return null
        return url.toString()
    } catch {
        return null
    }
}

function generateShortCode(length = SHORT_CODE_LENGTH): string {
    const bytes = randomBytes(length)
    let code = ''
    for (const byte of bytes) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
    return code
}

async function createShortLink(parseTargetUrl: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
        const code = generateShortCode()
        const key = `shortlink:url:${code}`

        const result = await redisClient.set(key, parseTargetUrl, {
            NX: true, // 仅当 key 不存在时写入
            EX: SHORT_URL_TTL_SECONDS // 过期时间
        })

        if (result === "OK") return code
    }

    throw new Error("SHORT_CODE_COLLISION")
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
}

function redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { location })
    res.end()
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

    if (req.method === "POST" && requestUrl.pathname === "/shorten") {
        if (req.headers['content-type']?.split(";")[0] !== "application/json") {
            sendJson(res, 415, { error: "Content-Type must be application/json" })
            return
        }

        try {
            const body = await readJsonBody(req)
            const targetUrl = parseTargetUrl(body)

            if (!targetUrl) {
                sendJson(res, 400, { error: "A valid HTTP(S) URL is required" })
                return
            }

            const code = await createShortLink(targetUrl)
            sendJson(res, 201, { code, shortUrl: `http://localhost:${port}/${code}`, targetUrl, expiresIn: SHORT_URL_TTL_SECONDS })
        } catch (error) {
            if (error instanceof SyntaxError) {
                sendJson(res, 400, { error: "Invalid JSON" })
                return
            }

            if (error instanceof Error && error.message === "EMPTY_REQUEST_BODY") {
                sendJson(res, 400, { error: "Request body is required" })
                return
            }

            if (error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE") {
                sendJson(res, 413, { error: "Request body too large" })
                return
            }

            console.error("Failed to create short link:", error)
            sendJson(res, 500, { error: "Failed to create short link" })
        }

        return
    }

    if (req.method === "GET") {
        const match = requestUrl.pathname.match(/^\/([0-9A-Za-z]{6})$/)

        if (match) {
            const code = match[1]
            const targetUrl = await redisClient.get(`shortlink:url:${code}`)

            if (!targetUrl) {
                sendJson(res, 404, { error: "Short link not found or expired" })
                return
            }

            redirect(res, targetUrl)
            return
        }
    }

    sendJson(res, 404, { error: "Not Found" })
}

const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
        console.error("Unhandled request error:", error)

        if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal Server Error" })
            return
        }

        res.destroy()
    })
})

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
