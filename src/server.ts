import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

const port = Number(process.env.PORT ?? 3003)

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" })
    res.end(JSON.stringify(body))
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

    if (req.method === "GET" && requestUrl.pathname === "/health") {
        sendJson(res, 200, { status: "ok" })
        return
    }

    sendJson(res, 404, { error: "Not Found" })
}

function shutdown(): void {
    console.log("Shutting down server...")

    server.close((error) => {
        if (error) {
            console.error("Failed to close server:", error)
            process.exitCode = 1
            return
        } 
        
        console.log("Server closed successfully.")
    })
}

const server = createServer(handleRequest)

server.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`)
})

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
