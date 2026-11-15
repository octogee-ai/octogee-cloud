---
name: cua-x11
description: Operate native applications on this gateway VM's X11 desktop through the `computer` tool, which Cua Driver 0.38.0 fulfils. Covers the observe-act-verify loop, accessibility-first targeting, background versus foreground delivery, and honest handling of refusals. Use for GUI tasks in desktop applications; use the `browser` tool for web page content.
version: 0.38.0
metadata:
  openclaw:
    requires:
      config:
        - desktop.host.enabled
---

# Cua Driver through the computer tool

The desktop is driven only through the `computer` tool. Cua Driver runs behind
it on the desktop node, which the platform manages. There is no `cua-driver`
command, MCP server, session label, permission profile, recording control, or
skill installer for you to call. Do not install, update, or start Cua Driver,
and do not shell out to input or window tools (`wtype`, `ydotool`,
`hyprctl dispatch`, `xdotool`) to act on the desktop.

The snapshot-before-and-verify-after rule below is not optional. Skipping it is
the most common way a GUI action silently fails.

## Target on this computer

Every `computer` call targets the paired desktop node: pass `target: "node"`
and `node: "octogee-desktop"`. The Gateway itself has no desktop, so never pass
`target: "gateway"`. The session host name shown in the OpenClaw Control UI
(for example `octogee-computer`) is not a node id; `nodes` with
`action: "status"` lists the real node.

## Vocabulary

Cua documentation elsewhere uses driver names. On this computer:

| Cua Driver | `computer` tool |
| --- | --- |
| `pid` + `window_id` | `windowRef` from `list_windows` |
| `get_window_state(pid, window_id)` | `get_window_state` with `windowRef` (optional `includeScreenshot`, `query`, `depth`, `maxElements`) |
| `element_token`, or `element_index` + `snapshot_id` | `elementRef` with the `observationId` it came from |
| `delivery_mode` | `deliveryMode` (`background` or `foreground`) |
| `type_text` / `press_key`, `hotkey` | `type` / `key` |
| `set_value`, `invoke_menu` | `set_value` with `value`; `invoke_menu` with `path` |
| `verify_state` | none: take a fresh `get_window_state` and judge its tree and image |

`get_accessibility_tree` is unfiltered desktop discovery (windows and
processes). For one window's elements use `get_window_state`.

## Start with the narrowest route

Name the postcondition first, then use the first route that applies and verify
it in the same domain:

0. **Not a GUI outcome.** Files, repositories, data, and services have direct
   tools. Use them and read the result back; do not open an application to
   imitate a user.
1. **Web page content in the desktop Chromium.** Use the `browser` tool; it is
   attached to the same Chromium through `profile: "computer"`, which must be
   explicit on every browser call. The `user` and `chrome` profiles do not
   select this shared Chromium. Use `computer` for browser chrome,
   permission prompts, file pickers, and native dialogs.
2. **Background accessibility action** on an `elementRef` from the latest
   observation.
3. **Pixel action inside the window**, using coordinates from the image of the
   same observation.
4. **Foreground delivery** of only the action that evidence says could not land
   in the background, and only within the user's authorization.
5. **Desktop coordinates** from `screenshot` and its `frameId`, after the window
   routes have been tried and verified ineffective.

## The loop

1. `list_windows` and select the intended window explicitly. After launching an
   application, enumerate its windows again rather than assuming one exists.
2. `get_window_state` with that `windowRef`. Use `query` for the intended control
   and bound large trees with `depth` and `maxElements`; widen when the target
   is absent. It returns the accessibility tree,
   the window image, and an `observationId`. Ground the target on both.
3. Act with an `elementRef` (preferred) or window image coordinates, passing the
   `observationId`.
4. Use the fresh observation returned by the action, or take a new one, and
   check the postcondition before the next mutation.

A new observation invalidates older `elementRef`s and `observationId`s. A stale
reference means observe again and use only the new references. Never blind-retry
a mutation.

## Read action results without overclaiming

Results carry `effect`: `confirmed` > `unverifiable` > `suspected_noop`, and
`refused` when the route deliberately did not deliver. An action result
describes delivery, not task success. `unverifiable` is not failure: a native
entry can show typed text while its accessibility value lags. Inspect a fresh
image before repeating text; an immediate retry can duplicate it. If the pixels
already satisfy the task, stop.

An `escalation` hint is advice for your next choice, never an automatic retry.

## Tree and pixels together

The accessibility tree can be wrong: Electron can echo a value write that never
rendered, and virtualized rows can report one-pixel or off-screen bounds. A
`degraded` observation means the tree is empty or unusable for that window. On
those signals, target pixels from the image in the same observation. Do not
click a coordinate computed from a tree frame without checking it against the
image, and do not use an element you only saw in the image as an `elementRef`.

- Insert text at the cursor: `type`.
- Replace a control's whole value (dropdown, checkbox, slider, text field):
  `set_value`, accessibility only by design.
- Open a closed control (search button, collapsed field) with an accessibility
  press before typing; a pixel focus click does not reliably open and focus it.

## This desktop

Hobby runs Openbox on X11 with one TigerVNC display. It has no Hyprland
compositor or Omarchy settings, but it offers the same shape as the Omarchy
Gateway VM: the Desk (a frameless Chromium app window showing the
user's agent, note, clock, and app grid) opens at start, a dock along the
bottom edge launches Web, Files, Terminal, and Text and lists open windows,
windows float centred with Mac-style title bars (close, minimize, maximize on
the left), and a right-click on the desktop opens the same launcher menu.
Minimized windows reappear from the dock. Applications: Chromium, PCManFM
(Files), Sakura (Terminal), and Mousepad (Text). The user sees and controls
this same desktop through the Computer pane. The platform manages display,
accessibility bus, driver, dock, and browser startup; closing the Desk or the
dock brings it back.

Select a window with `list_windows` and fresh `windowRef` rather than assuming
its native X11 identifier is a tool reference. Coordinates come from the image
returned by the same observation. Observe again after a display size change.

Accessibility delivery and raw background input have different capabilities.
Honor each action's refusal or escalation result. Use foreground delivery only
within the user's authorization, then verify the actual postcondition from
fresh pixels and accessibility. Do not replace refused input with shell commands.

Keep `profile: "computer"` on every browser call. Its attach-only CDP connection
shares the visible Chromium profile and persisted cookies with the user.
The desktop node is always `octogee-desktop`; the node's name in a session label
or a process ID does not establish its native identity.
