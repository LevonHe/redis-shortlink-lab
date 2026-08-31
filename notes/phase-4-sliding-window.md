# Phase 4 遗留任务：Lua + ZSet 滑动窗口限流

## 为什么从固定窗口演进到滑动窗口

固定窗口会把时间切成互不重叠的区间。例如限制为每秒最多 5 次时，客户端可能在一个窗口结束前通过 5 次，又在下一个窗口开始后立刻通过 5 次。虽然每个固定窗口都没有超限，但很短的时间内实际通过了 10 次请求。

滑动窗口不依赖固定的时间边界。每次请求到达时，都只统计当前时刻之前一个窗口内的请求：

```text
窗口范围：(now - window, now]
```

当前实现使用 Redis ZSet 保存窗口内已经通过的请求，并用 Lua 把清理、计数、判断和写入组成一个原子操作。

## Redis 数据模型

```text
key    = shortlink:rate:sliding:<IP>
type   = ZSet
score  = 请求到达 Redis 时的毫秒时间戳
member = 每次请求生成的 UUID
```

示例：

```text
shortlink:rate:sliding:127.0.0.1

score          member
1788168081240  43d86c6c-...
1788168081368  b5107666-...
1788168081502  d9b35902-...
```

ZSet 按 score 排序，因此可以按时间范围删除过期请求，并用 `ZCARD` 统计窗口内剩余的请求数。

member 不能直接使用时间戳。多个请求可能落在同一毫秒，如果 member 相同，`ZADD` 会更新原有成员而不是新增成员，导致少计请求。使用 UUID 可以让同一毫秒内的并发请求仍拥有不同 member。

## Lua 脚本执行过程

当前脚本接收的参数：

```text
KEYS[1] = shortlink:rate:sliding:<IP>
ARGV[1] = 最大请求数，例如 5
ARGV[2] = 窗口长度（毫秒），例如 1000
ARGV[3] = 本次请求的 UUID
```

执行步骤：

1. 使用 `TIME` 获取 Redis 服务器时间，并转换成毫秒。
2. 计算窗口左边界 `window_start = now_ms - window_ms`。
3. 使用 `ZREMRANGEBYSCORE` 删除 score 小于等于左边界的记录。
4. 使用 `ZCARD` 统计当前窗口内已通过的请求数。
5. 如果数量已经达到限制，拒绝请求，不把本次请求写入 ZSet。
6. 如果尚未达到限制，使用 `ZADD` 写入本次请求。
7. 使用 `PEXPIRE` 设置毫秒级 TTL，避免长期不再访问的 IP key 永久存在。

核心命令对应关系：

```lua
local time = redis.call("TIME")
local now_ms = time[1] * 1000 + math.floor(time[2] / 1000)
local window_start = now_ms - tonumber(ARGV[2])

redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", window_start)
local current = redis.call("ZCARD", KEYS[1])

if current >= tonumber(ARGV[1]) then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return {0, current, now_ms}
end

redis.call("ZADD", KEYS[1], now_ms, ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return {1, current + 1, now_ms}
```

返回数组中：

```text
第 1 项：1 表示通过，0 表示拒绝
第 2 项：判断后的窗口内请求数
第 3 项：Redis 当前时间（毫秒）
```

当前 Node.js 代码只使用第 1 项决定请求是否通过，另外两项为后续调试或扩展保留。

## 为什么使用 Redis TIME

如果 Node.js 实例各自使用 `Date.now()`，多实例部署时可能因为机器时钟存在偏差，对同一个窗口产生不一致的判断。

脚本使用 Redis 的 `TIME`，让所有调用同一个 Redis 的应用实例使用同一时间来源。它减少了应用服务器时钟不一致的问题，但也意味着 Redis 服务器时间会直接影响限流结果。

## 窗口边界语义

`ZREMRANGEBYSCORE key -inf window_start` 的上下界默认都包含边界，因此 score 恰好等于 `window_start` 的记录也会被删除。

所以当前保留的区间是：

```text
(now_ms - window_ms, now_ms]
```

例如 `now_ms = 2000`、窗口为 `1000 ms`，时间戳等于 `1000` 的请求不再计入当前窗口，时间戳大于 `1000` 的请求仍会计入。

## 原子性与失败语义

Redis 执行 Lua 脚本期间不会穿插执行其他客户端命令，因此以下步骤是一个不可被并发请求插入的整体：

```text
删除过期记录 -> 统计数量 -> 判断是否通过 -> 写入本次请求 -> 设置 TTL
```

