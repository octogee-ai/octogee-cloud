import QtQuick
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland

// Compositor event wiring: which Hyprland and Wayland signals matter to the
// switcher and how urgently they invalidate its state.
Item {
  id: compositor

  required property bool switcherOpen

  signal refreshRequested()
  signal geometryRefreshRequested()
  signal activeWindowChanged()
  signal workspaceFocusChanged(var workspaceId)
  signal screenLayoutChanged()

  readonly property var geometryEventNames: [
    "openwindow", "closewindow", "movewindow", "movewindowv2", "minimize", "fullscreen",
    "workspace", "workspacev2", "focusedmon", "moveworkspace", "moveworkspacev2"
  ]
  readonly property var refreshEventNames: geometryEventNames.concat([
    "activewindow", "activewindowv2", "urgent"
  ])

  visible: false

  Connections {
    target: ToplevelManager.toplevels
    function onValuesChanged() { compositor.refreshRequested() }
  }

  Connections {
    target: ToplevelManager
    function onActiveToplevelChanged() { compositor.activeWindowChanged() }
  }

  Connections {
    target: Hyprland.toplevels
    function onValuesChanged() { compositor.refreshRequested() }
  }

  Connections {
    target: Hyprland
    function onFocusedMonitorChanged() { compositor.screenLayoutChanged() }
    function onFocusedWorkspaceChanged() {
      var workspace = Hyprland.focusedWorkspace
      compositor.workspaceFocusChanged(workspace ? workspace.id : null)
      compositor.refreshRequested()
    }
    function onRawEvent(event) {
      if (!event) return
      var name = String(event.name || "")
      if (compositor.refreshEventNames.indexOf(name) < 0) return
      compositor.refreshRequested()

      // Layout-changing events also invalidate the IPC geometry snapshot the
      // workspace miniatures are drawn from; re-request it while open.
      if (compositor.switcherOpen && compositor.geometryEventNames.indexOf(name) >= 0) {
        Hyprland.refreshToplevels()
        compositor.geometryRefreshRequested()
      }
    }
  }

  Connections {
    target: Quickshell
    function onScreensChanged() { compositor.screenLayoutChanged() }
  }

  Connections {
    target: DesktopEntries.applications
    function onValuesChanged() { compositor.refreshRequested() }
  }
}
