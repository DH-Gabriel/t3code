import { expect, it } from "@effect/vitest";
import { AtomRegistry, AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import {
  CommandId,
  CodexCloudEnvironmentId,
  EnvironmentId,
  ProjectId,
  type CodexCloudReceipt,
  type CodexCloudSubmit,
} from "@t3tools/contracts";
import { cloudComposerAtom, cloudComposerKey, sendCloudComposer } from "./codexCloud.ts";
import type { AtomCommand, AtomCommandResult } from "./runtime.ts";

it("bypasses local sending, refuses context, preserves failed drafts, and reuses an unconfirmed command", async () => {
  const scheduled: (() => void)[] = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const release = registry.mount(cloudComposerAtom(cloudComposerKey("host", "project")));
  using _cleanup = { [Symbol.dispose]: () => registry.dispose() };
  const target = {
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("project"),
    prompt: "literal\n--prompt",
    hasNonTextContent: false,
  };
  const atom = cloudComposerAtom(cloudComposerKey(target.environmentId, target.projectId));
  const calls: CodexCloudSubmit[] = [];
  let fail = true;
  let clearCount = 0;
  const commands: {
    submit: AtomCommand<
      { environmentId: EnvironmentId; input: CodexCloudSubmit },
      CodexCloudReceipt,
      unknown
    >;
  } = {
    submit: {
      label: "cloud-test",
      run: async (_registry, request) => {
        expect(request.environmentId).toBe(target.environmentId);
        calls.push(request.input);
        if (fail) return AsyncResult.failure(Cause.fail("disconnected"));
        return AsyncResult.success({
          commandId: request.input.commandId,
          cloudEnvironmentId: request.input.cloudEnvironmentId,
          branch: request.input.branch,
          status: "submitted",
          url: "https://chatgpt.com/codex/tasks/task_1",
          message: "Accepted",
        });
      },
    },
  };
  const send = (hasNonTextContent = false) =>
    sendCloudComposer(
      registry,
      commands,
      { ...target, hasNonTextContent },
      () => {
        clearCount++;
      },
      () => CommandId.make("new-request"),
    );
  expect(await send()).toBe(false);
  registry.set(atom, {
    ...registry.get(atom),
    enabled: true,
    providerInstanceId: "codex",
    environmentId: "cloud-env",
    branch: "published",
  });
  expect(await send(true)).toBe(true);
  expect(calls).toEqual([]);
  expect(registry.get(atom).message).toContain("plain text only");
  await send();
  expect(clearCount).toBe(0);
  release();
  scheduled.splice(0).forEach((task) => task());
  expect(registry.get(atom).pending?.commandId).toBe(calls[0]!.commandId);
  await sendCloudComposer(
    registry,
    commands,
    { ...target, prompt: "edited after disconnect" },
    () => {
      clearCount++;
    },
    () => CommandId.make("second-request"),
  );
  expect(calls).toHaveLength(1);
  expect(registry.get(atom).message).toContain("previous submission");
  fail = false;
  await send();
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]!.prompt).toBe(target.prompt);
  expect(clearCount).toBe(1);
  expect(registry.get(atom).receipt?.status).toBe("submitted");
});

it("keeps a late account response out of the newly selected account", async () => {
  const registry = AtomRegistry.make();
  using _cleanup = { [Symbol.dispose]: () => registry.dispose() };
  const target = {
    environmentId: EnvironmentId.make("host"),
    projectId: ProjectId.make("project"),
    prompt: "do work",
    hasNonTextContent: false,
  };
  const atom = cloudComposerAtom(cloudComposerKey(target.environmentId, target.projectId));
  registry.set(atom, {
    ...registry.get(atom),
    enabled: true,
    providerInstanceId: "account-A",
    environmentId: "env-A",
    branch: "main",
  });
  let complete!: (value: AtomCommandResult<CodexCloudReceipt, unknown>) => void;
  const response = new Promise<AtomCommandResult<CodexCloudReceipt, unknown>>((resolve) => {
    complete = resolve;
  });
  const sending = sendCloudComposer(
    registry,
    { submit: { label: "cloud-test", run: () => response } },
    target,
    () => {
      throw new Error("Other account's draft must survive");
    },
    () => CommandId.make("account-A-command"),
  );
  registry.set(atom, {
    ...registry.get(atom),
    providerInstanceId: "account-B",
    environmentId: "env-B",
    receipt: null,
    pending: null,
  });
  complete(
    AsyncResult.success({
      commandId: CommandId.make("account-A-command"),
      cloudEnvironmentId: CodexCloudEnvironmentId.make("env-A"),
      branch: "main",
      status: "submitted",
      url: "https://chatgpt.com/codex/tasks/task_A",
      message: "Accepted",
    }),
  );
  await sending;
  expect(registry.get(atom).providerInstanceId).toBe("account-B");
  expect(registry.get(atom).receipt).toBeNull();
  expect(registry.get(atom).busy).toBe(false);
});
