import { createClient } from 'redis'

const redisUrl = process.env.REDIS_URL

if (!redisUrl) { throw new Error('REDIS_URL is required') }

export const redisClient = createClient({ url: redisUrl, disableOfflineQueue: true })

// redisClient isOpen: 底层连接已打开或正在重连 isReady: 客户端已完成连接和认证可以执行命令
redisClient.on('error', (error) => {
    console.error('Redis client error:', error)
})

export async function connectRedis (): Promise<void> {
    if (redisClient.isOpen) return
    await redisClient.connect()
    console.log('Connected to Redis')
}

export async function disconnectRedis (): Promise<void> {
    if (!redisClient.isOpen) return
    await redisClient.quit()
    console.log('Disconnected from Redis')
}
