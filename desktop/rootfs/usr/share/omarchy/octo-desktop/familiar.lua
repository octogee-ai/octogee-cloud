local hyprbars_path = (os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/octo-desktop/hyprbars.so"
local switcher = "omarchy-shell shell summon community.window-switcher "
local desk_class = "^chrome-127\\.0\\.0\\.1__desk-Default$"

hl.config({
  general = {
    resize_on_border = true,
    extend_border_grab_area = 12,
    hover_icon_on_border = true,
    snap = { enabled = true, window_gap = 10, monitor_gap = 10, respect_gaps = true },
  },
  decoration = { rounding = 10 },
})

hl.window_rule({
  name = "octo-familiar-float",
  match = { class = "negative:^(org\\.omarchy\\.screensaver|chrome-127\\.0\\.0\\.1__desk-Default)$", float = false },
  float = true,
  size = { "monitor_w*0.7", "monitor_h*0.7" },
  center = true,
})

hl.window_rule({
  name = "octo-familiar-browser",
  match = { tag = "chromium-based-browser", class = "negative:" .. desk_class },
  tile = false,
  float = true,
  size = { "monitor_w*0.92", "monitor_h*0.9" },
  center = true,
})

hl.window_rule({
  name = "octo-familiar-desk",
  match = { class = desk_class },
  tile = false,
  float = true,
  size = { "monitor_w*0.8", "monitor_h*0.8" },
  center = true,
  ["hyprbars:no_bar"] = true,
})

hl.unbind("SUPER + TAB")
hl.unbind("SUPER + SHIFT + TAB")
o.bind("SUPER + TAB", "Switch windows", switcher .. "'{\"direction\":1}'")
o.bind("SUPER + SHIFT + TAB", "Switch windows backwards", switcher .. "'{\"direction\":-1}'")

local loaded, problem = pcall(hl.plugin.load, hyprbars_path)
local hyprbars = hl.plugin.hyprbars
if not hyprbars then
  if not loaded then
    hl.notification.create({ text = "Familiar desktop: title bars unavailable (" .. tostring(problem) .. ")", duration = 8000, icon = "warning" })
  end
  return
end

hl.config({
  plugin = {
    hyprbars = {
      enabled = true,
      bar_height = 28,
      bar_color = "rgb(ececec)",
      col = { text = "rgb(1d1d1f)" },
      bar_title_enabled = true,
      bar_text_font = "sans-serif",
      bar_text_size = 12,
      bar_text_weight = 600,
      bar_text_align = "center",
      bar_buttons_alignment = "left",
      bar_part_of_window = true,
      bar_precedence_over_border = true,
      bar_padding = 10,
      bar_button_padding = 7,
      icon_on_hover = true,
    },
  },
})

hyprbars.add_button({
  bg_color = "rgb(ff5f57)",
  fg_color = "rgb(4d0000)",
  size = 12,
  icon = "×",
  action = "hyprctl dispatch 'hl.dsp.window.close()'",
})
hyprbars.add_button({
  bg_color = "rgb(28c840)",
  fg_color = "rgb(006500)",
  size = 12,
  icon = "+",
  action = "hyprctl dispatch 'hl.dsp.window.fullscreen({ mode = \"maximized\", action = \"toggle\" })'",
})
