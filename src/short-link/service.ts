import { randomBytes } from "node:crypto"
import type { ShortLink } from "./types"
import { redisClient } from "../redis"
import { SHORT_URL_TTL_SECONDS } from "../config"

// crypto.randomBytes() 生成随机短码
// 最多尝试 5 次短码，防止碰撞时无限循环
const SHORT_CODE_LENGTH = 6
const CODE_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const MAX_CODE_ATTEMPTS = 5

function generateShortCode(length = SHORT_CODE_LENGTH): string {
    const bytes = randomBytes(length)
    let code = ''
    for (const byte of bytes) {
        code += CODE_ALPHABET[byte % CODE_ALPHABET.length]
    }
    return code
}

export async function createShortLink(targetUrl: string): Promise<string> {
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

export async function getShortLink(code: string): Promise<ShortLink | null> {
    const key = `shortlink:url:${code}`
    const values = await redisClient.hmGet(key, ["target", "created_at", "click_count"])
    const [target, createdAt, clickCount] = values
    if (!target || !createdAt || clickCount === null) return null
    const parsedClickCount = Number(clickCount)
    if (!Number.isInteger(parsedClickCount) || parsedClickCount < 0) return null
    return { target, createdAt, clickCount: parsedClickCount }
}

export async function incrementClickCount(code: string): Promise<number | null> {
    const key = `shortlink:url:${code}`
    if (!(await redisClient.exists(key))) return null
    return redisClient.hIncrBy(key, "click_count", 1)
}
