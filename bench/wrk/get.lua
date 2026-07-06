-- simple GET
request = function()
    return wrk.format("GET", "/ping")
end
