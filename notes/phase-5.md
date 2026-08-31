# Phase 5：Stream 与异步访问日志

* Stream key 和字段设计
> 当前使用一个 Stream `key: shortlink:access-events` 每条消息表示一次成功的短链接访问，code: 短码，ip: 客户端 IP，target: 目标 URL，accessed_at: 业务层记录的访问时间。
> 设计成一个全局 Stream，而不是每个短链接一个 Stream，主要因为
> - 消费者只需监听一个 key
> - 容易按全局顺序处理访问事件
> - 不会产生大量 Stream key
> - Consumer Group 可以统一分配消息
> code 是业务标识，消费者可以据此聚合；target 让事件具有一定自包含能力；accessed_at 是应用观察到的业务时间

* Stream ID 的两部分含义
> Redis Stream ID 格式是 `毫秒时间戳-序号，如 1788168081240-0`，Stream ID 主要用于：
> - 唯一标识消息
> - 排序
> - 指定读取起点
> - Consumer Group 记录消费位置
> - ACK 消息
> 它不应该完全替代业务时间。应用可能存在时钟差异、处理延迟或重放，因此仍保存 accessed_at

* XADD * 的作用
> 基本形式 `XADD <stream-key> <id> <field> <value> ...`，`XADD shortlink:access-events * code ZSe2Td`
> - 其中 * 表示让 Redis 自动生成 Stream ID，Redis 会保证新生成的 ID 大于当前 Stream 中最后一条消息的 ID，从而维持顺序

* XLEN、XRANGE、XREVRANGE 的区别
> XLEN 返回 Stream 当前包含的消息数量 `XLEN shortlink:access-events`: `(integer) 12`，只返回数量，不返回消息
> XRANGE 按 ID 从小到大读取消息，`XRANGE shortlink:access-events - +`, `XRANGE shortlink:access-events - + COUNT 5`, `XRANGE    start end`
> XREVRANGE 按 ID 从大到小读取, `XREVRANGE shortlink:access-events + -`, `XREVRANGE shortlink:access-events + - COUNT 5`, `XREVRANGE end start`

* MAXLEN ~ 为什么不是精确长度
> 写入时可以限制 Stream 长度 `XADD shortlink:access-events MAXLEN ~ 10000 * ...`
> - MAXLEN 表示根据消息数量裁剪 Stream，~ 表示近似裁剪
> - Redis Stream 的底层数据按内部节点组织。如果每次写入后都精确删除到恰好 10000 条，Redis 可能需要频繁修改节点，产生额外 CPU 成本。近似裁剪允许暂时超过阈值、等到合适的内部边界、一次删除一批记录。所以设置 `MAXLEN ~ 10000` 不代表 Stream 永远恰好不超过 10000，而是让它大致维持在这个数量附近。如果必须精确，可以使用 `MAXLEN = 10000` 或 `MAXLEN 10000`，精确裁剪通常开销更高。访问日志通常不需要精确保留某个条数，所以近似裁剪更合适。

* 当前为什么等待 XADD 后才重定向
> 当前顺序是 `限流 -> 点击计数 -> 排行榜更新 -> XADD -> 302 重定向`
> await publishAccessEvent(...)
> redirect(res, shortLink.target)
> 这提供了一个明确保证，只要客户端收到 302 访问事件就已经成功写入 Redis Stream
> 如果不等待：void publishAccessEvent(...)
> HTTP 请求会立刻完成，但后台写入可能失败。这样用户成功跳转了，系统却没有对应访问事件。
> 当前等待 XADD 是为了学习和观察可靠性语义，而不是因为日志一定要阻塞主流程。
> 代价是增加一次 Redis 命令的等待时间，并让日志写入成为跳转的必要依赖。

* 如果 Redis 或 XADD 失败，当前请求会发生什么
> publishAccessEvent() 会抛出异常，异常继续向上传递到统一请求错误处理 void handleRequest(req, res).catch(...)
> 如果尚未发送响应，服务返回：HTTP 500 Internal Server Error，因此客户端不会收到 302，也不会跳转。但在 XADD 之前，这些操作可能已经成功：Lua 限流计数增加、Hash click_count 增加、ZSet 排行榜分数增加。Redis 不会因为后面的 XADD 失败而自动回滚前面的命令。因此可能出现：点击数已增加、排行榜已增加、Stream 中没有事件、用户也没有收到重定向。
> 这说明当前整个访问流程不是一个原子事务。
> 可选策略包括：
> - 严格写入：等待 XADD，日志失败则请求失败。当前采用此方案。
> - 尽力写入：先重定向，异步写日志；可用性高，但可能丢日志。
> - Lua/事务组合：把兼容的 Redis 更新组合执行，但 HTTP 响应仍不可能参与 Redis 原子事务。
> - 先写 Stream：将访问事件作为事实来源，由消费者异步更新点击数和排行榜。
> - 独立消息系统：使用更适合持久消息处理的 MQ。
> Phase 5 后续采用 Consumer Group 后，会更清楚地看到一种常见设计：
> 请求写入 Stream -> 返回重定向 -> 消费者异步更新统计或落库
> 这样可以减少主请求中的同步操作，但需要处理消息积压、重复消费、ACK 和消费者恢复。