如果这些操作分成多个 Node.js 调用，并发请求可能都在写入前读到相同的数量，从而一起通过并超过限制。Lua 避免了这个竞态条件。

但 Lua 的原子性不等于事务回滚。脚本执行到一半报错时，之前已经完成的 Redis 写操作不会自动撤销。因此应尽量在编码和测试阶段排除脚本语法错误、参数错误和 key 类型错误。

当前滑动窗口使用独立的 key 前缀 `shortlink:rate:sliding:`，不会与固定窗口使用的 String key 冲突，否则对 String 执行 ZSet 命令会产生 `WRONGTYPE` 错误。

## 被拒绝的请求为什么不写入 ZSet

当前实现只保存已经通过的请求。达到限制后，本次请求直接返回拒绝，不执行 `ZADD`。

这样有两个效果：

- 持续重试的被拒绝请求不会继续扩大 ZSet。
- 限流表示“任意一个窗口内最多通过 N 次”，而不是“拒绝后重新延长等待时间”。

固定窗口实现会先执行 `INCR`，所以被拒绝的请求也会继续增加计数；这是两个实现值得注意的行为差异。

## TTL 的作用

每次检查都会执行：

```redis
PEXPIRE shortlink:rate:sliding:<IP> <window_ms>
```

TTL 只负责清理不再访问的 key，真正决定请求是否仍在窗口内的是 score 和 `ZREMRANGEBYSCORE`，不能依靠 TTL 代替窗口清理。

持续有请求时 TTL 会被刷新；停止请求后，整个 key 会在一个窗口长度后自动过期。即使 key 过期，旧请求也已经全部离开有效窗口，因此不会影响之后的限流判断。

## 与固定窗口的比较

| 维度 | 固定窗口 | 当前滑动窗口 |
| --- | --- | --- |
| Redis 数据结构 | String | ZSet |
| 保存内容 | 当前窗口计数 | 每个已通过请求的时间 |
| 边界突发 | 存在 | 避免固定边界突发 |
| 单次检查 | `INCR`、首次设置 TTL | 删除过期记录、计数、写入、设置 TTL |
| 内存开销 | 每个 IP 一个计数值 | 每个 IP 保存窗口内至多约 limit 个 member |
| 被拒绝请求 | 仍增加计数 | 不写入 ZSet |
| 原子性 | Lua 版本具备 | Lua 版本具备 |

滑动窗口判断更精确，但会使用更多内存和命令处理成本。`ZREMRANGEBYSCORE`、`ZCARD` 和 `ZADD` 都在脚本中执行，脚本运行期间会阻塞 Redis 处理其他命令，因此窗口大小、限额以及 key 数量都不能无限扩大。

## 验证方式

启动服务时选择滑动窗口策略：

```bash
RATE_LIMIT_STRATEGY=sliding npm run dev
```

连续请求同一个有效短链接，前 5 次应通过，第 6 次应返回 `429 Too Many Requests`。等待早期请求逐个移出最近 1000 ms 的窗口后，新请求会逐步恢复通过，而不是等待某个固定窗口整体重置。

观察 ZSet 内容和 TTL：

```redis
SCAN 0 MATCH shortlink:rate:sliding:* COUNT 100
ZCARD shortlink:rate:sliding:<IP>
ZRANGE shortlink:rate:sliding:<IP> 0 -1 WITHSCORES
PTTL shortlink:rate:sliding:<IP>
TYPE shortlink:rate:sliding:<IP>
```

`SCAN` 返回的第一个值是下一次扫描要使用的 cursor。cursor 为 `0` 表示本轮扫描结束；结果为空表示当前没有匹配的 key，常见原因是尚未触发限流检查或 key 已因 TTL 过期。

## 当前实现的边界

- 每个请求都会从 Node.js 生成一个 UUID，并通过 `EVAL` 发送完整 Lua 脚本。
- 尚未使用 `SCRIPT LOAD` 与 `EVALSHA` 缓存脚本。
- 当前接口只返回是否通过，没有返回剩余配额和重试时间。
- 限流 key 直接使用客户端 IP，生产环境还需要谨慎处理反向代理和可信 `X-Forwarded-For`。
- 单 Redis 实例可以保证脚本内的原子性；Redis Cluster 中，脚本涉及的 key 必须位于同一个 hash slot。当前脚本只操作一个 key，满足这一约束。

这次演进的核心不是单纯把 String 换成 ZSet，而是利用 ZSet 的有序范围能力表达“最近一段时间内发生过的请求”，再利用 Lua 保证一次限流判断中的多条 Redis 命令不会被并发请求打断。
