import ExpoModulesCore
import UIKit

/**
 A message, formatted as the Chat draws it, in a read-only text view that selects across all of it. React Native swaps
 it in where a long press landed: it selects the word under the finger, shows the system edit menu with Ask first, and
 lets the handles run across paragraphs, lists and code. It ends (onEnd) once the selection is gone: a tap outside it,
 a tap that collapses it, or Ask.
 */
final class MilagreSelectableTextView: ExpoView, UITextViewDelegate, UIEditMenuInteractionDelegate, UIGestureRecognizerDelegate {
  let onContentHeight = EventDispatcher()
  let onAsk = EventDispatcher()
  let onEnd = EventDispatcher()

  var paragraphs: [SelectionParagraph] = [] { didSet { dirty = true } }
  var look = SelectionLook() { didSet { dirty = true } }
  var start: CGPoint?
  var askTitle = ""

  // TextKit 1, as React Native lays out its Text: lines get the same heights, so the word under the finger stays put.
  private let textView = UITextView(usingTextLayoutManager: false)
  private lazy var ownMenu = UIEditMenuInteraction(delegate: self)
  private lazy var outsideTap: UITapGestureRecognizer = {
    let tap = UITapGestureRecognizer(target: self, action: #selector(tappedOutside(_:)))
    tap.cancelsTouchesInView = false
    tap.delegate = self
    return tap
  }()
  private var dirty = true
  private var began = false
  private var beginning = false
  private var ended = false
  private var reportedHeight: CGFloat = -1
  private var menuTarget = CGRect.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.backgroundColor = .clear
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.dataDetectorTypes = []
    textView.delegate = self
    textView.addInteraction(ownMenu)
    addSubview(textView)
  }

