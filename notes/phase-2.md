当前 create 使用 EXISTS + MULTI，检查和写入之间仍有竞态；
当前 click count 使用 EXISTS + HINCRBY，过期窗口仍可能重建无 TTL key；
这些问题将在 Lua 阶段解决。
