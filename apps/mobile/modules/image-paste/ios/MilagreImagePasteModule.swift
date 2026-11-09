import ExpoModulesCore
import UIKit

public final class MilagreImagePasteModule: Module {
  private let inputs = NSMapTable<NSNumber, UIView>(keyOptions: .strongMemory, valueOptions: .weakMemory)

  public func definition() -> ModuleDefinition {
    Name("MilagreImagePaste")
    Events("imagePaste")

    AsyncFunction("attachAsync") { (tag: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self) else { return false }
      let attached = MilagreAttachPaste(view) { [weak self] image in
        self?.paste(image, tag: tag)
      }
      if attached { self.inputs.setObject(view, forKey: NSNumber(value: tag)) }
      return attached
    }.runOnQueue(.main)

    AsyncFunction("detachAsync") { (tag: Int) in
      if let view = self.inputs.object(forKey: NSNumber(value: tag)) { MilagreDetachPaste(view) }
      self.inputs.removeObject(forKey: NSNumber(value: tag))
    }.runOnQueue(.main)

    OnDestroy {
      DispatchQueue.main.async { [inputs = self.inputs] in
        for view in inputs.objectEnumerator()?.allObjects as? [UIView] ?? [] { MilagreDetachPaste(view) }
        inputs.removeAllObjects()
      }
    }
  }

  private func paste(_ image: UIImage?, tag: Int) {
    guard let image else {
      sendEvent("imagePaste", ["target": tag, "uri": "", "width": 0, "height": 0,
                              "error": "Could not paste the image. Allow paste access, or attach it from Photo Library or Files."])
      return
    }
    // Resize before PNG encoding so clipboard screenshots never cross the JS bridge as large byte arrays.
    let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
    let ratio = min(1, 2048 / max(pixels.width, pixels.height))
    let size = CGSize(width: pixels.width * ratio, height: pixels.height * ratio)
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    let file = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("milagre-paste-\(UUID().uuidString).png")
    do {
      guard let data = scaled.pngData() else { throw NSError(domain: "MilagreImagePaste", code: 1) }
      try data.write(to: file, options: .atomic)
      sendEvent("imagePaste", ["target": tag, "uri": file.absoluteString, "width": scaled.size.width, "height": scaled.size.height])
    } catch {
      try? FileManager.default.removeItem(at: file)
      sendEvent("imagePaste", ["target": tag, "uri": "", "width": 0, "height": 0,
                              "error": "Could not prepare the pasted image. Try Photo Library instead."])
    }
  }
}
