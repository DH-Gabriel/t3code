// @effect-diagnostics-next-line nodeBuiltinImport:off -- Receipt filenames use a synchronous content hash with no runtime service.
import * as NodeCrypto from "node:crypto";
import {
  CodexCloudError,
  CodexCloudOptions,
  CodexCloudReceipt,
  type CodexCloudScope,
  type CodexCloudSubmit,
  type CodexCloudSaveEnvironment,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveProjectProviderInstanceEnabled } from "@t3tools/contracts";

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const StoredReceipt = Schema.Struct({
  fingerprint: Schema.String,
  submissionFingerprint: Schema.String,
  scope: Schema.String,
  receipt: CodexCloudReceipt,
});
const RecentTasks = Schema.Struct({
  tasks: Schema.Array(
    Schema.Struct({
      environment_id: Schema.NullOr(Schema.String),
      environment_label: Schema.NullOr(Schema.String),
    }),
  ),
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRecentTasks = Schema.decodeOption(Schema.fromJsonString(RecentTasks));
const decodeOptions = Schema.decodeEffect(CodexCloudOptions);

export function codexCloudTaskUrl(stdout: string): string | null {
  const urls = stdout
    .trim()
    .split(/\s+/)
    .filter((value) => /^https:\/\/chatgpt\.com\/codex\/tasks\/[A-Za-z0-9_-]+$/.test(value));
  return urls.length === 1 ? urls[0]! : null;
}

export class CodexCloud extends Context.Service<
  CodexCloud,
  {
    readonly options: (input: CodexCloudScope) => Effect.Effect<CodexCloudOptions, CodexCloudError>;
    readonly submit: (input: CodexCloudSubmit) => Effect.Effect<CodexCloudReceipt, CodexCloudError>;
    readonly saveEnvironment: (
      input: typeof CodexCloudSaveEnvironment.Type,
    ) => Effect.Effect<void, CodexCloudError>;
  }
>()("t3/provider/CodexCloud") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const storageError = () => new CodexCloudError({ reason: "storage" });
  const resolve = Effect.fn("CodexCloud.resolve")(function* (input: CodexCloudScope) {
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError(() => new CodexCloudError({ reason: "project" })));
    if (Option.isNone(project) || project.value.deletedAt !== null)
      return yield* new CodexCloudError({ reason: "project" });
    const currentSettings = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CodexCloudError({ reason: "unavailable" })),
    );
    if (
      !resolveProjectProviderInstanceEnabled(
        currentSettings,
        input.projectId,
        input.providerInstanceId,
      )
    )
      return yield* new CodexCloudError({ reason: "unavailable" });
    const instance = yield* instances.getInstance(input.providerInstanceId);
    if (!instance?.enabled || !instance.codexCloudExecution)
      return yield* new CodexCloudError({ reason: "unavailable" });
    const execution = yield* instance.codexCloudExecution.pipe(
      Effect.mapError(() => new CodexCloudError({ reason: "unavailable" })),
    );
    const accountId = execution.accountId;
    if (!accountId) return yield* new CodexCloudError({ reason: "identity" });
    const scope = digest(
      [input.projectId, input.providerInstanceId, execution.accountKey, accountId].join("\0"),
    );
    const directory = path.join(config.stateDir, "codex-cloud", scope);
    yield* fs
      .makeDirectory(directory, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(storageError));
    const receiptDirectory = path.join(config.stateDir, "codex-cloud", "receipts");
    yield* fs
      .makeDirectory(receiptDirectory, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(storageError));
    return { execution, directory, receiptDirectory, scope };
  });
  const read = Effect.fn("CodexCloud.read")(function* <A>(
    file: string,
    schema: Schema.Codec<A, unknown>,
  ) {
    if (!(yield* fs.exists(file))) return undefined;
    const text = yield* fs.readFileString(file);
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
  }, Effect.mapError(storageError));
  const write = Effect.fn("CodexCloud.write")(function* (file: string, value: unknown) {
    const text = yield* encodeJson(value);
    yield* fs.writeFileString(file + ".tmp", text, { mode: 0o600 });
    yield* fs.rename(file + ".tmp", file);
  }, Effect.mapError(storageError));
  const options = Effect.fn("CodexCloud.options")(function* (input: CodexCloudScope) {
    const resolved = yield* resolve(input).pipe(Effect.result);
    if (resolved._tag === "Failure")
      return {
        available: false,
        reason: resolved.failure.message,
        saved: [],
        recent: [],
        receipts: [],
      };
    const { execution, directory, receiptDirectory, scope } = resolved.success;
    const saved =
      (yield* read(path.join(directory, "environments.json"), CodexCloudOptions.fields.saved)) ??
      [];
    const files = yield* fs.readDirectory(receiptDirectory).pipe(Effect.mapError(storageError));
    const receipts = yield* Effect.forEach(
      files.filter((file) => file.endsWith(".receipt.json")),
      (file) => read(path.join(receiptDirectory, file), StoredReceipt),
    );
    const output = yield* runner
      .run({
        command: execution.command,
        args: [...execution.args, "cloud", "list", "--json", "--limit", "20"],
        env: execution.env,
        cwd: directory,
        timeout: "30 seconds",
        maxOutputBytes: 256000,
      })
      .pipe(Effect.result);
    const tasks =
      output._tag === "Success" && output.success.code === 0
        ? decodeRecentTasks(output.success.stdout)
        : Option.none();
    const recent = Option.isSome(tasks)
      ? [
          ...new Map(
            tasks.value.tasks.flatMap((task) =>
              task.environment_id
                ? [
                    [
                      task.environment_id,
                      {
                        id: task.environment_id,
                        label: task.environment_label || task.environment_id,
                      },
                    ] as const,
                  ]
                : [],
            ),
          ).values(),
        ]
      : [];
    return yield* decodeOptions({
      available: true,
      reason: Option.isNone(tasks)
        ? "Recent tasks unavailable. Check this CLI's ChatGPT sign-in; saved or manual IDs remain available. Suggestions are not a full environment list."
        : null,
      saved,
      recent,
      receipts: [
        ...new Map(
          receipts.flatMap((record) =>
            record?.scope === scope ? [[record.receipt.commandId, record.receipt] as const] : [],
          ),
        ).values(),
      ],
    }).pipe(Effect.mapError(storageError));
  });
  const saveEnvironment = Effect.fn("CodexCloud.saveEnvironment")(function* (
    input: typeof CodexCloudSaveEnvironment.Type,
  ) {
    const { directory } = yield* resolve(input);
    const file = path.join(directory, "environments.json");
    const saved = (yield* read(file, CodexCloudOptions.fields.saved)) ?? [];
    yield* write(file, [
      ...saved.filter((entry) => entry.id !== input.environment.id),
      ...(input.remove ? [] : [input.environment]),
    ]);
  }, lock.withPermits(1));
  const submit = Effect.fn("CodexCloud.submit")(function* (input: CodexCloudSubmit) {
    const { execution, directory, receiptDirectory, scope } = yield* resolve(input);
    const file = path.join(receiptDirectory, digest(input.commandId) + ".receipt.json");
    const fingerprint = digest(yield* encodeJson(input).pipe(Effect.mapError(storageError)));
    const submissionFingerprint = digest(
      yield* encodeJson({
        projectId: input.projectId,
        providerInstanceId: input.providerInstanceId,
        cloudEnvironmentId: input.cloudEnvironmentId,
        branch: input.branch,
        prompt: input.prompt,
      }).pipe(Effect.mapError(storageError)),
    );
    const existing = yield* read(file, StoredReceipt);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.scope !== scope)
        return yield* new CodexCloudError({ reason: "conflict" });
      return existing.receipt;
    }
    const files = yield* fs.readDirectory(receiptDirectory).pipe(Effect.mapError(storageError));
    const previous = yield* Effect.forEach(
      files.filter((entry) => entry.endsWith(".receipt.json")),
      (entry) => read(path.join(receiptDirectory, entry), StoredReceipt),
    );
    const duplicate = previous.find(
      (record) =>
        record?.scope === scope &&
        record.submissionFingerprint === submissionFingerprint &&
        record.receipt.status !== "failed" &&
        !input.acknowledgedCommandIds?.includes(record.receipt.commandId),
    );
    if (duplicate) {
      yield* write(file, { fingerprint, submissionFingerprint, scope, receipt: duplicate.receipt });
      return duplicate.receipt;
    }
    if (
      previous.some(
        (record) =>
          record?.scope === scope &&
          record.receipt.status === "unknown" &&
          !input.acknowledgedCommandIds?.includes(record.receipt.commandId),
      )
    )
      return yield* new CodexCloudError({ reason: "unconfirmed" });
    const intent: CodexCloudReceipt = {
      commandId: input.commandId,
      cloudEnvironmentId: input.cloudEnvironmentId,
      branch: input.branch,
      status: "unknown",
      url: null,
      message:
        "Submission outcome unknown. Inspect recent Cloud tasks before explicitly submitting again.",
    };
    yield* write(file, { fingerprint, submissionFingerprint, scope, receipt: intent });
    const output = yield* runner
      .run({
        command: execution.command,
        args: [
          ...execution.args,
          "cloud",
          "exec",
          "--env",
          input.cloudEnvironmentId,
          "--branch",
          input.branch,
          "-",
        ],
        env: execution.env,
        cwd: directory,
        stdin: input.prompt,
        timeout: "2 minutes",
        maxOutputBytes: 64000,
      })
      .pipe(Effect.result);
    let receipt: CodexCloudReceipt = intent;
    if (output._tag === "Failure" && output.failure._tag === "ProcessSpawnError")
      receipt = {
        ...intent,
        status: "failed",
        message: "Codex CLI could not start. Check this provider's CLI setup.",
      };
    if (output._tag === "Success") {
      const url = codexCloudTaskUrl(output.success.stdout);
      if (
        url &&
        !output.success.timedOut &&
        !output.success.stdoutTruncated &&
        !output.success.stdoutInvalidUtf8
      )
        receipt = {
          ...intent,
          status: "submitted",
          url,
          message: "Accepted by Codex Cloud. This does not mean the task has completed.",
        };
    }
    yield* write(file, { fingerprint, submissionFingerprint, scope, receipt });
    return receipt;
  }, lock.withPermits(1));
  return CodexCloud.of({ options, submit, saveEnvironment });
});
export const layer = Layer.effect(CodexCloud, make);
