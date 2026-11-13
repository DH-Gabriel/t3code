import * as Schema from "effect/Schema";
import { CommandId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CodexCloudEnvironmentId = TrimmedNonEmptyString.pipe(
  Schema.brand("CodexCloudEnvironmentId"),
);
export const CodexCloudScope = Schema.Struct({
  projectId: ProjectId,
  providerInstanceId: ProviderInstanceId,
});
export type CodexCloudScope = typeof CodexCloudScope.Type;
export const CodexCloudSubmit = Schema.Struct({
  ...CodexCloudScope.fields,
  commandId: CommandId,
  acknowledgedCommandIds: Schema.optionalKey(Schema.Array(CommandId)),
  cloudEnvironmentId: CodexCloudEnvironmentId,
  branch: TrimmedNonEmptyString,
  prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000000)),
});
export type CodexCloudSubmit = typeof CodexCloudSubmit.Type;
const ReceiptFields = {
  commandId: CommandId,
  cloudEnvironmentId: CodexCloudEnvironmentId,
  branch: TrimmedNonEmptyString,
  message: Schema.String,
};
export const CodexCloudReceipt = Schema.Union([
  Schema.Struct({
    ...ReceiptFields,
    status: Schema.Literal("submitted"),
    url: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...ReceiptFields, status: Schema.Literal("failed"), url: Schema.Null }),
  Schema.Struct({ ...ReceiptFields, status: Schema.Literal("unknown"), url: Schema.Null }),
]);
export type CodexCloudReceipt = typeof CodexCloudReceipt.Type;
export const CodexCloudEnvironment = Schema.Struct({
  id: CodexCloudEnvironmentId,
  label: TrimmedNonEmptyString,
});
export const CodexCloudSaveEnvironment = Schema.Struct({
  ...CodexCloudScope.fields,
  environment: CodexCloudEnvironment,
  remove: Schema.optionalKey(Schema.Boolean),
});
export const CodexCloudOptions = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
  saved: Schema.Array(CodexCloudEnvironment),
  recent: Schema.Array(CodexCloudEnvironment),
  receipts: Schema.Array(CodexCloudReceipt),
});
export type CodexCloudOptions = typeof CodexCloudOptions.Type;
export class CodexCloudError extends Schema.TaggedError<CodexCloudError>()("CodexCloudError", {
  reason: Schema.Literals([
    "unavailable",
    "storage",
    "conflict",
    "project",
    "unconfirmed",
    "identity",
  ]),
}) {
  override get message() {
    return {
      unavailable:
        "Cloud requires an existing Codex CLI account signed in with ChatGPT, without launch overrides. Configure it in Settings → Providers; connecting ChatGPT directly through T3 does not sign in the CLI.",
      storage: "Cloud submission receipt could not be saved.",
      conflict: "This command ID was already used with different input.",
      project: "The selected project is unavailable.",
      unconfirmed:
        "A previous Cloud submission is unconfirmed. Load recent tasks and check it before preparing a new submission.",
      identity:
        "This CLI does not expose its ChatGPT workspace. Update Codex or choose another CLI account.",
    }[this.reason];
  }
}
