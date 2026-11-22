import { SettingCheckbox } from "../primitives/Checkbox";
import { useShortcutLabel } from "../../lib/keybindings";
import { updateSettings, useSettings } from "../../lib/settings";
import { DICTATION_FIX_MODELS, DICTATION_LANGUAGES, whisperModelFor } from "@milagre/shared/dictation";
import { Select } from "../primitives/Select";
import { Row } from "./SettingsGroup";
import { DictationActionChoice, DictationShortcutModeChoice } from "./ChatDisplayChoices";
import { SpeechModelChoice } from "./SpeechModelChoice";
import { ChoiceGroup } from "./settings-parts";

/** Dictation: the shortcut, what it does, the fix-up, the speech model and its language. */
export function VoiceSettings({ onOpenKeybindings }: { onOpenKeybindings?: () => void }) {
  const settings = useSettings();
  const dictateKey = useShortcutLabel("dictation.toggle");
  const speechModel = whisperModelFor("desktop", settings.dictationModel);
  const englishOnly = speechModel.english;
  return (
    <>
      <ChoiceGroup title="Dictation">
        <div className="mb-4 overflow-hidden rounded-card border border-line bg-surface">
          <Row label="Shortcut" description="Starts dictation in the composer from anywhere in the Chat. Change the keys in Keybindings.">
            <span className="flex items-center gap-2">
              <kbd data-dictation-shortcut className="rounded-control border border-line-strong bg-surface px-2 py-1 font-sans text-13 font-semibold text-ink">
                {dictateKey ?? "None"}
              </kbd>
              {onOpenKeybindings && (
                <button type="button" onClick={onOpenKeybindings} className="rounded-control bg-field px-2.5 py-1 text-13 font-medium text-ink hover:bg-hover">
                  Change
                </button>
              )}
            </span>
          </Row>
        </div>
        <p className="mb-2 px-1 text-14 font-semibold text-ink">How the shortcut works</p>
        <DictationShortcutModeChoice
          shortcut={dictateKey ?? "None"}
          value={settings.dictationShortcutMode}
          onChange={(dictationShortcutMode) => updateSettings({ dictationShortcutMode })}
        />
        <p className="mt-4 mb-2 px-1 text-14 font-semibold text-ink">When dictation finishes</p>
        <DictationActionChoice value={settings.dictationAction} onChange={(dictationAction) => updateSettings({ dictationAction })} />
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
          <Row label="Spoken symbols" description={'Say "backtick npm test backtick" for inline code or "insert newline" for a line break.'}>
            <SettingCheckbox label="Spoken symbols" checked={settings.dictationSymbols} onChange={(dictationSymbols) => updateSettings({ dictationSymbols })} />
          </Row>
          <Row
            label="Fix names with AI"
            description="After you stop, a small model corrects misheard file, code and provider names using this Chat. Your words show at once and update a few seconds later, unless you edit them first."
          >
            <SettingCheckbox label="Fix names with AI" checked={settings.dictationFixUp} onChange={(dictationFixUp) => updateSettings({ dictationFixUp })} />
          </Row>
          <Row label="Fix-up model" description="Runs on the computer the Chat is on, with its signed-in agents.">
            <Select
              label="Fix-up model"
              value={settings.dictationFixModel}
              disabled={!settings.dictationFixUp}
              onChange={(dictationFixModel) => updateSettings({ dictationFixModel })}
              options={DICTATION_FIX_MODELS.map((model) => ({
                value: model.value,
                label: model.value === "auto" ? `${model.label} (the Chat's agent)` : model.label,
              }))}
            />
          </Row>
        </div>
        <p className="mt-4 px-1 text-14 font-semibold text-ink">Speech model</p>
        <p className="mb-2 px-1 text-12 text-ink-3">Transcribes on this computer. Picking a model downloads it once.</p>
        <SpeechModelChoice value={settings.dictationModel} onChange={(dictationModel) => updateSettings({ dictationModel })} />
        <div className="mt-4 overflow-hidden rounded-card border border-line bg-surface">
          <Row
            label="Language"
            description={
              englishOnly
                ? `${speechModel.purpose} only understands English. Pick an any-language model above to dictate in others.`
                : "Automatic detection is experimental and supports different languages in the same recording. Pick one language if detection guesses wrong."
            }
          >
            <Select
              label="Dictation language"
              value={englishOnly ? "en" : settings.dictationLanguage}
              disabled={englishOnly}
              onChange={(dictationLanguage) => updateSettings({ dictationLanguage })}
              options={DICTATION_LANGUAGES.map((language) => ({
                value: language.code,
                label: language.name,
              }))}
            />
          </Row>
        </div>
      </ChoiceGroup>
    </>
  );
}
