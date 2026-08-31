export type AccessEvent = {
    code: string
    clientIp: string
    target: string
    accessedAt: string
}

export type StreamMessage = {
    id: string
    message: Record<string, string>
}
