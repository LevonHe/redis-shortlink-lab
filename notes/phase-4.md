# Phase 4：限流与 Lua 原子操作

与本地 Map 相比：
- 多个 Node.js 实例共享一个计时器
- 服务重启后窗口状态仍可短暂保留
- TTL 自动清理 key，不会像 Map 一样永久累积 IP
- `INCR` 本身是原子的，并发计数不会丢失
  
但 `INCR + EXPIRE` 组合还不是原子的。

## 理解 Lua 脚本执行过程

当前脚本：
```lua
local current = redis.call("INCR", KEYS[1])

if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
end

if current > tonumber(ARGV[1]) then
  return 0
end

return 1
```

参数映射：
```text
KEYS[1] = shortlink:rate:<IP>
ARGV[1] = 5
ARGV[2] = 1
```

Redis 执行脚本期间，不会穿插执行其他客户端命令。因此：

```text
INCR
首次设置 EXPIRE
比较限制
```

组成一个原子操作。

**需要准确理解**：Redis Lua 的原子性并不是失败时自动回滚。Lua 脚本运行出错时，已经执行的写操作不会自动撤销。这里的原子性主要指脚本执行期间不会被其他命令插入。

## 一个固定窗口边界实验

窗口末尾通过 5 次
key 过期
新窗口开头又通过 5 次
