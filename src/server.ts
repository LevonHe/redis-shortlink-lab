import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { connectRedis, disconnectRedis, redisClient } from "./redis"
// import { readFile } from "node:fs/promises"

const port = Number(process.env.PORT ?? 3003)

// crypto.randomBytes() 生成随机短码
// 请求体限制为 10kb，避免客户端无限发送数据占用内存
// 最多尝试 5 次短码，防止碰撞时无限循环
const SHORT_CODE_LENGTH = 6
const SHORT_URL_TTL_SECONDS = 24 * 60 * 60
const MAX_BODY_BYTES = 10 * 1024
const MAX_CODE_ATTEMPTS = 5
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

type ShortLink = {
    target: string
    createdAt: string
    clickCount: number
}

type RankingItem = {
    code: string
    score: number
}

type RateLimitRecord = {
    count: number
    windowStart: number
}

const RANKING_KEY = "shortlink:ranking"
const RANKING_LIMIT = 10

const rateLimitStore = new Map<string, RateLimitRecord>()

const RATE_LIMIT_MAX_REQUESTS = 5
const RATE_LIMIT_WINDOW_MS = 1000

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

const RATE_LIMIT_WINDOW_SECONDS = 1

// const readLimitScript = await readFile(new URL("./scripts/rate-limit.lua", import.meta.url),"utf-8")

async function incrementRankingScore(code: string): Promise<number> {
    return redisClient.zIncrBy(RANKING_KEY, 1, code)
}

async function getRanking(limit: number): Promise<RankingItem[]> {
    const entries = await redisClient.zRangeWithScores(RANKING_KEY, 0, limit - 1, { REV: true })
    return entries.map((entry) => ({ code: entry.value, score: entry.score }))
}

function checkLocalRateLimit(clientIp: string): boolean {
    const now = Date.now()
    const record = rateLimitStore.get(clientIp)

    if (!record || now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
        rateLimitStore.set(clientIp, { count: 1, windowStart: now })
        return true
    }

    if (record.count >= RATE_LIMIT_MAX_REQUESTS) return false

    record.count += 1
    return true
}

function getClientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? "unknown"
}

async function checkRedisRateLimit(clientIp: string): Promise<boolean> {
    const key = `shortlink:rate:${clientIp}`
    const count = await redisClient.incr(key)

    if (count === 1) {
        await redisClient.expire(key , RATE_LIMIT_WINDOW_SECONDS)
    }

    return count <= RATE_LIMIT_MAX_REQUESTS
}

async function checkLuaRateLimit(clientIp: string): Promise<boolean> {
    const key = `shortlink:rate:${clientIp}`

    const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
        keys: [key],
        arguments: [String(RATE_LIMIT_MAX_REQUESTS), String(RATE_LIMIT_WINDOW_SECONDS)]
    })

    return result === 1
}

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

async function createShortLink(targetUrl: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
        const code = generateShortCode()
        const key = `shortlink:url:${code}`

        const exists = await redisClient.exists(key)

        if (exists === 1) continue

        const transaction = redisClient.multi()

        transaction.hSet(key, {
            target: targetUrl,
            created_at: new Date().toISOString(),
            click_count: "0"
        })

        transaction.expire(key, SHORT_URL_TTL_SECONDS)

        const results = await transaction.exec()

        if (results === null) continue

        return code
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

async function getShortLink(code: string): Promise<ShortLink | null> {
    const key = `shortlink:url:${code}`
    const values = await redisClient.hmGet(key, ["target", "created_at", "click_count"])
    const [target, createdAt, clickCount] = values
    if (!target || !createdAt || clickCount === null) return null
    const parsedClickCount = Number(clickCount)
    if (!Number.isInteger(parsedClickCount) || parsedClickCount < 0) return null
    return { target, createdAt, clickCount: parsedClickCount }
}

async function incrementClickCount(code: string): Promise<number | null> {
    const key = `shortlink:url:${code}`
    if (!(await redisClient.exists(key))) return null
    return redisClient.hIncrBy(key, "click_count", 1)
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

    // /health
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

    // /shorten
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

    // /ranking
    if (req.method === "GET" && requestUrl.pathname === "/ranking") {
        try {
            const ranking = await getRanking(RANKING_LIMIT)
            sendJson(res, 200, { items: ranking })
        } catch (error) {
            console.error("Failed to get ranking:", error)
            sendJson(res, 503, { error: "Ranking is unavailable" })
        }
        return
    }

    // /links/:code
    if (req.method === "GET") {
        const match = requestUrl.pathname.match(/^\/links\/([0-9A-Za-z]{6})$/)

        if (match) {
            const code = match[1]
            const shortLink = await getShortLink(code)

            if (!shortLink) {
                sendJson(res, 404, { error: "Short link not found or expired" })
                return
            }

            sendJson(res, 200, { code, ...shortLink })
            return
        }
    }

    // /:code
    if (req.method === "GET") {
        const match = requestUrl.pathname.match(/^\/([0-9A-Za-z]{6})$/)

        if (match) {
            const code = match[1]
            const shortLink = await getShortLink(code)
            if (!shortLink) {
                sendJson(res, 404, { error: "Short link not found or expired" })
                return
            }

            const clientIp = getClientIp(req)
            // if (!checkLocalRateLimit(clientIp)) {
            if (!(await checkRedisRateLimit(clientIp))) {
                sendJson(res, 429, { error: "Too Many Requests" })
                return
            }

            const clickCount = await incrementClickCount(code)
            if (clickCount === null) {
                sendJson(res, 404, { error: "Short link not found or expired" })
                return
            }

            // phase 3 重点：如果 HINCRBY 成功，ZINCRBY 失败，Hash 中的点击数和排行榜 score 就不一致了
            await incrementRankingScore(code)

            redirect(res, shortLink.target)
            return
        }
    }

    // 404
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
