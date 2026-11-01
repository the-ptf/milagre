# Dictation eval

Scores how well dictation gets the technical words of a message to a coding agent right: provider and model names,
file names, code identifiers, CLI tools. It runs the recognizers Milagre ships, on this Mac:

- **Apple** (`apple-transcribe.swift`): `DictationTranscriber` with the long-dictation preset and the project's words as
  contextual strings, set up the way the iPhone build runs it (`apps/mobile/patches/@react-native-ai+apple`).
- **Whisper** (`@fugood/whisper.node`, the desktop binding): the same models, prompt and decoding options as
  `apps/desktop/electron/dictation.cjs`. `small` stands in for the phone's default.

- **Parakeet** (`--engines …,parakeet`): Paseo's local recognizer, NVIDIA Parakeet TDT 0.6B v2 (English) and v3 (25
  European languages) through `sherpa-onnx-node`, installed into the cache rather than the repo. It takes no prompt, so
  the project's words reach it only through snapping and the fix-up. Not shipped in Milagre; here to compare.

Apple is scored on English only: its Portuguese dictation on macOS 27.0 returns only the first word of each clip.

```sh
npm ci                                       # once, for whisper.node
node scripts/dictation-eval/run.mjs          # Apple + Whisper turbo and small, four variants
node scripts/dictation-eval/run.mjs --polish # adds the AI fix-up (one Claude Haiku call per clip)
node scripts/dictation-eval/run.mjs --engines apple --voices Samantha --cases codex-review,file-insert
```

The first run downloads the Whisper models (about 760 MB) and synthesizes the clips into
`~/.cache/milagre-dictation-eval`. Each run writes `report.md` and `results.json` (every transcript, before and after
snapping) to `<cache>/runs/<time>` or `--out`.

## Variants

| Variant | Recognizer gets                       | After recognition                                   |
| ------- | ------------------------------------- | --------------------------------------------------- |
| raw     | no vocabulary                         |                                                     |
| main    | the vocabulary `--base` (main) builds |                                                     |
| new     | the vocabulary this checkout builds   |                                                     |
| snap    | as new                                | `snapTerms`                                         |
| polish  | as new                                | `snapTerms`, then the AI fix-up (`polishDictation`) |

Both vocabularies are read at the base commit (its last 60 commits for "recent files"), so a branch's own edits don't
make its vocabulary look better than it would for a user.

## Metrics

- **Term recall**: the share of a case's `terms` that come out spelled exactly (case-sensitive, not inside a longer
  name). This is the number the work is about.
- **WER**: word error rate against `expected`, ignoring case and punctuation (so `voice-dictation.ts` and
  `voice dictation ts` count the same words; term recall catches the spelling).
- **Control WER**: WER on the control cases, ordinary sentences with no terms. A variant that rewrites plain speech into
  code names shows up here.

## Your own voice

Text to speech has no accent and never mumbles, so it flatters every recognizer. Record yourself saying a case's
`spoken` text (Voice Memos, QuickTime) and name the file after the case id:

```sh
node scripts/dictation-eval/run.mjs --clips ~/dictation-clips   # codex-review.m4a, file-insert.m4a, ...
```

Those clips are scored as voice `you`, next to the synthesized ones.

## Adding cases

`corpus.json`: `spoken` is what is said (spell out "dot", letters as "N P M"), `expected` what should land in the
composer, `terms` the words that must be exact. A case with no terms is a control.
