local output = os.getenv("OCTO_OUTPUT_NAME") or "OCTOGEE"
local resolution = os.getenv("OCTO_RESOLUTION") or "1440x900"
local refresh = os.getenv("OCTO_REFRESH") or "30"

hl.monitor({ output = "", disabled = true })
hl.monitor({ output = output, mode = resolution .. "@" .. refresh, position = "0x0", scale = 1 })
