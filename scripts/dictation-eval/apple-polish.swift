// The dictation fix-up on Apple's on-device language model (Foundation Models), for the eval to compare with the Claude
// fix-up the Mac runs. Same instructions and input as packages/core/src/dictation.cjs.
//
//   swiftc -O -parse-as-library apple-polish.swift -o apple-polish
//   echo '{"system": "...", "prompt": "..."}' | apple-polish
//
// Reads one JSON request per line, prints one JSON line per request: {"text": ..., "ms": ...} or {"error": ...}.
import Foundation
import FoundationModels

@Generable
struct Corrected {
  @Guide(description: "The dictated text with only misheard names fixed")
  var text: String
}

@main
struct ApplePolish {
  static func main() async {
    guard case .available = SystemLanguageModel.default.availability else {
      FileHandle.standardError.write("Apple's on-device model isn't available: \(SystemLanguageModel.default.availability)\n".data(using: .utf8)!)
      exit(1)
    }
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let request = try? JSONSerialization.jsonObject(with: data) as? [String: String],
        let system = request["system"], let prompt = request["prompt"]
      else { continue }
      let started = Date()
      var out: [String: Any] = [:]
      do {
        // A session per request: nothing of one message leaks into the next.
        let session = LanguageModelSession(instructions: system)
        let response = try await session.respond(to: prompt, generating: Corrected.self, options: GenerationOptions(temperature: 0))
        out["text"] = response.content.text
      } catch {
        out["error"] = "\(error)"
      }
      out["ms"] = Int(Date().timeIntervalSince(started) * 1000)
      print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
      fflush(stdout)
    }
  }
}
