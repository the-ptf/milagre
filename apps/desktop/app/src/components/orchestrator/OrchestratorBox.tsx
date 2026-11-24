import type { ComponentProps } from "react";
import { ORCHESTRATOR_MAX_IMAGES, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { sendOrchestratorTask } from "../../lib/orchestrator-store";
import { QuickPromptBox } from "../QuickPromptBox";

type Props = Omit<ComponentProps<typeof QuickPromptBox<OrchestratorTask>>, "submit" | "maxImages" | "label" | "placeholder"> & { placeholder?: string };

const submit = (text: string, images: { id: string; name: string; dataUrl: string }[]) => sendOrchestratorTask(text, images);

export function OrchestratorBox({ placeholder = "Ask for anything, in any Project…", size = "large", ...props }: Props) {
  return (
    <QuickPromptBox
      {...props}
      size={size}
      submit={submit}
      maxImages={ORCHESTRATOR_MAX_IMAGES}
      label="What should the Orchestrator do?"
      placeholder={placeholder}
    />
  );
}
