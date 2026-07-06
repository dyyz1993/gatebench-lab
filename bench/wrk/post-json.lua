wrk.headers["Content-Type"] = "application/json"
body = string.rep("{", 100) .. '"key":"value"' .. string.rep("}", 100)

request = function()
    return wrk.format("POST", "/json/large", nil, body)
end
