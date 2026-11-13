import { AppText as Text } from "./ui/AppText";
import { useState } from "react";
import { Sheet } from "./ui/Sheet";
import { useAtomValue } from "@effect/atom-react";
import { View, TextInput, Pressable, Linking, ScrollView } from "react-native";
import { cloudComposerAtom, cloudComposerKey } from "@t3tools/client-runtime/state/codex-cloud";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  CodexCloudEnvironmentId,
  type EnvironmentId,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { appAtomRegistry } from "../state/atom-registry";
import { codexCloud } from "../state/codex-cloud";

export function CloudWorkPicker({
  environmentId,
  projectId,
  providers,
  onSend,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  providers: readonly ServerProvider[];
  onSend: () => void;
}) {
  const atom = cloudComposerAtom(cloudComposerKey(environmentId, projectId));
  const state = useAtomValue(atom);
  const canSubmit = useAtomValue(codexCloud.submit.permissionAtom(environmentId));
  const [open, setOpen] = useState(false);
  const canSave = useAtomValue(codexCloud.saveEnvironment.permissionAtom(environmentId));
  const canRead = useAtomValue(codexCloud.options.permissionAtom(environmentId));
  const accounts = providers.filter((provider) => provider.driver === "codex");
  const update = (patch: Partial<typeof state>) =>
    appAtomRegistry.set(atom, { ...appAtomRegistry.get(atom), ...patch });
  const environments = [
    ...new Map(
      [...(state.options?.recent ?? []), ...(state.options?.saved ?? [])].map((entry) => [
        entry.id,
        entry,
      ]),
    ).values(),
  ];
  const scope = (id: string) => ({ projectId, providerInstanceId: ProviderInstanceId.make(id) });
  const refresh = async (id: string) => {
    if (!id || !canRead) return;
    const result = await runAtomCommand(
      appAtomRegistry,
      codexCloud.options,
      { environmentId, input: scope(id) },
      { reportFailure: false },
    );
    if (result._tag === "Success" && appAtomRegistry.get(atom).providerInstanceId === id)
      update({ options: result.value });
  };
  const saveEnvironment = async (remove = false) => {
    if (!state.providerInstanceId || !state.environmentId.trim()) return;
    const result = await runAtomCommand(appAtomRegistry, codexCloud.saveEnvironment, {
      environmentId,
      input: {
        ...scope(state.providerInstanceId),
        environment: {
          id: CodexCloudEnvironmentId.make(state.environmentId.trim()),
          label: state.label.trim() || state.environmentId.trim(),
        },
        remove,
      },
    });
    if (result._tag === "Success") await refresh(state.providerInstanceId);
  };
  return (
    <View className="gap-2 py-2">
      <Pressable
        className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
        accessibilityRole="button"
        accessibilityLabel="Work in"
        onPress={() => setOpen(true)}
      >
        <Text>
          {state.enabled
            ? `Codex Cloud · ${state.label || state.environmentId || "Choose environment"}`
            : "Connected computer"}
        </Text>
      </Pressable>
      {state.enabled && (
        <Pressable
          className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
          accessibilityRole="button"
          disabled={
            !canSubmit ||
            state.busy ||
            state.options?.available !== true ||
            !state.environmentId.trim() ||
            !state.branch.trim()
          }
          onPress={onSend}
        >
          <Text>{state.busy ? "Submitting…" : "Send to Codex Cloud"}</Text>
        </Pressable>
      )}
      {state.message && <Text accessibilityRole="alert">{state.message}</Text>}
      {open && (
        <Sheet title="Work in" onClose={() => setOpen(false)}>
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 20, gap: 12 }}
          >
            <Text>Work in</Text>
            <Pressable
              className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
              accessibilityRole="button"
              onPress={() =>
                update({
                  enabled: !state.enabled,
                  providerInstanceId: state.providerInstanceId,
                })
              }
            >
              <Text>
                {state.enabled
                  ? "Codex Cloud · switch to connected computer"
                  : "Connected computer · switch to Codex Cloud"}
              </Text>
            </Pressable>
            {state.enabled && (
              <>
                {accounts.map((account) => (
                  <Pressable
                    className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                    key={account.instanceId}
                    disabled={state.busy || !!state.pending}
                    accessibilityRole="button"
                    onPress={() => {
                      update({
                        providerInstanceId: account.instanceId,
                        options: null,
                        receipt: null,
                        environmentId: "",
                        message: null,
                      });
                      void refresh(account.instanceId);
                    }}
                  >
                    <Text>
                      {state.providerInstanceId === account.instanceId ? "✓ " : ""}
                      {account.displayName ?? account.instanceId}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                  accessibilityRole="button"
                  disabled={!canRead || !state.providerInstanceId || state.busy}
                  onPress={() => void refresh(state.providerInstanceId)}
                >
                  <Text>Load saved and recent</Text>
                </Pressable>
                {environments.map((entry) => (
                  <Pressable
                    className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                    key={entry.id}
                    onPress={() => update({ environmentId: entry.id, label: entry.label })}
                  >
                    <Text>
                      {entry.label} ({entry.id})
                    </Text>
                  </Pressable>
                ))}
                <TextInput
                  className="rounded-lg border border-border bg-sheet px-3 py-3 text-foreground"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Cloud environment ID"
                  placeholder="Cloud environment ID"
                  value={state.environmentId}
                  onChangeText={(environmentId) => update({ environmentId })}
                />
                <TextInput
                  className="rounded-lg border border-border bg-sheet px-3 py-3 text-foreground"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Environment label"
                  placeholder="Label (optional)"
                  value={state.label}
                  onChangeText={(label) => update({ label })}
                />
                <Pressable
                  className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                  accessibilityRole="button"
                  disabled={
                    !canSave ||
                    !state.providerInstanceId ||
                    !state.environmentId.trim() ||
                    state.busy
                  }
                  onPress={() => void saveEnvironment()}
                >
                  <Text>Save environment</Text>
                </Pressable>
                {state.options?.saved.some((entry) => entry.id === state.environmentId) && (
                  <Pressable
                    className="min-h-11 justify-center px-3"
                    accessibilityRole="button"
                    disabled={!canSave || state.busy}
                    onPress={() => void saveEnvironment(true)}
                  >
                    <Text>Forget saved environment</Text>
                  </Pressable>
                )}
                <TextInput
                  className="rounded-lg border border-border bg-sheet px-3 py-3 text-foreground"
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Cloud branch"
                  placeholder="Published branch"
                  value={state.branch}
                  onChangeText={(branch) => update({ branch })}
                />
                <Pressable
                  className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                  accessibilityRole="button"
                  disabled={
                    !canSubmit ||
                    state.busy ||
                    !state.providerInstanceId ||
                    state.options?.available === false
                  }
                  onPress={onSend}
                >
                  <Text>{state.busy ? "Submitting…" : "Send to Codex Cloud"}</Text>
                </Pressable>
                <Text>
                  Plain text only. Local files, history, model and worktree settings are not
                  transferred. Recent suggestions are not a full environment list.
                </Text>
                <Pressable
                  accessibilityRole="link"
                  className="min-h-11 justify-center px-3"
                  onPress={() => void Linking.openURL("https://chatgpt.com/codex")}
                >
                  <Text>Open Codex Cloud</Text>
                </Pressable>
                <Text>{state.options?.reason}</Text>
                <Text>{state.message}</Text>
                {state.receipt?.url && (
                  <Pressable
                    className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                    accessibilityRole="link"
                    onPress={() => void Linking.openURL(state.receipt!.url!)}
                  >
                    <Text>Open accepted Cloud task</Text>
                  </Pressable>
                )}
                {state.options?.receipts
                  .filter((receipt) => !receipt.url)
                  .map((receipt) => (
                    <Text key={receipt.commandId}>
                      {receipt.branch}: {receipt.message}
                    </Text>
                  ))}
                {(state.pending || state.receipt || state.options?.receipts.length) &&
                  !state.busy && (
                    <Pressable
                      className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                      accessibilityRole="button"
                      onPress={() =>
                        update({
                          acknowledgedCommandIds: [
                            ...state.acknowledgedCommandIds,
                            ...(state.options?.receipts.map((receipt) => receipt.commandId) ?? []),
                            ...(state.pending ? [state.pending.commandId] : []),
                            ...(state.receipt ? [state.receipt.commandId] : []),
                          ],
                          pending: null,
                          receipt: null,
                          message:
                            "Inspect recent tasks first. The next send creates a new submission.",
                        })
                      }
                    >
                      <Text>Prepare another submission</Text>
                    </Pressable>
                  )}
                {state.options?.receipts
                  .filter((receipt) => receipt.url)
                  .map((receipt) => (
                    <Pressable
                      className="min-h-11 justify-center rounded-lg px-3 active:bg-subtle-strong"
                      key={receipt.commandId}
                      accessibilityRole="link"
                      onPress={() => void Linking.openURL(receipt.url!)}
                    >
                      <Text>Cloud task · {receipt.branch}</Text>
                    </Pressable>
                  ))}
              </>
            )}
          </ScrollView>
        </Sheet>
      )}
    </View>
  );
}
