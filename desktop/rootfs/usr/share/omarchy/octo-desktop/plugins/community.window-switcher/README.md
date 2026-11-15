# Omarchy Window Switcher

A keyboard-first window switcher for Omarchy. The window view lists windows in
most-recently-used (MRU) order. Workspace views can use recent or number order.

![Omarchy Window Switcher showing workspace previews](preview.webp)

## Quick start

1. Install the plugin from GitHub:

   ```bash
   omarchy plugin add https://github.com/devmobasa/omarchy-window-switcher.git --enable
   ```

2. Add this binding to `~/.config/hypr/bindings.lua`:

   ```lua
   hl.unbind("CTRL + TAB")
   o.bind("CTRL + TAB", "Window switcher", "omarchy shell shell summon community.window-switcher '{\"direction\":1}'")
   ```

3. Reload the Hyprland configuration:

   ```bash
   hyprctl reload
   hyprctl configerrors
   ```

4. Press Ctrl+Tab to open the switcher.

The switcher selects the previously used window or workspace. Use Tab and
Shift+Tab to move through the items. Press Enter to switch.

## Features

- Search by application, title, workspace, or monitor. The × in the search box
  clears the query.
- Filter windows with workspace pills.
- Show a window grid or composite workspace previews.
- Point at a window inside a workspace preview to read its title, then click it
  to switch to that window.
- Give numbered workspaces local names without renaming them in Hyprland.
- Order workspace sections by recent use or workspace number.
- Target the focused monitor in a multi-monitor layout.
- Toggle minimized windows and include Hyprland special workspaces.
- Use application icons as fallbacks for unavailable window capture.

## Requirements

- Omarchy Quattro with the schema-version-1 shell plugin host.
- Quickshell 0.3.0 or newer with `ToplevelManager` and `ScreencopyView`.
- Hyprland with `zwlr-foreign-toplevel-management-v1`.
- `hyprland-toplevel-export-v1` for previews. Window switching works without it.

The plugin uses QML and JavaScript. It does not start another Quickshell
process, poll `hyprctl`, run background commands, or write preview images.

## Controls

| Input | Action |
|---|---|
| Tab / Shift+Tab | Select the next or previous item |
| Arrow keys | Move through the grid |
| Ctrl+H/J/K/L | Move through the grid with Vim-style keys |
| Type / Backspace | Enter or edit a search query |
| Enter or click | Activate the selected window |
| Click a window inside a workspace preview | Activate that window |
| Escape | Clear the search, show all windows, or close the switcher |
| Ctrl+1 through Ctrl+9 | Filter by workspace 1 through 9 |
| Ctrl+0 | Filter by workspace 10 |
| Ctrl+A | Show all windows |
| Ctrl+M | Show or hide minimized windows for the current opening |
| Ctrl+O | Change workspace sections between recent and number order |
| Ctrl+W | Change between the window and workspace views |
| F2 or right-click a workspace card | Rename that workspace inside this switcher |
| Ctrl+G | Group the window grid by workspace |
| Ctrl+Delete | Request closure of the selected window in a window view |
| Middle-click or the × button | Request closure of a window |
| Middle-click a window inside a workspace preview | Request closure of that window |
| Workspace × button | Request closure of all windows on that workspace after a second click |

The × button shows on the selected card only. The pointer selects the card
that it touches, so the mouse can reach every × button. A workspace pill shows
its × button while the pointer is on that pill.

A click outside the switcher closes it and restores the original window.
Clear a workspace name in the editor to restore its default `Workspace N`
label. When any custom names exist, the workspace header also offers a
two-click **Reset names** action that restores every default label. Local names
are saved in this plugin's `shell.json` entry; they do not change Hyprland or
another workspace widget.

## Configuration

Configuration is part of the plugin entry in `~/.config/omarchy/shell.json`.
This file is the canonical shell configuration and does not use a deep merge.

