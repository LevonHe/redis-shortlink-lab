import { RANKING_KEY } from "../config"
import { redisClient } from "../redis"

type RankingItem = {
    code: string
    score: number
}

export async function incrementRankingScore(code: string): Promise<number> {
    return redisClient.zIncrBy(RANKING_KEY, 1, code)
}

export async function getRanking(limit: number): Promise<RankingItem[]> {
    const entries = await redisClient.zRangeWithScores(RANKING_KEY, 0, limit - 1, { REV: true })
    return entries.map((entry) => ({ code: entry.value, score: entry.score }))
}
