---
name: cua-omarchy
description: Omarchy and Hyprland specifics for operating this gateway VM's desktop through the `computer` tool. Complements the cua-driver skill; use for computer-use tasks on the Omarchy desktop, not for desktop customization or package management.
metadata:
  openclaw:
    requires:
      config:
        - desktop.host.enabled
---

# Cua on Omarchy

Read the `cua-driver` skill first for the observe-act-verify loop and the
`computer` tool vocabulary. This skill adds what is specific to this desktop.

## This desktop

- Omarchy on Hyprland with one visible output. The user can watch and take
  over the same screen from the Computer pane.
- The desktop is the paired node `octogee-desktop`: call `computer` with
  `target: "node"` and `node: "octogee-desktop"`, never `target: "gateway"`.
- Chromium on this desktop is the attach-only `computer` browser profile.
  Pass `profile: "computer"` explicitly on every `browser` call; `user` and
  `chrome` do not select the browser shared with the user.
- The platform manages the Cua Driver and its desktop node. Do not install,
  update, or reconfigure Cua Driver or the Cua Hyprland plugin, do not run
  Omarchy's Cua install or toggle commands, and do not load, unload, or
  reconfigure Hyprland plugins or input settings as part of a computer task.
- The Cua Hyprland input plugin is not installed. Raw background input to an
  unfocused window is unavailable; `background_unavailable` is the contract.
- The desktop starts in the Familiar style: windows float and overlap with
  traffic-light title bars, open centred, and snap to a half or quarter when
  dragged to a screen edge; a dock along the bottom edge appears when the
  pointer reaches that edge and opens or raises apps; Super+Tab switches
  windows. A floating target may be partly covered, so select it with
  `list_windows` and foreground delivery instead of moving other windows.
  Switching between Familiar and stock Omarchy is customization
  (`octo-desktop-style`), not a computer task.

## Target and verify on Hyprland

Obtain `windowRef` from `list_windows` and select the intended window
explicitly. Hyprland addresses from `hyprctl -j clients` can help diagnose but
are not interchangeable with `windowRef`.

Take `get_window_state` for that exact target before acting, and act with its
`elementRef` and `observationId`. Observe again after an action and use the new
references.

Use coordinates from the returned window image directly for window pixel
actions. Do not add monitor offsets or multiply by scale. If the display layout
or size changes, observe again. `isOnScreen`, `zIndex`, or a launch result do
not establish keyboard focus.

Hyprland's capture and virtual-input protocols do not guarantee exact capture
of an arbitrary window. If the target surface cannot be established, use the
accessibility result when it suffices; do not treat a crop of the output as
proof of that window's pixels or send pixel actions against an unproven
capture.

Honor `background_unavailable`, `surface_identity_unproven`, and other
refusals. Foreground delivery changes focus, workspace, and the real pointer on
the user's screen, so use it only within their authorization. Do not work
around a refusal with `hyprctl` focus dispatches or generic input injection.
Verify the requested postcondition from fresh state; a delivery acknowledgment
alone is not enough.

An `unverifiable` result with a foreground escalation hint is not proof that
input failed: a native GTK entry can show typed text while its fresh
accessibility tree omits the value. Inspect a fresh image before repeating text
or changing delivery mode. If the pixels already satisfy the task, stop. If
capture is unavailable, keep the uncertainty rather than replaying input that
may already have landed.

## When the desktop itself looks wrong

If every window observation is `degraded`, or `list_windows` omits running
applications, the desktop's accessibility bus may be down. Tell the user
what you observed instead of switching to raw input to compensate.

## Testing

For tests, use a disposable application and limit images to that target. Record
discovery, capture, semantic input, raw input, and focus checks separately.
Input into an already focused window does not prove input to an unfocused or
occluded one.