  func propsChanged() {
    if dirty {
      dirty = false
      textView.attributedText = attributedText()
      textView.tintColor = look.selection
      reportedHeight = -1
    }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let width = bounds.width
    guard width > 0 else { return }
    let height = ceil(textView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    textView.frame = CGRect(x: 0, y: 0, width: width, height: height)
    if abs(height - reportedHeight) > 0.5 {
      reportedHeight = height
      onContentHeight(["height": height])
    }
    if !began && window != nil && textView.attributedText.length > 0 {
      began = true
      DispatchQueue.main.async { [weak self] in self?.begin() }
    }
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    if newWindow == nil { outsideTap.view?.removeGestureRecognizer(outsideTap) }
  }

  // MARK: - Selection

  private func begin() {
    guard let window, !ended else { return }
    beginning = true
    textView.becomeFirstResponder()
    var range: UITextRange?
    if let start {
      let point = textView.convert(start, from: window)
      if let position = textView.closestPosition(to: point) {
        let tokenizer = textView.tokenizer
        range = tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.forward))
          ?? tokenizer.rangeEnclosingPosition(position, with: .word, inDirection: .storage(.backward))
          ?? tokenizer.rangeEnclosingPosition(position, with: .paragraph, inDirection: .storage(.forward))
      }
    }
    textView.selectedTextRange = range ?? textView.textRange(from: textView.beginningOfDocument, to: textView.endOfDocument)
    beginning = false
    window.addGestureRecognizer(outsideTap)
    // The text view sets up its own edit menu once it is first responder, and a menu shown while the long press's finger
    // is still down closes when it lifts: show it once the press has settled.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in self?.presentMenu() }
  }

  private func presentMenu() {
    guard !ended, let range = textView.selectedTextRange, !range.isEmpty else { return }
    let rects = textView.selectionRects(for: range).map(\.rect).filter { !$0.isEmpty && $0.width.isFinite }
    guard let first = rects.first else { return }
    menuTarget = rects.dropFirst().reduce(first) { $0.union($1) }
    ownMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: menuTarget.midX, y: menuTarget.minY)))
  }

  private func finish() {
    guard !ended else { return }
    ended = true
    outsideTap.view?.removeGestureRecognizer(outsideTap)
    if textView.isFirstResponder { textView.resignFirstResponder() }
    onEnd([:])
  }

  private func askAction() -> UIAction? {
    guard !askTitle.isEmpty else { return nil }
    return UIAction(title: askTitle, image: UIImage(systemName: "text.bubble")) { [weak self] _ in
      guard let self, let range = self.textView.selectedTextRange, let text = self.textView.text(in: range), !text.isEmpty else { return }
      self.onAsk(["text": text])
      self.finish()
    }
  }

  private func menu(with suggested: [UIMenuElement]) -> UIMenu {
    UIMenu(children: (askAction().map { [$0] } ?? []) + suggested)
  }

  func textViewDidChangeSelection(_ textView: UITextView) {
    if began && !beginning && !ended && textView.selectedRange.length == 0 { finish() }
  }

  func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
    menu(with: suggestedActions)
  }

  func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
    menu(with: suggestedActions)
  }

  func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
    menuTarget
  }

  @objc private func tappedOutside(_ gesture: UITapGestureRecognizer) {
    if !textView.bounds.contains(gesture.location(in: textView)) { finish() }
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    // Taps on the text (handles included) and on the edit menu keep the selection.
    var view = touch.view
    while let current = view {
      if current === textView { return false }
      if String(describing: type(of: current)).contains("Menu") { return false }
      view = current.superview
    }
    return true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }

  // MARK: - Text

  private func attributedText() -> NSAttributedString {
    let out = NSMutableAttributedString()
    let fontSize = CGFloat(look.fontSize)
    let codeSize = CGFloat(look.codeSize)
    // React Native scales both font sizes and explicit line heights with this multiplier. Scale after rounding
    // the unscaled line height, just as Text does; margins, list gaps and quote padding remain in layout points.
    let scale = CGFloat(look.fontScale)
    let body = UIFont.systemFont(ofSize: fontSize * scale)
    for (index, paragraph) in paragraphs.enumerated() {
      let kind = paragraph.kind
      let size = (kind == "code" ? codeSize + 1 : fontSize + CGFloat(paragraph.grow)) * scale
      let lineHeight = (kind == "code" ? round((codeSize + 1) * 1.5) : kind == "heading" ? round(fontSize * 1.5) : CGFloat(look.lineHeight)) * scale
      let fonts = paragraph.spans.map { font(for: $0, kind: kind, size: size, scale: scale) }
      // All runs in a React Native Text share a baseline, including inline code with different font metrics.
      let tallest = fonts.map(\.lineHeight).max() ?? body.lineHeight
      let baseline = max(0, (lineHeight - (paragraph.showMarker ? max(tallest, body.lineHeight) : tallest)) / 2)
      // Blockquotes sit after a 3pt rule and 14pt of padding; each list level after its marker and a 10pt gap.
      var indent = CGFloat(paragraph.quote) * 17
      var markerIndent = indent
      for marker in paragraph.markers {
        markerIndent = indent
        indent += ceil((marker as NSString).size(withAttributes: [.font: body]).width) + 10
      }
      let first = out.length
      if paragraph.showMarker, let marker = paragraph.markers.last {
        out.append(NSAttributedString(string: marker + "\t", attributes: attributes(font: body, baseline: baseline)))
      }
      for (span, font) in zip(paragraph.spans, fonts) {
        out.append(NSAttributedString(string: span.text, attributes: attributes(for: span, kind: kind, font: font, baseline: baseline)))
      }
      if index < paragraphs.count - 1 {
        out.append(NSAttributedString(string: "\n", attributes: attributes(font: fonts.last ?? body, baseline: baseline)))
      }
      // A line break inside the paragraph starts a new text paragraph without the gap or the marker.
      var firstLine = true
      (out.string as NSString).enumerateSubstrings(in: NSRange(location: first, length: out.length - first), options: [.byParagraphs, .substringNotRequired]) { _, _, enclosing, _ in
        let style = NSMutableParagraphStyle()
        style.minimumLineHeight = lineHeight
        style.maximumLineHeight = lineHeight
        style.headIndent = indent
        style.firstLineHeadIndent = firstLine && paragraph.showMarker ? markerIndent : indent
        style.paragraphSpacingBefore = firstLine ? CGFloat(paragraph.spaceBefore) : 0
        style.tabStops = paragraph.showMarker ? [NSTextTab(textAlignment: .natural, location: indent)] : []
        style.defaultTabInterval = paragraph.showMarker ? 0 : 28
        out.addAttribute(.paragraphStyle, value: style, range: enclosing)
        firstLine = false
      }
    }
    return out
  }

  private func attributes(font: UIFont, baseline: CGFloat) -> [NSAttributedString.Key: Any] {
    [.font: font, .foregroundColor: look.ink, .baselineOffset: baseline]
  }

  private func font(for span: SelectionSpan, kind: String, size: CGFloat, scale: CGFloat) -> UIFont {
    var font: UIFont
    if kind == "code" || span.code {
      let codeSize = kind == "code" ? size : (CGFloat(look.codeSize) + 1.5) * scale
      font = UIFont(name: look.codeFontFamily, size: codeSize) ?? .monospacedSystemFont(ofSize: codeSize, weight: .regular)
      if span.bold, let bold = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitBold)) {
        font = UIFont(descriptor: bold, size: font.pointSize)
      }
    } else {
      font = .systemFont(ofSize: size, weight: span.bold ? .semibold : .regular)
    }
    if span.italic, let italic = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
      font = UIFont(descriptor: italic, size: font.pointSize)
    }
    return font
  }

  private func attributes(for span: SelectionSpan, kind: String, font: UIFont, baseline: CGFloat) -> [NSAttributedString.Key: Any] {
    var result = attributes(font: font, baseline: baseline)
    if kind == "code" || span.code { result[.backgroundColor] = look.codeBackground }
    if span.link {
      result[.foregroundColor] = look.accent
      result[.underlineStyle] = NSUnderlineStyle.single.rawValue
    }
    if span.strike { result[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    return result
  }
}
