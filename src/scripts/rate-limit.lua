-- 参数约定
-- KEYS[1] -> shortlink:rate:<ip>
-- ARGV[1] -> 最大请求数，例如 5
-- ARGV[2] -> 窗口描述，例如 1
local current = redis.call("INCR", KEYS[1])

if current == 1 then
    redis.call("EXPIRE", KEYS[1], ARGV[2])
end

if current > tonumber(ARGV[1]) then
    return 0
end

return 1