The default view uses workspace cards, recent workspace order, and still
previews. You can change the view, order, filter, capture, and activation.

Read the [configuration reference](docs/configuration.md) for all keys,
invocation payloads, limits, session behavior, and legacy compatibility.

## Troubleshooting

### The plugin does not open

```bash
omarchy plugin list --json | jq '.[] | select(.id == "community.window-switcher")'
omarchy shell shell ping
omarchy shell shell call community.window-switcher status ""
omarchy shell shell rescanPlugins
```

Make sure that the plugin is enabled and present in `shell.json`.
Remove private window data before you share diagnostic output.

### Cards show icons without previews

The compositor or a window does not provide capture access. Switching, search,
and activation continue to work. Set `previewMode` to `none` to disable capture.

### A window is missing

Press Ctrl+A or select the All pill. The header count shows how many windows
the current filter hides.

If the window remains absent, collect `hyprctl clients -j` and the Wayland app
ID. Remove private window titles before you report the error.

## Development

### Install a local checkout

From the repository root, run the plugin validator:

```bash
omarchy plugin validate .
```

Then copy and enable the local checkout:

```bash
mkdir -p ~/.config/omarchy/plugins
plugin_target="$HOME/.config/omarchy/plugins/community.window-switcher"
[[ ! -e $plugin_target ]] && cp -a . "$plugin_target"
omarchy shell shell rescanPlugins
omarchy plugin enable community.window-switcher
```

The copy command does not replace an existing installation.

### Run the tests

Run the test suite from the repository root:

```bash
./test/all
```

The suite runs model tests, contract tests, manifest validation, and `qmllint`.
Read [design and privacy](docs/design.md) for the component map and visual test
scope.

## More Omarchy plugins

Explore [devmobasa's public Omarchy plugin collection](https://github.com/devmobasa#omarchy-plugins):

- **Desktop and windows:** [Minimizer Tray](https://github.com/devmobasa/omarchy-minimizer-tray),
  [Monitor Layout](https://github.com/devmobasa/omarchy-monitor-layout),
  [Scratchpad Deck](https://github.com/devmobasa/omarchy-scratchpad-deck),
  [Wallpaper Hub](https://github.com/devmobasa/omarchy-wallpaper-hub),
  [Window Overview](https://github.com/devmobasa/omarchy-window-overview), and
  [Window Switcher](https://github.com/devmobasa/omarchy-window-switcher).
- **Productivity:** [Calendar Agenda](https://github.com/devmobasa/omarchy-calendar-agenda),
  [Pomodoro](https://github.com/devmobasa/omarchy-pomodoro), and
  [Screen Time](https://github.com/devmobasa/omarchy-screen-time).
- **Automation and control:** [Context Rules](https://github.com/devmobasa/omarchy-context-rules),
  [Game Mode](https://github.com/devmobasa/omarchy-game-mode), and
  [Omarchy Nexus](https://github.com/devmobasa/omarchy-nexus).
- **Developer and presentation:** [Dev Inbox](https://github.com/devmobasa/omarchy-dev-inbox),
  [Git Hygiene](https://github.com/devmobasa/omarchy-git-hygiene),
  [Keycast](https://github.com/devmobasa/omarchy-keycast), and
  [Wayscriber Deck](https://github.com/devmobasa/omarchy-wayscriber-deck).
- **System and privacy:** [Drive Bay](https://github.com/devmobasa/omarchy-drive-bay),
  [Permission Center](https://github.com/devmobasa/omarchy-permission-center),
  [Privacy Dots](https://github.com/devmobasa/omarchy-privacy-dots),
  [systemd Health](https://github.com/devmobasa/omarchy-systemd-health), and
  [VPN Manager](https://github.com/devmobasa/omarchy-vpn-manager).

## License

MIT. This project is a clean-room Omarchy integration based on public APIs and
observed behavior. It does not copy GPL switcher implementations.
