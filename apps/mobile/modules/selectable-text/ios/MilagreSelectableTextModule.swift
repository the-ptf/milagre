import ExpoModulesCore
import UIKit

struct SelectionSpan: Record {
  @Field var text: String = ""
  @Field var bold: Bool = false
  @Field var italic: Bool = false
  @Field var strike: Bool = false
  @Field var code: Bool = false
  @Field var link: Bool = false
}

struct SelectionParagraph: Record {
  /// body, heading or code.
  @Field var kind: String = "body"
  /// Points a heading adds to the body size.
  @Field var grow: Double = 0
  /// The enclosing list items' markers, outermost first.
  @Field var markers: [String] = []
  @Field var showMarker: Bool = false
  @Field var quote: Int = 0
  @Field var spaceBefore: Double = 0
  @Field var spans: [SelectionSpan] = []
}

struct SelectionLook: Record {
  @Field var fontSize: Double = 15
  @Field var lineHeight: Double = 22
  @Field var codeSize: Double = 13
  @Field var ink: UIColor = .label
  @Field var accent: UIColor = .systemBlue
  @Field var codeBackground: UIColor = .secondarySystemBackground
  @Field var selection: UIColor = .systemBlue
}

/// Where the long press landed, in window coordinates.
struct SelectionPoint: Record {
  @Field var x: Double = 0
  @Field var y: Double = 0
}

public final class MilagreSelectableTextModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MilagreSelectableText")

    View(MilagreSelectableTextView.self) {
      Events("onContentHeight", "onAsk", "onEnd")

      Prop("paragraphs") { (view: MilagreSelectableTextView, value: [SelectionParagraph]) in
        view.paragraphs = value
      }
      Prop("look") { (view: MilagreSelectableTextView, value: SelectionLook) in
        view.look = value
      }
      Prop("start") { (view: MilagreSelectableTextView, value: SelectionPoint?) in
        view.start = value.map { CGPoint(x: $0.x, y: $0.y) }
      }
      /// The title of the menu action that quotes the selection in the composer; empty leaves it out.
      Prop("askTitle") { (view: MilagreSelectableTextView, value: String?) in
        view.askTitle = value ?? ""
      }

      OnViewDidUpdateProps { (view: MilagreSelectableTextView) in
        view.propsChanged()
      }
    }
  }
}
