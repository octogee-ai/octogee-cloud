import QtQuick
import QtQuick.Layouts
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Switcher header: title and search box on the left, the view controls and
// count pinned to the right edge, and the full-width filter pills below. The
// split is by class, not by convenience — the right edge holds the controls
// that decide what the list may contain, the row below holds the ones that
// pick which part of it to show.
ColumnLayout {
  id: header

  required property var pillRows
  required property var activeFilter
  required property bool showMinimized
  required property int minimizedCount
  required property string viewMode
  required property string workspaceOrder
  required property int workspaceNameCount
  required property string countText
  required property string query
  required property bool switcherOpen

  signal allPicked()
  signal queryCleared()
  signal minimizedToggleRequested()
  signal workspaceOrderRequested(string order)
  signal workspaceNamesResetRequested()
  signal workspaceToggled(var workspaceId)
  signal workspaceCloseRequested(var workspaceId)
  signal windowsViewRequested()
  signal workspacesViewRequested()

  spacing: Style.spacing.md

  // Anchors instead of nested layouts: the right cluster stays glued to the
  // right edge no matter how the search box sizes itself.
  Item {
    Layout.fillWidth: true
    implicitHeight: Math.max(titleBlock.implicitHeight, rightCluster.implicitHeight)

    Column {
      id: titleBlock

      anchors.left: parent.left
      anchors.right: rightCluster.left
      anchors.rightMargin: Style.spacing.controlGap
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.xs

      Text {
        text: "Switch windows"
        color: Color.menu.text
        font.family: Style.font.family
        font.pixelSize: Style.font.title
        font.weight: Font.DemiBold
      }

      // The switcher has no focusable text field — the key surface owns every
      // keystroke — so this box has to be honest about being live rather than
      // merely looking like an input. A caret that blinks while the switcher
      // is open says "typing lands here", and a clear button gives the query
      // the same way out with the mouse that Escape gives with the keyboard.
      Rectangle {
        width: Math.max(1, Math.min(Style.space(420), titleBlock.width))
        height: Style.spacing.controlHeight
        radius: Style.cornerRadius
        color: Style.normalFill
        border.width: Style.normalBorderWidth
        border.color: header.query ? Color.accent : Style.normalBorderColor

        Item {
          anchors.fill: parent
          anchors.leftMargin: Style.spacing.controlPaddingX
          anchors.rightMargin: Style.spacing.controlPaddingX

          MouseArea {
            // Cursor only. The field never takes a click because it never
            // loses focus in the first place.
            anchors.fill: parent
            acceptedButtons: Qt.NoButton
            hoverEnabled: true
            cursorShape: Qt.IBeamCursor
          }

          Text {
            id: searchPrefix

            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "/"
            color: header.query ? Color.accent : Util.alpha(Color.menu.text, 0.45)
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }

          Text {
            id: queryText

            anchors.left: searchPrefix.right
            anchors.leftMargin: Style.spacing.xs
            anchors.verticalCenter: parent.verticalCenter
            // Elided from the left: a long query is edited at its tail, and
            // the tail is the part that just changed.
            width: Math.min(implicitWidth,
              Math.max(0, clearButton.x - x - caret.width - Style.spacing.md))
            text: header.query
            color: Color.menu.text
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            elide: Text.ElideLeft
          }

          Rectangle {
            id: caret

            anchors.left: queryText.right
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(1, Style.spacing.hairline * 2)
            height: Math.round(Style.font.body * 1.2)
            color: Color.accent

            SequentialAnimation on opacity {
              // Stops with the overlay: this plugin stays loaded between
              // summons and must not animate anything while it is closed.
              running: header.switcherOpen
              loops: Animation.Infinite
              NumberAnimation { to: 0.15; duration: 460; easing.type: Easing.InOutQuad }
              NumberAnimation { to: 1.0; duration: 460; easing.type: Easing.InOutQuad }
            }
          }

          Text {
            anchors.left: caret.right
            anchors.leftMargin: Style.spacing.xs
            anchors.right: clearButton.left
            anchors.rightMargin: Style.spacing.xs
            anchors.verticalCenter: parent.verticalCenter
            visible: !header.query
            text: "Type to filter by application or title"
            color: Util.alpha(Color.menu.text, 0.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            elide: Text.ElideRight
          }

          Item {
            id: clearButton

            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            visible: header.query.length > 0
            width: visible ? Style.space(16) : 0
            height: Style.space(16)

            Text {
              anchors.centerIn: parent
              text: "×"
              color: clearArea.containsMouse ? Color.menu.text : Util.alpha(Color.menu.text, 0.5)
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              font.weight: Font.Bold
            }

            MouseArea {
              id: clearArea

              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: header.queryCleared()
            }
          }
        }
      }
    }

    Row {
      id: rightCluster

      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.controlGap

      MinimizedToggle {
        // A session with nothing minimized has nothing for this to do, so it
        // stays out of the way entirely rather than sitting there inert.
        visible: header.minimizedCount > 0
        anchors.verticalCenter: parent.verticalCenter
        showMinimized: header.showMinimized
        onToggleRequested: header.minimizedToggleRequested()
      }

      WorkspaceNamesReset {
        visible: header.viewMode === WindowModel.VIEW_WORKSPACES
          && header.workspaceNameCount > 0
        anchors.verticalCenter: parent.verticalCenter
        nameCount: header.workspaceNameCount
        onResetRequested: header.workspaceNamesResetRequested()
      }

      WorkspaceOrderToggle {
        visible: header.viewMode !== WindowModel.VIEW_WINDOWS
        anchors.verticalCenter: parent.verticalCenter
        workspaceOrder: header.workspaceOrder
        onRecentRequested: header.workspaceOrderRequested(WindowModel.WORKSPACE_ORDER_RECENT)
        onNumberRequested: header.workspaceOrderRequested(WindowModel.WORKSPACE_ORDER_NUMBER)
      }

      ViewToggle {
        anchors.verticalCenter: parent.verticalCenter
        viewMode: header.viewMode
        onWindowsRequested: header.windowsViewRequested()
        onWorkspacesRequested: header.workspacesViewRequested()
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: header.countText
        color: Util.alpha(Color.menu.text, 0.64)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }
  }

  Flow {
    Layout.fillWidth: true
    spacing: Style.spacing.controlGap

    Repeater {
      model: header.pillRows

      delegate: FilterPill {
        activeFilter: header.activeFilter
        onAllPicked: header.allPicked()
        onWorkspaceToggled: function(workspaceId) { header.workspaceToggled(workspaceId) }
        onCloseAllRequested: function(workspaceId) { header.workspaceCloseRequested(workspaceId) }
      }
    }
  }
}
