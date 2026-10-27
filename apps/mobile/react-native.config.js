// whisper.rn transcribes on Android only; iPhone dictation uses Apple's recognizer, so iOS doesn't link whisper.cpp.
module.exports = {
  dependencies: {
    "whisper.rn": { platforms: { ios: null } },
  },
};
