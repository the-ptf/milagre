// Apple's on-device dictation on this Mac, set up the way the iPhone build runs it (apps/mobile/patches/@react-native-ai+apple):
// DictationTranscriber with the long-dictation preset and the project's words as contextual strings. The dictation eval
// runs it to score the phone's recognizer without a phone.
//
//   swiftc -O apple-transcribe.swift -o apple-transcribe
//   apple-transcribe <locale> <words-file or -> <wav>...
//
// Prints one JSON line per file: {"file": ..., "text": ..., "ms": ...}.
import AVFoundation
import Foundation
import Speech

@main
struct AppleTranscribe {
  static func supportedLocale(_ identifier: String) async -> Locale? {
    if let locale = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: identifier)) { return locale }
    let code = Locale(identifier: identifier).language.languageCode
    return await DictationTranscriber.supportedLocales.first { $0.language.languageCode == code }
  }

  static func transcribe(_ url: URL, locale: Locale, words: [String]) async throws -> String {
    let transcriber = DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    if !words.isEmpty {
      let context = AnalysisContext()
      context.contextualStrings = [.general: words]
      try await analyzer.setContext(context)
    }
    let collect = Task { () -> [String] in
      var segments: [String] = []
      for try await result in transcriber.results where result.isFinal {
        segments.append(String(result.text.characters))
      }
      return segments
    }
    let file = try AVAudioFile(forReading: url)
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    return try await collect.value.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
  }

  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 4 else {
      FileHandle.standardError.write("usage: apple-transcribe <locale> <words-file|-> <wav>...\n".data(using: .utf8)!)
      exit(2)
    }
    guard let locale = await supportedLocale(args[1]) else {
      FileHandle.standardError.write("Dictation doesn't support \(args[1]) on this Mac.\n".data(using: .utf8)!)
      exit(1)
    }
    var words: [String] = []
    if args[2] != "-", let text = try? String(contentsOfFile: args[2], encoding: .utf8) {
      words = text.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
    }
    do {
      let probe = DictationTranscriber(locale: locale, preset: .timeIndexedLongDictation)
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        try await request.downloadAndInstall()
      }
    } catch {
      FileHandle.standardError.write("Couldn't install dictation assets: \(error)\n".data(using: .utf8)!)
      exit(1)
    }
    for path in args[3...] {
      let started = Date()
      var line: [String: Any] = ["file": path]
      do {
        line["text"] = try await transcribe(URL(fileURLWithPath: path), locale: locale, words: words)
      } catch {
        line["error"] = "\(error)"
      }
      line["ms"] = Int(Date().timeIntervalSince(started) * 1000)
      let data = try! JSONSerialization.data(withJSONObject: line)
      print(String(data: data, encoding: .utf8)!)
      fflush(stdout)
    }
  }
}
