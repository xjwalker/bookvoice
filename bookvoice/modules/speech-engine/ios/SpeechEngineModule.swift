import ExpoModulesCore
import AVFoundation

/// Native TTS module that exposes word boundary events from AVSpeechSynthesizer.
/// This lets JS highlight the exact word being spoken in real time.
public class SpeechEngineModule: Module, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var currentText: String = ""
  private var speakResolve: Promise? = nil

  public func definition() -> ModuleDefinition {
    Name("SpeechEngine")

    Events("onWordBoundary", "onSentenceBoundary", "onFinish")

    OnCreate {
      self.synthesizer.delegate = self
    }

    /// Speak text and return a promise that resolves when done.
    AsyncFunction("speak") { (text: String, options: [String: Any], promise: Promise) in
      // Stop any current speech
      if self.synthesizer.isSpeaking {
        self.synthesizer.stopSpeaking(at: .immediate)
      }

      self.currentText = text
      self.speakResolve = promise

      let utterance = AVSpeechUtterance(string: text)
      utterance.rate = Float(options["rate"] as? Double ?? 0.5)
      utterance.pitchMultiplier = Float(options["pitch"] as? Double ?? 1.0)

      if let voiceId = options["voice"] as? String, !voiceId.isEmpty {
        utterance.voice = AVSpeechSynthesisVoice(identifier: voiceId)
      } else if let lang = options["language"] as? String, !lang.isEmpty {
        utterance.voice = AVSpeechSynthesisVoice(language: lang)
      }

      self.synthesizer.speak(utterance)
    }

    Function("stop") {
      self.synthesizer.stopSpeaking(at: .immediate)
    }

    Function("pause") {
      self.synthesizer.pauseSpeaking(at: .word)
    }

    Function("resume") { () -> Bool in
      return self.synthesizer.continueSpeaking()
    }

    Function("isSpeaking") { () -> Bool in
      return self.synthesizer.isSpeaking
    }

    /// Get available voices
    Function("getVoices") { () -> [[String: Any]] in
      return AVSpeechSynthesisVoice.speechVoices().map { voice in
        return [
          "identifier": voice.identifier,
          "name": voice.name,
          "language": voice.language,
          "quality": voice.quality.rawValue,
        ]
      }
    }
  }

  // MARK: - AVSpeechSynthesizerDelegate

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    willSpeakRangeOfSpeechString characterRange: NSRange,
    utterance: AVSpeechUtterance
  ) {
    // Convert character range to word index
    let nsText = currentText as NSString
    let word = nsText.substring(with: characterRange)

    // Count words before this range to get the word index
    let prefix = nsText.substring(to: characterRange.location)
    let wordIndex = prefix.components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }.count

    sendEvent("onWordBoundary", [
      "charStart": characterRange.location,
      "charLength": characterRange.length,
      "word": word,
      "wordIndex": wordIndex,
    ])
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didFinish utterance: AVSpeechUtterance
  ) {
    sendEvent("onFinish", [:])
    speakResolve?.resolve(nil)
    speakResolve = nil
  }

  public func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    didCancel utterance: AVSpeechUtterance
  ) {
    sendEvent("onFinish", ["cancelled": true])
    speakResolve?.resolve(nil)
    speakResolve = nil
  }
}
