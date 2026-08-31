export type RateLimiter = {
    check(clientIp: string): Promise<boolean>
}
