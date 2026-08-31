# Phase 4：限流与 Lua 原子操作

与本地 Map 相比：
- 多个 Node.js 实例共享一个计时器
- 服务重启后窗口状态仍可短暂保留
- TTL 自动清理 key，不会像 Map 一样永久累积 IP
- `INCR` 本身是原子的，并发计数不会丢失
  
但 `INCR + EXPIRE` 组合还不是原子的。
