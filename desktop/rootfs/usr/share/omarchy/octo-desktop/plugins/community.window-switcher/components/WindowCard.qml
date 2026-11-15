import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

CardFrame {
  id: card

  required property var windowData
  required property bool switcherOpen
  required property bool captureEnabled
  required property string previewMode
  required property int animationMs
  // Position in the most-recently-used order, or -1 where the display order
  // is not recency (the grouped view sorts by workspace).
  property int mruRank: -1

  signal activateRequested()
  signal closeRequested()
  signal hovered()

  readonly property bool previewReady: previewLoader.item && previewLoader.item.hasContent === true

  selectedControl: CloseButton {
    onCloseRequested: card.closeRequested()
  }

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

    Image {
      id: fallbackIcon

      anchors.centerIn: parent
      width: Math.min(parent.width, parent.height) * 0.30
      height: width
      source: card.windowData ? card.windowData.iconSource : ""
      fillMode: Image.PreserveAspectFit
      asynchronous: true
      smooth: true
      opacity: card.previewReady ? 0 : 0.82

      Behavior on opacity { NumberAnimation { duration: 100 } }
    }

    Loader {
      id: previewLoader

      anchors.fill: parent
      active: card.switcherOpen && card.captureEnabled && card.previewMode !== WindowModel.PREVIEW_NONE
        && card.windowData && card.windowData.minimized !== true
      asynchronous: false

      sourceComponent: Item {
        readonly property bool hasContent: captureView.hasContent

        ScreencopyView {
          id: captureView

          readonly property real sourceAspect: sourceSize.height > 0
            ? sourceSize.width / sourceSize.height : 1.6

          anchors.centerIn: parent
          width: Math.min(parent.width, parent.height * sourceAspect)
          height: Math.min(parent.height, parent.width / sourceAspect)
          captureSource: card.switcherOpen && card.windowData ? card.windowData.toplevel : null
          live: card.previewMode === WindowModel.PREVIEW_LIVE_SELECTED && card.selected
          paintCursor: false
          constraintSize: Qt.size(Math.max(1, width), Math.max(1, height))
          visible: hasContent
        }
      }
    }

    Rectangle {
      anchors.fill: parent
      color: "transparent"
      border.width: Style.spacing.hairline
      border.color: Util.alpha(Color.foreground, 0.12)
    }

    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton | Qt.MiddleButton
      cursorShape: Qt.PointingHandCursor
      z: 2
      onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton) card.closeRequested()
        else card.activateRequested()
      }
    }

    Row {
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.margins: Style.spacing.md
      spacing: Style.spacing.xs
      z: 3

      CardBadge {
        visible: card.windowData && card.windowData.workspaceChip ? true : false
        text: card.windowData && card.windowData.workspaceChip ? card.windowData.workspaceChip : ""
        outlined: true
      }

      CardBadge {
        visible: card.windowData && (card.windowData.active || card.windowData.urgent || card.windowData.minimized)
        text: {
          if (!card.windowData) return ""
          if (card.windowData.urgent) return "Urgent"
          if (card.windowData.active) return "Active"
          return "Minimized"
        }
        fillColor: card.windowData && card.windowData.urgent
          ? Util.alpha(Color.urgent, 0.92)
          : Util.alpha(Color.background, 0.84)
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
      acceptedButtons: Qt.LeftButton | Qt.MiddleButton
      cursorShape: Qt.PointingHandCursor
      onClicked: function(mouse) {
        if (mouse.button === Qt.MiddleButton) card.closeRequested()
        else card.activateRequested()
      }
    }

    Image {
      id: appIcon

      anchors.left: parent.left
      anchors.leftMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(34)
      height: width
      source: card.windowData ? card.windowData.iconSource : ""
      fillMode: Image.PreserveAspectFit
      asynchronous: true
      smooth: true
    }

    // The switcher opens on the second-most-recent window, so the top of the
    // order is what a user reaches for blind. Marking the first three states
    // that order without numbering the whole grid.
    Item {
      id: rankSlot

      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.lg
      anchors.verticalCenter: parent.verticalCenter
      width: rankLabel.visible ? rankLabel.implicitWidth : 0
      height: rankLabel.implicitHeight

      Text {
        id: rankLabel

        anchors.centerIn: parent
        visible: card.mruRank >= 0 && card.mruRank < 3
        text: "#" + (card.mruRank + 1)
        color: Util.alpha(Color.menu.text, 0.42)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.weight: Font.DemiBold
      }
    }

    Item {
      anchors {
        left: appIcon.right
        leftMargin: Style.spacing.lg
        right: rankSlot.left
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
        text: card.windowData ? card.windowData.title : ""
        color: card.selected ? Color.menu.selectedText : Color.menu.text
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.weight: card.selected ? Font.DemiBold : Font.Medium
        elide: Text.ElideRight
        maximumLineCount: 1
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
          if (!card.windowData) return ""
          var app = card.windowData.appName || card.windowData.appId || "Application"
          var context = card.windowData.contextLabel || ""
          return context ? app + " · " + context : app
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
