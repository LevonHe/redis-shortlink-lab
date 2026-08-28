# Phase 1：String 与 TTL

## 数据设计

使用了什么 key、value 和 TTL？

```text
key: shortlink:url:<code>
value: 原始 URL
TTL: 86400 秒

例如 SET shortlink:url:a8Zk2Q "https://example.com/" EX 86400 NX
例如 GET shortlink:url:a8Zk2Q
```

## SET NX EX

为什么不能先 GET 再 SET？
> GET 和 SET 各自是原子的，但组合起来不是原子的，并发时可能发生请求覆盖。

NX 冲突时 Redis 返回什么？
> 成功时返回 `OK`，key 已经存在时返回 `(nil)`，失败的 `SET NX` 不会覆盖原值，不会更新原 key，不会刷新原 TTL

EX 为什么应当和 SET 放在同一条命令中？
> 如果拆成 `SET shortlink:url:a8Zk2Q "http://example.com/"` 和 `EXPIRE shortlink:url:a8Zk2Q 86400` 两条命令，可能出现 SET 成功，应用崩溃或网络断开时，EXPIRE 没有执行，此时 key 会永久存在，形成无 TTL 的 脏数据。使用 `SET key value EX 86400 NX` Redis 会原子地完成条件检查、写值和设置 TTL，不会出现“写入成功但没有过期时间”的中间状态。

## TTL

TTL 的正整数、-1 和 -2 分别表示什么？
> 正整数：剩余过期描述；
> 0：剩余时间不足一秒，但 key 暂时存在；
> -1：key 存在，但没有设置过期时间
> -2：key 不存在，或者已经过期

短链接过期后，HTTP 接口返回什么？
> 过期后 `GET shortlink:url:<code>` 返回 `nil`，Node Redis 返回 `null`，应用无法区分 短码从未存在 和 短码曾经存在但已过期 的情况，统一返回 `404 Short link not found or expired`。

Redis 如何删除过期 key？
> 惰性删除：客户端访问一个已经过期的 key 时，Redis 检查过期时间，发现它已经过期后删除并按不存在处理。
> 定期删除：Redis 周期性抽样检查带 TTL 的 key，并删除已经过期的部分。Redis 通常不会为每个 key 创建一个精确到期的独立定时器，因为海量定时器会消耗大量的 CPU 和内存。因此“逻辑上已经过期”和“内存对象已经被物理删除”可能不是完全同一时刻。但客户端访问过期的 key 时，不会取得过期值。

## 故障行为

Redis 断开时，创建和访问短链接分别发生什么？
> 工程中设置了 `disableOfflineQueue: true` 因此 Redis 不可用时，命令不会排队等待恢复，而是快速失败。
> 创建短链接时 `redisClient.set(...)` 抛出异常，由接口捕获并返回 `500 Failed to create short link`
> 访问短链接时 `redisClient.get(...)` 抛出异常，最终由请求的统一错误处理捕获并返回 `500 Internet Server Error`
> 健康检查返回 `500 Service Unavailable`

## 当前限制

存在一些问题，但不是当前代码做错了，而是 Phase 1 有意保持最小模型。

> 同一个长 URL 重复提交会生成不同短码
> 只保存目标 URL，无法保存创建时间、点击次数等元数据
> Redis key 过期后，无法判断短码是从未存在还是已经过期
> 数据主要依赖 Redis，尚未设计持久数据库作为事实来源
> 6 位短码空间有限，随着数据量增加，碰撞概率会提高
> 创建响应中的短网址写死为 `localhost:3003`，不适合部署环境
> 没有自定义短码、停用短链接或修改目标 URL 的能力
> Redis 故障时没有降级读取方案
> 尚未实现自动化测试和并发测试
