import {
  WS_METHODS,
  CodexCloudSubmit,
  CodexCloudError,
  CommandId,
  type EnvironmentId,
  type CodexCloudReceipt,
  type CodexCloudOptions,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "./runtime.ts";

const decodeSubmission = Schema.decodeUnknownOption(CodexCloudSubmit);
const isCloudError = Schema.is(CodexCloudError);

export interface CloudComposerSelection {
  enabled: boolean;
  providerInstanceId: string;
  environmentId: string;
  label: string;
  branch: string;
  busy: boolean;
  message: string | null;
  options: CodexCloudOptions | null;
  receipt: CodexCloudReceipt | null;
  pending: CodexCloudSubmit | null;
  acknowledgedCommandIds: readonly CommandId[];
}
export const cloudComposerKey = (environmentId: string, projectId: string) =>
  JSON.stringify([environmentId, projectId]);
export const cloudComposerAtom = Atom.family((_key: string) =>
  Atom.make<CloudComposerSelection>({
    enabled: false,
    providerInstanceId: "",
    environmentId: "",
    label: "",
    branch: "",
    busy: false,
    message: null,
    options: null,
    receipt: null,
    pending: null,
    acknowledgedCommandIds: [],
  }).pipe(Atom.keepAlive),
);

function cloudSendBlockReason(input: {
  prompt: string;
  hasNonTextContent: boolean;
  environmentId: string;
  branch: string;
}) {
  if (input.hasNonTextContent)
    return "Codex Cloud accepts plain text only. Remove attachments and context before sending.";
  if (!input.prompt.trim()) return "Enter a prompt for Codex Cloud.";
  if (!input.environmentId.trim() || !input.branch.trim())
    return "Choose a Cloud environment and enter its published branch.";
  return null;
}

export function createCodexCloudAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    options: createEnvironmentRpcCommand(runtime, {
      label: "codex-cloud:options",
      tag: WS_METHODS.codexCloudOptions,
    }),
    submit: createEnvironmentRpcCommand(runtime, {
      label: "codex-cloud:submit",
      tag: WS_METHODS.codexCloudSubmit,
    }),
    saveEnvironment: createEnvironmentRpcCommand(runtime, {
      label: "codex-cloud:save-environment",
      tag: WS_METHODS.codexCloudSaveEnvironment,
    }),
  };
}

export async function sendCloudComposer(
  registry: import("effect/reactivity/AtomRegistry").AtomRegistry,
  commands: {
    submit: AtomCommand<
      { environmentId: EnvironmentId; input: CodexCloudSubmit },
      CodexCloudReceipt,
      unknown
    >;
  },
  target: {
    environmentId: import("@t3tools/contracts").EnvironmentId;
    projectId: import("@t3tools/contracts").ProjectId;
    prompt: string;
    hasNonTextContent: boolean;
  },
  clearSnapshot: () => void,
  newCommandId: () => CommandId,
): Promise<boolean> {
  const atom = cloudComposerAtom(cloudComposerKey(target.environmentId, target.projectId));
  const selection = registry.get(atom);
  if (!selection.enabled) return false;
  if (selection.busy) return true;
  const reason = cloudSendBlockReason({
    ...target,
    environmentId: selection.environmentId,
    branch: selection.branch,
  });
  if (reason) {
    registry.set(atom, { ...selection, message: reason });
    return true;
  }
  const parsed = decodeSubmission({
    projectId: target.projectId,
    providerInstanceId: selection.providerInstanceId,
    cloudEnvironmentId: selection.environmentId.trim(),
    branch: selection.branch.trim(),
    prompt: target.prompt,
    commandId: newCommandId(),
    acknowledgedCommandIds: selection.acknowledgedCommandIds,
  });
  if (Option.isNone(parsed)) {
    registry.set(atom, {
      ...selection,
      message: "Choose a valid Codex CLI account, environment and branch.",
    });
    return true;
  }
  const payload = parsed.value;
  const pending = selection.pending;
  if (
    pending &&
    (pending.prompt !== payload.prompt ||
      pending.providerInstanceId !== payload.providerInstanceId ||
      pending.cloudEnvironmentId !== payload.cloudEnvironmentId ||
      pending.branch !== payload.branch)
  ) {
    registry.set(atom, {
      ...selection,
      message:
        "The previous submission is unconfirmed. Check recent tasks before preparing a new submission.",
    });
    return true;
  }
  const input =
    pending &&
    pending.prompt === payload.prompt &&
    pending.providerInstanceId === payload.providerInstanceId &&
    pending.cloudEnvironmentId === payload.cloudEnvironmentId &&
    pending.branch === payload.branch
      ? pending
      : payload;
  registry.set(atom, { ...selection, busy: true, pending: input, message: null });
  const result = await runAtomCommand(
    registry,
    commands.submit,
    { environmentId: target.environmentId, input },
    { reportFailure: false },
  );
  const current = registry.get(atom);
  if (
    current.providerInstanceId !== input.providerInstanceId ||
    current.pending?.commandId !== input.commandId
  ) {
    if (!current.pending || current.pending.commandId === input.commandId)
      registry.set(atom, { ...current, busy: false, pending: null });
    return true;
  }
  if (result._tag === "Success") {
    registry.set(atom, {
      ...current,
      busy: false,
      receipt: result.value,
      pending: result.value.status === "unknown" ? input : null,
      message: result.value.message,
    });
    if (result.value.status === "submitted") clearSnapshot();
  } else {
    const failure = squashAtomCommandFailure(result);
    registry.set(atom, {
      ...current,
      busy: false,
      message: isCloudError(failure)
        ? failure.message
        : "Submission could not be confirmed. Send again to query the same receipt; it will not launch a duplicate.",
    });
  }
  return true;
}
