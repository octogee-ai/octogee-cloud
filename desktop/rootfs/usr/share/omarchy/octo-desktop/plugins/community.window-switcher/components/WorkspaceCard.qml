import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

CardFrame {
  id: card

  required property var groupData
  required property var windows
  required property bool focusedWorkspace
  required property bool switcherOpen
  required property bool captureEnabled
  required property string previewMode
  required property int firstWindowIndex
  required property int captureLimit
  required property var workspaceNames
  required property int animationMs
  required property bool renaming

  signal activateRequested()
  signal closeAllRequested()
  signal renameRequested()
  signal renameCommitted(string name)
  signal renameCancelled()
  signal hovered()
  // A miniature stands for exactly one window, at its real place on the
  // workspace. Treating it as scenery and sending every click to the
  // workspace's most recent window throws that away, so each one activates
  // and closes the window it draws.
  signal windowActivateRequested(int windowIndex)
  signal windowCloseRequested(int windowIndex)

  // Local index of the miniature under the pointer, or -1. Owned here rather
  // than by each miniature so the card can name the window in one place
  // instead of fitting a title inside a thumbnail that may be 40px wide.
  property int hoveredWindow: -1

  readonly property var layout: WindowModel.workspaceLayout(windows)
  // The most recent window that is actually drawn; a minimized MRU window
  // must not swallow the liveSelected stream.
  readonly property int liveIndex: WindowModel.firstShownIndex(layout)
  readonly property var captureOrdinals: WindowModel.shownOrdinals(layout)
  readonly property real monitorAspect: {
    for (var i = 0; i < windows.length; i++) {
      var rect = windows[i] && windows[i].monitorRect ? windows[i].monitorRect : null
      if (rect && rect.width > 0 && rect.height > 0) return rect.width / rect.height
    }
    return 16 / 9
  }
  readonly property var frontWindow: windows.length > 0 ? windows[0] : null
  readonly property var hoveredRecord: hoveredWindow >= 0 && hoveredWindow < windows.length
    ? windows[hoveredWindow] : null
  readonly property string workspaceLabel: {
    if (!groupData) return ""
    var alias = WindowModel.workspaceAlias(workspaceNames, groupData.id)
    return alias || String(groupData.defaultLabel || groupData.label || "")
  }

  selectedControl: CloseButton {
    requireConfirm: true
    pendingCount: card.groupData && card.groupData.totalSize !== undefined
      ? card.groupData.totalSize : card.windows.length
    onCloseRequested: card.closeAllRequested()
  }

  function handlePointerClick(button) {
    if (button === Qt.RightButton) renameRequested()
    else activateRequested()
  }

  // Delegates survive between summons, so a pointer that was over a miniature
  // when the overlay closed must not name that window on the way back in.
  onSwitcherOpenChanged: if (!switcherOpen) hoveredWindow = -1

  HoverHandler {
    cursorShape: Qt.PointingHandCursor
    onHoveredChanged: if (hovered) card.hovered()
  }

  Item {
    id: previewFrame

    anchors {
      top: parent.top
      left: parent.left
      right: parent.right
      bottom: metadata.top
    }
    anchors.margins: card.contentInset
    clip: true

    Rectangle {
      anchors.fill: parent
      color: Qt.darker(Color.menu.background, 1.18)
    }

    MouseArea {
      // The bare canvas around the miniatures still stands for the
      // workspace as a whole.
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      enabled: !card.renaming
      cursorShape: Qt.PointingHandCursor
      z: 50
      onClicked: function(mouse) { card.handlePointerClick(mouse.button) }
    }

    // The workspace canvas keeps the monitor's aspect ratio; each window is
    // drawn at its real position and size, most recently used on top. It
    // sits above the canvas click area so the miniatures can take their own
    // pointer events.
    Item {
      id: workspaceSurface

      anchors.centerIn: parent
      width: Math.min(parent.width, parent.height * card.monitorAspect)
      height: Math.min(parent.height, parent.width / card.monitorAspect)
      z: 55

      Rectangle {
        anchors.fill: parent
        color: Qt.darker(Color.menu.background, 1.32)
        border.width: Style.spacing.hairline
        border.color: Util.alpha(Color.foreground, 0.10)
      }

      Repeater {
        model: card.windows.length

        delegate: Item {
          id: miniWindow

          required property int index
          readonly property var windowData: card.windows[index]
          readonly property var cell: index < card.layout.length ? card.layout[index] : null
          readonly property bool shown: cell !== null && cell.hidden !== true
          readonly property bool pointed: card.hoveredWindow === index
          // The capture budget counts windows, not cards: unselected cards
          // share the global first-N budget by flat window index, and the
          // selected card may capture at most that budget on its own. The
          // selected card budgets by drawn-miniature ordinal so hidden
          // windows cannot starve the liveSelected target of its slot.
          readonly property int shownOrdinal: index < card.captureOrdinals.length ? card.captureOrdinals[index] : -1
          readonly property bool captureAllowed: shown && (card.selected
            ? shownOrdinal >= 0 && shownOrdinal < card.captureLimit
            : card.firstWindowIndex + index < card.captureLimit)
          visible: shown
          x: cell ? cell.x * workspaceSurface.width : 0
          y: cell ? cell.y * workspaceSurface.height : 0
          width: cell ? Math.max(1, cell.width * workspaceSurface.width) : 1
          height: cell ? Math.max(1, cell.height * workspaceSurface.height) : 1
          z: pointed ? card.windows.length + 1 : card.windows.length - index

          Rectangle {
            anchors.fill: parent
            color: Qt.darker(Color.menu.background, 1.08)
            border.width: miniWindow.pointed
              ? Math.max(1, Style.spacing.hairline * 2) : Style.spacing.hairline
            border.color: miniWindow.pointed ? Color.accent : Util.alpha(Color.foreground, 0.22)
          }

          ScreencopyView {
            id: miniCapture

            anchors.fill: parent
            anchors.margins: Style.spacing.hairline
            captureSource: card.switcherOpen && card.captureEnabled && miniWindow.captureAllowed
              && miniWindow.windowData ? miniWindow.windowData.toplevel : null
            live: card.previewMode === WindowModel.PREVIEW_LIVE_SELECTED
              && card.selected && miniWindow.index === card.liveIndex
            paintCursor: false
            constraintSize: Qt.size(Math.max(1, width), Math.max(1, height))
            visible: hasContent
          }

          Image {
            anchors.centerIn: parent
            width: Math.max(8, Math.min(parent.width, parent.height) * 0.4)
            height: width
            source: miniWindow.windowData ? miniWindow.windowData.iconSource : ""
            fillMode: Image.PreserveAspectFit
            asynchronous: true
            smooth: true
            visible: !miniCapture.hasContent
            opacity: 0.75
          }

          Rectangle {
            // A successful capture used to remove the only cue to what the
            // window is, which on a workspace of terminals leaves six
            // identical grey rectangles. The icon stays on top of the
            // capture, and stands down only where the miniature is too
            // small to carry it.
            visible: miniCapture.hasContent
              && miniWindow.width >= Style.space(46)
              && miniWindow.height >= Style.space(34)
            anchors.left: parent.left
            anchors.bottom: parent.bottom
            anchors.margins: Style.spacing.xs
            width: Style.space(18)
            height: width
            radius: Math.min(Style.cornerRadius, Math.round(height / 3))
            color: Util.alpha(Color.background, 0.78)
            border.width: Math.max(1, Style.spacing.hairline)
            border.color: Util.alpha(Color.foreground, 0.22)

            Image {
              anchors.centerIn: parent
              width: parent.width - Style.spacing.sm
              height: width
              source: miniWindow.windowData ? miniWindow.windowData.iconSource : ""
              fillMode: Image.PreserveAspectFit
              asynchronous: true
              smooth: true
            }
          }

          Rectangle {
            anchors.fill: parent
            visible: miniWindow.pointed
            color: Util.alpha(Color.accent, 0.16)
          }

          MouseArea {
            anchors.fill: parent
            enabled: !card.renaming
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton | Qt.MiddleButton
            cursorShape: Qt.PointingHandCursor
            onContainsMouseChanged: {
              if (containsMouse) {
                card.hoveredWindow = miniWindow.index
                // The card's own hover handler stops firing once a
                // miniature takes the hover, so selection is re-asserted
                // here or the pointer would stop choosing cards. Crossing
                // between miniatures of the selected card asks for nothing,
                // so it does not re-run the reveal.
                if (!card.selected) card.hovered()
              } else if (card.hoveredWindow === miniWindow.index) {
                card.hoveredWindow = -1
              }
            }
            onClicked: function(mouse) {
              if (mouse.button === Qt.MiddleButton) card.windowCloseRequested(miniWindow.index)
              else card.windowActivateRequested(miniWindow.index)
            }
          }
        }
      }
    }

    // The name of the window under the pointer, in one fixed place. A
    // per-miniature label would have to fit inside a thumbnail that is often
    // narrower than a single word.
    Rectangle {
      id: hoverBand

      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      height: Style.space(26)
      visible: card.hoveredRecord !== null && !card.renaming
      color: Util.alpha(Color.background, 0.92)
      z: 58

      Image {
        id: hoverIcon

        anchors.left: parent.left
        anchors.leftMargin: Style.spacing.lg
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(16)
        height: width
        source: card.hoveredRecord ? card.hoveredRecord.iconSource : ""
        fillMode: Image.PreserveAspectFit
        asynchronous: true
        smooth: true
      }

      Text {
        anchors.left: hoverIcon.right
        anchors.leftMargin: Style.spacing.md
        anchors.right: parent.right
        anchors.rightMargin: Style.spacing.lg
        anchors.verticalCenter: parent.verticalCenter
        text: card.hoveredRecord ? card.hoveredRecord.title : ""
        color: Color.menu.text
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }
    }

  }

  Item {
    id: metadata

    anchors {
      left: parent.left
      right: parent.right
      bottom: parent.bottom
    }
    height: Style.space(68)

    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      enabled: !card.renaming
      cursorShape: Qt.PointingHandCursor
      onClicked: function(mouse) { card.handlePointerClick(mouse.button) }
    }

    Rectangle {
      id: numberChip

      anchors.left: parent.left
      anchors.leftMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      // Named workspaces (specials like "minimized") widen the chip to fit
      // their full name instead of truncating to two letters.
      width: Math.max(Style.space(34), numberChipLabel.implicitWidth + Style.spacing.controlPaddingX * 2)
      height: Style.space(34)
      radius: Style.cornerRadius
      color: Util.alpha(Color.accent, card.selected ? 0.28 : 0.14)
      border.width: Math.max(1, Style.spacing.hairline)
      border.color: Util.alpha(Color.accent, 0.55)

      Text {
        id: numberChipLabel

        anchors.centerIn: parent
        text: {
          if (!card.groupData) return ""
          if (card.groupData.key === WindowModel.NO_WORKSPACE_KEY) return "·"
          var id = Number(card.groupData.id)
          return isFinite(id) && id >= 0 ? String(id) : String(card.groupData.label)
        }
        color: card.selected ? Color.menu.selectedText : Color.menu.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.weight: Font.DemiBold
      }
    }

    // The focused-workspace marker belongs on the label bar, not floating
    // over a window preview beside the close button, where two unrelated
    // overlays competed for the same corner.
    Item {
      id: currentSlot

      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      width: currentBadge.visible ? currentBadge.width : 0
      height: currentBadge.height

      CardBadge {
        id: currentBadge

        anchors.centerIn: parent
        visible: card.focusedWorkspace
        text: "Current"
        outlined: true
      }
    }

    Item {
      id: labelBlock

      anchors {
        left: numberChip.right
        leftMargin: Style.spacing.lg
        right: currentSlot.left
        rightMargin: Style.spacing.lg
        verticalCenter: parent.verticalCenter
      }
      height: titleLabel.implicitHeight + contextLabel.implicitHeight + Style.spacing.xs

      Text {
        id: titleLabel

        anchors {
          top: parent.top
          left: parent.left
          right: parent.right
        }
        text: card.workspaceLabel
        visible: !card.renaming
        color: card.selected ? Color.menu.selectedText : Color.menu.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.weight: card.selected ? Font.DemiBold : Font.Medium
        elide: Text.ElideRight
        maximumLineCount: 1
      }

      TextInput {
        id: nameEditor

        anchors {
          top: parent.top
          left: parent.left
          right: parent.right
        }
        visible: card.renaming
        color: card.selected ? Color.menu.selectedText : Color.menu.text
        selectionColor: Util.alpha(Color.accent, 0.45)
        selectedTextColor: Color.menu.selectedText
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.weight: Font.DemiBold
        maximumLength: 48
        selectByMouse: true
        clip: true

        onVisibleChanged: {
          if (!visible) return
          text = card.workspaceLabel
          Qt.callLater(function() {
            if (!card.renaming) return
            nameEditor.forceActiveFocus()
            nameEditor.selectAll()
          })
        }

        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
            card.renameCommitted(nameEditor.text)
            event.accepted = true
          } else if (event.key === Qt.Key_Escape) {
            card.renameCancelled()
            event.accepted = true
          }
        }

        Rectangle {
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          height: Math.max(1, Style.spacing.hairline)
          color: Color.accent
        }
      }

      Text {
        id: contextLabel

        anchors {
          top: titleLabel.bottom
          topMargin: Style.spacing.xs
          left: parent.left
          right: parent.right
        }
        text: {
          var count = card.windows.length
          var total = card.groupData && card.groupData.totalSize !== undefined
            ? card.groupData.totalSize : count
          var result = count === total
            ? count + (count === 1 ? " window" : " windows")
            : count + " of " + total + " windows"
          var monitor = card.frontWindow && card.frontWindow.monitorName ? card.frontWindow.monitorName : ""
          return monitor ? result + " · " + monitor : result
        }
        color: Util.alpha(Color.menu.text, 0.68)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
        maximumLineCount: 1
      }
    }
  }
}
