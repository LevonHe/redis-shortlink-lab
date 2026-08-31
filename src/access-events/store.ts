import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { ACCESS_EVENTS_DB_PATH } from "../config"

export type StoredAccessEvent = {
    messageId: string
    code: string
    ip: string
    target: string
    accessedAt: string
}

export type SaveResult = "inserted" | "duplicate"

export class AccessEventStore {
    private readonly database: DatabaseSync

    constructor(path = ACCESS_EVENTS_DB_PATH) {
        mkdirSync(dirname(path), { recursive: true })

        this.database = new DatabaseSync(path)

        this.database.exec(`
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS access_events (
                message_id TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                ip TEXT NOT NULL,
                target TEXT NOT NULL,
                accessed_at TEXT NOT NULL,
                consumed_at TEXT NOT NULL
            );
        `)
    }

    save(event: StoredAccessEvent): SaveResult {
        const statement = this.database.prepare(`
            INSERT INTO access_events (
                message_id,
                code,
                ip,
                target,
                accessed_at,
                consumed_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id) DO NOTHING
        `)

        const result = statement.run(
            event.messageId,
            event.code,
            event.ip,
            event.target,
            event.accessedAt,
            new Date().toISOString()
        )

        // inserted  -> 第一次处理，数据已写入
        // duplicate -> 之前已经写入，这次是重复投递
        // duplicate 不是业务失败，而是幂等保护生效
        return result.changes === 1 ? "inserted" : "duplicate"
    }

    close(): void {
        this.database.close()
    }
}
