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


## Consumer

Stream 本体保存消息字段；
Consumer Group 保存各组自己的消费进度；
PEL 保存已投递但尚未 ACK 的消息状态；
XACK 只移除 PEL 记录，不会删除 Stream 中的消息；
使用 ">" 只读取从未分配的新消息，不会自动返回旧 Pending。

XACK 应在业务处理成功后执行；
XACK 返回 1 表示从当前组的 PEL 移除，返回 0 表示没有可确认记录；
XACK 不会删除 Stream 本体中的消息；
失败后不 ACK 只会让消息留在 PEL，并不会自动重试；
当前消费者串行处理消息，吞吐量有限但行为清晰；
重复 XACK 不会重复修改状态。

业务处理成功但 XACK 失败时，消息仍在 PEL；
消息恢复后可能再次执行，因此消费者业务必须考虑幂等性；
当前 console.log 没有外部副作用，后续落库时应使用消息 ID 做去重。

XAUTOCLAIM 只接管 idle time 超过阈值的 Pending；
接管会改变消息 owner，并增加投递次数；
接管不等于处理成功，成功后仍需 XACK；
nextId 用于分批扫描，0-0 表示本轮完成；
旧消费者不会因消息被接管而自动删除；
失败消息可能被不断接管，因此需要最大重试次数和死信机制；
Stream 消息被裁剪后，PEL 可能短暂保留无消息体的 ID。

delivery count 包含首次投递；
不 ACK 只会保留 Pending，周期恢复才产生重试；
达到最大投递次数后写入死信 Stream 并 ACK 原消息。
死信保存 original_id、原始 payload、失败原因和投递次数；
XACK 不会删除主 Stream 消息；
简单的 Redis processed key 无法消除业务处理与标记之间的崩溃窗口。

现在故障语义是：

```text
死信 XADD 失败
  -> 抛出异常
  -> 不 ACK 原消息
  -> 消费者退出，原消息仍在 PEL

死信 XADD 成功、XACK 失败
  -> 原消息仍在 PEL
  -> 后续可能产生重复死信

死信 XADD 成功、XACK 成功
  -> 原消息离开 PEL
```

Stream message ID 用作 SQLite 幂等键；
PRIMARY KEY 防止重复插入；
duplicate 仍属于处理成功，可以继续 ACK；
数据库写入必须发生在 XACK 之前；
写入成功但 ACK 失败时，重新投递不会产生重复行；
这实现的是幂等效果，不是跨 Redis 和 SQLite 的 exactly-once。
