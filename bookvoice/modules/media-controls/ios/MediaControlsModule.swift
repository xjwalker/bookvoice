import ExpoModulesCore
import MediaPlayer
import AVFoundation

public class MediaControlsModule: Module {
  private var commandsEnabled = false

  public func definition() -> ModuleDefinition {
    Name("MediaControls")

    Events("onRemoteCommand")

    OnCreate {
      // Configure audio session for background playback
      let session = AVAudioSession.sharedInstance()
      try? session.setCategory(.playback, mode: .spokenAudio, options: [])
      try? session.setActive(true)
    }

    Function("updateNowPlaying") { (info: [String: Any]) in
      var nowPlayingInfo = [String: Any]()
      nowPlayingInfo[MPMediaItemPropertyTitle] = info["title"] as? String ?? ""
      nowPlayingInfo[MPMediaItemPropertyArtist] = info["artist"] as? String ?? ""
      nowPlayingInfo[MPMediaItemPropertyAlbumTitle] = info["album"] as? String ?? ""
      nowPlayingInfo[MPMediaItemPropertyPlaybackDuration] = info["duration"] as? Double ?? 0
      nowPlayingInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = info["elapsedTime"] as? Double ?? 0
      nowPlayingInfo[MPNowPlayingInfoPropertyPlaybackRate] = info["rate"] as? Double ?? 1.0

      MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlayingInfo
    }

    Function("setPlaybackState") { (isPlaying: Bool) in
      var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
      info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
      MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    Function("enableCommands") {
      guard !self.commandsEnabled else { return }
      self.commandsEnabled = true

      let center = MPRemoteCommandCenter.shared()

      center.playCommand.isEnabled = true
      center.playCommand.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "play"])
        return .success
      }

      center.pauseCommand.isEnabled = true
      center.pauseCommand.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "pause"])
        return .success
      }

      center.togglePlayPauseCommand.isEnabled = true
      center.togglePlayPauseCommand.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "togglePlayPause"])
        return .success
      }

      center.nextTrackCommand.isEnabled = true
      center.nextTrackCommand.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "nextTrack"])
        return .success
      }

      center.previousTrackCommand.isEnabled = true
      center.previousTrackCommand.addTarget { [weak self] _ in
        self?.sendEvent("onRemoteCommand", ["command": "previousTrack"])
        return .success
      }
    }

    Function("clearNowPlaying") {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
  }
}
