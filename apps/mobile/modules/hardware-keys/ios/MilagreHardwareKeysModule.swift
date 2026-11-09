import ExpoModulesCore
import UIKit

struct Shortcut: Record {
  @Field var id: String = ""
  @Field var input: String = ""
  @Field var title: String = ""
  @Field var modifiers: [String] = []
}

public final class MilagreHardwareKeysModule: Module {
  private let inputs = NSMapTable<NSNumber, UIView>(keyOptions: .strongMemory, valueOptions: .weakMemory)
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("MilagreHardwareKeys")
    Events("returnKey", "shortcut")

    OnCreate {
      self.observer = NotificationCenter.default.addObserver(forName: .MilagreShortcut, object: nil, queue: .main) { [weak self] note in
        guard let id = note.userInfo?["id"] as? String else { return }
        self?.sendEvent("shortcut", ["id": id])
      }
    }

    AsyncFunction("attachReturnAsync") { (tag: Int) -> Bool in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self) else { return false }
      let attached = MilagreAttachReturn(view) { [weak self] in
        self?.sendEvent("returnKey", ["target": tag])
      }
      if attached { self.inputs.setObject(view, forKey: NSNumber(value: tag)) }
      return attached
    }.runOnQueue(.main)

    AsyncFunction("detachReturnAsync") { (tag: Int) in
      if let view = self.inputs.object(forKey: NSNumber(value: tag)) { MilagreDetachReturn(view) }
      self.inputs.removeObject(forKey: NSNumber(value: tag))
    }.runOnQueue(.main)

    AsyncFunction("setShortcutsAsync") { (list: [Shortcut]) in
      MilagreSetShortcuts(list.map { item in
        let command = UIKeyCommand(
          title: item.title,
          // Answered by every responder (MilagreKeysHook.m), whatever holds focus.
          action: Selector(("milagre_shortcut:")),
          input: item.input,
          modifierFlags: Self.flags(item.modifiers),
          propertyList: item.id
        )
        command.wantsPriorityOverSystemBehavior = true
        return command
      })
    }.runOnQueue(.main)

    OnDestroy {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      DispatchQueue.main.async { [inputs = self.inputs] in
        MilagreSetShortcuts([])
        for view in inputs.objectEnumerator()?.allObjects as? [UIView] ?? [] { MilagreDetachReturn(view) }
        inputs.removeAllObjects()
      }
    }
  }

  private static func flags(_ names: [String]) -> UIKeyModifierFlags {
    var flags: UIKeyModifierFlags = []
    for name in names {
      switch name {
      case "command": flags.insert(.command)
      case "shift": flags.insert(.shift)
      case "alt": flags.insert(.alternate)
      case "control": flags.insert(.control)
      default: break
      }
    }
    return flags
  }
}
