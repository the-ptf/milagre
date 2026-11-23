import { insertDictation, type Selection } from "@milagre/shared/voice-dictation";
import { Alert } from "react-native";
import { editedCorrection, type VocabularyCorrection } from "@milagre/shared/dictation";
import type { Client } from "./client";
import { lastDictation } from "./last-dictation";
import { showActions } from "./ui";
import { promptText } from "./text-prompt";

export function openComposerVoiceMenu({
  client,
  cwd,
  before,
  draft,
  selection,
  insert,
}: {
  client: Client;
  cwd: string;
  before: string;
  draft: string;
  selection: Selection;
  insert(edit: { value: string; caret: number }): void;
}) {
  const correction = editedCorrection(before, draft, draft.slice(selection.start, selection.end));
  voiceMenu(client, cwd, correction, (text) => {
    const edit = insertDictation(draft, selection, text, true);
    if (edit) insert(edit);
  });
}

function voiceMenu(client: Client, cwd: string, correction: VocabularyCorrection, insert: (text: string) => void) {
  const last = lastDictation();
  const report = (error: unknown) => Alert.alert("Dictation vocabulary", String(error));
  const save = (heard: string, spelling: string) => client.call("dictation:correct", [cwd, heard, spelling]);
  async function add() {
    const heard = await promptText("Heard as", { message: "Enter the words dictation heard.", value: correction.heard, plain: true, action: "Next" });
    if (!heard?.trim()) return;
    const spelling = await promptText("Write as", { message: "Use this spelling in this Project.", value: correction.spelling, plain: true });
    if (spelling?.trim()) await save(heard, spelling);
  }
  async function vocabulary() {
    const items = await client.call<VocabularyCorrection[]>("dictation:corrections", [cwd]);
    showActions({
      title: "Project dictation vocabulary",
      actions: [{ id: "add", title: "Add correction" }, ...items.map((item, index) => ({ id: String(index), title: item.heard + " → " + item.spelling }))],
      onSelect: (id) => {
        if (id === "add") {
          void add().catch(report);
          return;
        }
        const item = items[Number(id)];
        if (item)
          showActions({
            title: item.heard + " → " + item.spelling,
            actions: [{ id: "remove", title: "Remove correction", destructive: true }],
            onSelect: () => {
              void save(item.heard, "").catch(report);
            },
          });
      },
    });
  }
  showActions({
    title: "Dictation",
    actions: [
      { id: "last", title: "Insert last dictation", disabled: !last },
      { id: "vocabulary", title: "Project dictation vocabulary", disabled: !cwd },
    ],
    onSelect: (id) => {
      if (id === "last") insert(last);
      else void vocabulary().catch(report);
    },
  });
}
