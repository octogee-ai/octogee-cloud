import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Focusable key surface translating raw keys into switcher intents. The
// layered Escape decision stays with the owner; this is a pure keymap.
Item {
  id: surface

  required property string query
  required property string activationMode
  required property bool releaseArmed
  required property bool editingWorkspaceName

  signal escapePressed()
  signal commitRequested()
  signal stepRequested(int direction)
  signal gridMoveRequested(int horizontal, int vertical)
  signal allFilterRequested()
  signal minimizedToggleRequested()
  signal workspaceOrderToggleRequested()
  signal workspaceRenameRequested()
  signal viewToggleRequested()
  signal groupToggleRequested()
  signal workspaceDigitPressed(int workspaceId)
  signal closeWindowRequested()
  signal queryEdited(string nextQuery)
  signal modifierReleased()

  focus: true

  Keys.enabled: !surface.editingWorkspaceName
  Keys.priority: Keys.BeforeItem
  Keys.onPressed: function(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0

    if (event.key === Qt.Key_Escape) {
      surface.escapePressed()
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      surface.commitRequested()
      event.accepted = true
    } else if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      surface.stepRequested(event.key === Qt.Key_Backtab || shift ? -1 : 1)
      event.accepted = true
    } else if (event.key === Qt.Key_F2) {
      surface.workspaceRenameRequested()
      event.accepted = true
    } else if (event.key === Qt.Key_Left || (ctrl && event.key === Qt.Key_H)) {
      surface.gridMoveRequested(-1, 0)
      event.accepted = true
    } else if (event.key === Qt.Key_Right || (ctrl && event.key === Qt.Key_L)) {
      surface.gridMoveRequested(1, 0)
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) {
      surface.gridMoveRequested(0, -1)
      event.accepted = true
    } else if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) {
      surface.gridMoveRequested(0, 1)
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_A) {
      surface.allFilterRequested()
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_M) {
      surface.minimizedToggleRequested()
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_O) {
      surface.workspaceOrderToggleRequested()
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_W) {
      surface.viewToggleRequested()
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_G) {
      surface.groupToggleRequested()
      event.accepted = true
    } else if (ctrl && event.key >= Qt.Key_0 && event.key <= Qt.Key_9) {
      surface.workspaceDigitPressed(WindowModel.digitWorkspaceId(event.key - Qt.Key_0))
      event.accepted = true
    } else if (ctrl && event.key === Qt.Key_Delete) {
      surface.closeWindowRequested()
      event.accepted = true
    } else if (Util.editsFilter(event, surface.query)) {
      surface.queryEdited(Util.editedFilter(event, surface.query))
      event.accepted = true
    } else if (event.text && event.text.length === 1
        && event.text.charCodeAt(0) >= 32 && event.text.charCodeAt(0) !== 127
        && (event.modifiers === Qt.NoModifier || event.modifiers === Qt.ShiftModifier)) {
      surface.queryEdited(surface.query + event.text)
      event.accepted = true
    }
  }

  Keys.onReleased: function(event) {
    if (surface.activationMode !== WindowModel.ACTIVATION_RELEASE || !surface.releaseArmed) return
    if (event.key === Qt.Key_Alt || event.key === Qt.Key_AltGr
        || event.key === Qt.Key_Meta || event.key === Qt.Key_Super_L
        || event.key === Qt.Key_Super_R) {
      surface.modifierReleased()
      event.accepted = true
    }
  }
}
