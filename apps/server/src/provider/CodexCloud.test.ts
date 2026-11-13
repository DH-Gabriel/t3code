import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  CodexCloudEnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type CodexCloudSubmit,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as CodexCloud from "./CodexCloud.ts";

const input: CodexCloudSubmit = {
  projectId: ProjectId.make("project"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  commandId: CommandId.make("cloud-command"),
  cloudEnvironmentId: CodexCloudEnvironmentId.make("env-a"),
  branch: "feature/remote",
  prompt: "--literal\n$(never execute) `nor this`\n'quoted'",
};

it.layer(NodeServices.layer)("Codex Cloud", (it) => {
  it.effect(
    "persists and deduplicates literal submissions, rejects changed input, and recovers accepted links",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cloud-test-" });
        const calls: ProcessRunner.ProcessRunInput[] = [];
        let accountId: string | undefined = "workspace-a";
        const accountKey = "selected-account";
        let output = "https://chatgpt.com/codex/tasks/task_abc\n";
        let failure: "none" | "spawn" | "timeout" | "interrupt" = "none";
        const instance = {
          instanceId: input.providerInstanceId,
          driverKind: ProviderDriverKind.make("codex"),
          enabled: true,
          codexCloudExecution: Effect.sync(() => ({
            command: "/selected/codex",
            args: ["-c", "profile=selected"],
            env: { CODEX_HOME: stateDir + "/account-home", SELECTED: "yes" },
            accountKey,
            ...(accountId ? { accountId } : {}),
          })),
          continuationIdentity: {
            driverKind: ProviderDriverKind.make("codex"),
            continuationKey: "test",
          },
          displayName: undefined,
          snapshot: {} as ProviderInstance["snapshot"],
          orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
          textGeneration: {} as ProviderInstance["textGeneration"],
        } satisfies ProviderInstance;
        const dependencies = Layer.mergeAll(
          ServerConfig.layerTest("/project-cwd", stateDir),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () =>
              Effect.succeedSome({
                projectId: input.projectId,
                title: "Project",
                workspaceRoot: "/project-cwd",
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                pinnedAt: null,
                archivedAt: null,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
              }),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(instance),
          }),
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: (invocation) =>
              Effect.suspend<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError, never>(
                () => {
                  calls.push(invocation);
                  if (failure === "spawn")
                    return Effect.fail(
                      new ProcessRunner.ProcessSpawnError({
                        command: invocation.command,
                        argumentCount: invocation.args.length,
                        cause: new Error("private diagnostics"),
                      }),
                    );
                  if (failure === "timeout")
                    return Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: invocation.command,
                        argumentCount: invocation.args.length,
                        timeoutMs: 120000,
                      }),
                    );
                  if (failure === "interrupt") return Effect.interrupt;
                  return Effect.succeed({
                    stdout: invocation.args.includes("list")
                      ? '{"tasks":[{"environment_id":"env-a","environment_label":"Recent"}]}'
                      : output,
                    stderr: "",
                    code: ChildProcessSpawner.ExitCode(0),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  });
                },
              ),
          }),
        );
        const layer = CodexCloud.layer.pipe(Layer.provide(dependencies));
        const receipt = yield* Effect.gen(function* () {
          const service = yield* CodexCloud.CodexCloud;
          const [receipt, duplicate] = yield* Effect.all(
            [service.submit(input), service.submit(input)],
            { concurrency: "unbounded" },
          );
          expect(duplicate).toEqual(receipt);
          expect(
            yield* service.submit({ ...input, commandId: CommandId.make("reconnected-command") }),
          ).toEqual(receipt);
          expect(
            (yield* service.submit({ ...input, prompt: "changed" }).pipe(Effect.result))._tag,
          ).toBe("Failure");
          return receipt;
        }).pipe(Effect.provide(layer));
        expect(receipt.status).toBe("submitted");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          command: "/selected/codex",
          stdin: input.prompt,
          env: { CODEX_HOME: stateDir + "/account-home", SELECTED: "yes" },
          args: [
            "-c",
            "profile=selected",
            "cloud",
            "exec",
            "--env",
            "env-a",
            "--branch",
            "feature/remote",
            "-",
          ],
        });
        expect(calls[0]!.cwd).not.toBe("/project-cwd");
        yield* Effect.gen(function* () {
          const service = yield* CodexCloud.CodexCloud;
          expect(yield* service.submit(input)).toEqual(receipt);
          const options = yield* service.options(input);
          expect(options.receipts).toEqual([receipt]);
          expect(options.recent).toEqual([{ id: "env-a", label: "Recent" }]);
          const savedEnvironment = {
            ...input,
            environment: { id: input.cloudEnvironmentId, label: "My environment" },
          };
          yield* service.saveEnvironment(savedEnvironment);
          expect((yield* service.options(input)).saved).toEqual([savedEnvironment.environment]);
          yield* service.saveEnvironment({ ...savedEnvironment, remove: true });
          expect((yield* service.options(input)).saved).toEqual([]);
          const repeated = yield* service.submit({
            ...input,
            commandId: CommandId.make("explicit-repeat"),
            acknowledgedCommandIds: [input.commandId],
          });
          expect(repeated.commandId).toBe("explicit-repeat");
          output = "unparseable after launch";
          const uncertainInput = {
            ...input,
            prompt: "uncertain task",
            commandId: CommandId.make("uncertain"),
          };
          const uncertain = yield* service.submit(uncertainInput);
          expect(uncertain.status).toBe("unknown");
          expect(yield* service.submit(uncertainInput)).toEqual(uncertain);
          expect(
            (yield* service
              .submit({
                ...input,
                prompt: "new while unresolved",
                commandId: CommandId.make("after-unknown"),
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const acknowledgedCommandIds = [uncertainInput.commandId];
          for (const outcome of ["spawn", "timeout", "interrupt"] as const) {
            failure = outcome;
            const attempt = {
              ...input,
              prompt: outcome,
              commandId: CommandId.make(outcome),
              acknowledgedCommandIds: [...acknowledgedCommandIds],
            };
            yield* service.submit(attempt).pipe(Effect.exit);
            failure = "none";
            const recovered = yield* service.submit(attempt);
            expect(recovered.status).toBe(outcome === "spawn" ? "failed" : "unknown");
            if (recovered.status === "unknown") acknowledgedCommandIds.push(attempt.commandId);
          }
          accountId = "workspace-b";
          expect((yield* service.submit(input).pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* service.options(input)).receipts).toEqual([]);
          accountId = undefined;
          expect((yield* service.options(input)).available).toBe(false);
        }).pipe(Effect.provide(layer));
        expect(calls.filter((call) => call.args.includes("exec"))).toHaveLength(6);
      }),
  );
});

it.each([
  ["https://chatgpt.com/codex/tasks/task_123\n", "https://chatgpt.com/codex/tasks/task_123"],
  ["https://example.com/codex/tasks/task_123", null],
  ["http://chatgpt.com/codex/tasks/task_123", null],
  ["https://chatgpt.com/codex/tasks/task_123?token=secret", null],
  ["no link", null],
])("parses only a confirmed task URL: %s", (output, expected) => {
  expect(CodexCloud.codexCloudTaskUrl(output)).toBe(expected);
});
