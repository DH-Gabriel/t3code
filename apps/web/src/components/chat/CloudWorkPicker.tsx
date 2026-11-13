import { useState } from "react";
import { CloudIcon, LaptopIcon, ChevronDownIcon, ArrowUpIcon, CheckIcon } from "lucide-react";
import { ComposerControl } from "./ComposerControl";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuGroup, MenuGroupLabel } from "../ui/menu";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";
import { useAtomValue } from "@effect/atom-react";
import { cloudComposerAtom, cloudComposerKey } from "@t3tools/client-runtime/state/codex-cloud";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  CodexCloudEnvironmentId,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { codexCloud } from "../../state/codexCloud";
import { environmentServerConfigsAtom } from "../../state/server";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function CloudWorkPicker({
  environmentId,
  projectId,
  onSend,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onSend: () => void;
}) {
  const atom = cloudComposerAtom(cloudComposerKey(environmentId, projectId));
  const state = useAtomValue(atom);
  const canSubmit = useAtomValue(codexCloud.submit.permissionAtom(environmentId));
  const canSave = useAtomValue(codexCloud.saveEnvironment.permissionAtom(environmentId));
  const [setupOpen, setSetupOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const canRead = useAtomValue(codexCloud.options.permissionAtom(environmentId));
  const configs = useAtomValue(environmentServerConfigsAtom);
  const providers =
    configs.get(environmentId)?.providers.filter((provider) => provider.driver === "codex") ?? [];
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
    setLoading(true);
    const result = await runAtomCommand(
      appAtomRegistry,
      codexCloud.options,
      { environmentId, input: scope(id) },
      { reportFailure: false },
    );
    setLoading(false);
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
  const hostLabel = configs.get(environmentId)?.environment.label ?? "Connected computer";
  const selectedEnvironment = environments.find((entry) => entry.id === state.environmentId);
  const previousReceipts = [
    ...(state.receipt ? [state.receipt] : []),
    ...(state.options?.receipts ?? []),
  ].filter((receipt) => receipt.status !== "failed");
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1 text-xs">
      <Menu>
        <MenuTrigger render={<ComposerControl size="xs" aria-label="Work in" />}>
          {state.enabled ? <CloudIcon /> : <LaptopIcon />}
          {state.enabled ? "Codex Cloud" : hostLabel}
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup side="top" align="start">
          <MenuGroup>
            <MenuGroupLabel>Work in</MenuGroupLabel>
            <MenuItem onClick={() => update({ enabled: false })}>
              <LaptopIcon />
              {hostLabel}
              {!state.enabled && <CheckIcon />}
            </MenuItem>
            <MenuItem
              onClick={() => {
                update({ enabled: true });
                setSetupOpen(true);
              }}
            >
              <CloudIcon />
              Codex Cloud
              {state.enabled && <CheckIcon />}
            </MenuItem>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {state.enabled && (
        <>
          <Popover open={setupOpen} onOpenChange={setSetupOpen}>
            <PopoverTrigger render={<ComposerControl size="xs" aria-label="Cloud environment" />}>
              {selectedEnvironment?.label ?? (state.environmentId || "Choose environment")}
              <ChevronDownIcon />
            </PopoverTrigger>
            <PopoverPopup side="top" align="start" width="md">
              <div className="flex flex-col gap-3 text-sm">
                <div className="font-medium">Codex Cloud</div>
                <label className="flex flex-col gap-1">
                  Codex CLI account
                  <select
                    aria-label="Codex CLI account"
                    value={state.providerInstanceId}
                    disabled={state.busy || !!state.pending}
                    onChange={(event) => {
                      update({
                        providerInstanceId: event.target.value,
                        options: null,
                        receipt: null,
                        environmentId: "",
                        label: "",
                        message: null,
                      });
                      void refresh(event.target.value);
                    }}
                  >
                    <option value="">Choose an account</option>
                    {providers.map((provider) => (
                      <option key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName ?? provider.instanceId}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canRead || !state.providerInstanceId || state.busy || loading}
                  onClick={() => void refresh(state.providerInstanceId)}
                >
                  {loading ? "Loading…" : "Refresh saved and recent"}
                </Button>
                {state.options?.reason && (
                  <p role="status" className="text-muted-foreground">
                    {state.options.reason}
                  </p>
                )}
                {environments.length > 0 && (
                  <label className="flex flex-col gap-1">
                    Saved and recent environments
                    <select
                      aria-label="Saved and recent Cloud environments"
                      value={state.environmentId}
                      disabled={state.busy || !!state.pending}
                      onChange={(event) => {
                        const entry = environments.find(
                          (candidate) => candidate.id === event.target.value,
                        );
                        update({ environmentId: event.target.value, label: entry?.label ?? "" });
                      }}
                    >
                      <option value="">Choose an environment</option>
                      {environments.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="flex flex-col gap-1">
                  Environment ID
                  <Input
                    aria-label="Cloud environment ID"
                    placeholder="Paste an environment ID"
                    value={state.environmentId}
                    disabled={state.busy || !!state.pending}
                    onChange={(event) => update({ environmentId: event.target.value })}
                  />
                </label>
                <div className="flex items-end gap-2">
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    Label
                    <Input
                      aria-label="Environment label"
                      placeholder="Optional"
                      value={state.label}
                      disabled={state.busy || !!state.pending}
                      onChange={(event) => update({ label: event.target.value })}
                    />
                  </label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      !canSave ||
                      !state.providerInstanceId ||
                      !state.environmentId.trim() ||
                      state.busy ||
                      loading
                    }
                    onClick={() => void saveEnvironment()}
                  >
                    Save
                  </Button>
                  {state.options?.saved.some((entry) => entry.id === state.environmentId) && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!canSave || state.busy}
                      onClick={() => void saveEnvironment(true)}
                    >
                      Forget saved
                    </Button>
                  )}
                </div>
                <label className="flex flex-col gap-1">
                  Published branch
                  <Input
                    aria-label="Cloud branch"
                    placeholder="main"
                    value={state.branch}
                    disabled={state.busy || !!state.pending}
                    onChange={(event) => update({ branch: event.target.value })}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Runs separately using this CLI account. Send plain text; local files and chat
                  history stay here. Recent suggestions may not include every environment.
                </p>
                <a
                  href="https://chatgpt.com/codex"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open Codex Cloud
                </a>
                {state.options?.receipts.map((receipt) =>
                  receipt.url ? (
                    <a
                      key={receipt.commandId}
                      href={receipt.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Cloud task · {receipt.branch}
                    </a>
                  ) : (
                    <p key={receipt.commandId} role="status">
                      {receipt.message}
                    </p>
                  ),
                )}
                {(state.pending || previousReceipts.length > 0) && !state.busy && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      update({
                        acknowledgedCommandIds: [
                          ...state.acknowledgedCommandIds,
                          ...previousReceipts.map((receipt) => receipt.commandId),
                          ...(state.pending ? [state.pending.commandId] : []),
                        ],
                        pending: null,
                        receipt: null,
                        message:
                          "Check recent tasks first. Your next send starts a new submission.",
                      })
                    }
                  >
                    {state.pending ||
                    previousReceipts.some((receipt) => receipt.status === "unknown")
                      ? "I checked recent tasks. Prepare a new submission"
                      : "Prepare another submission"}
                  </Button>
                )}
                <Button type="button" size="sm" onClick={() => setSetupOpen(false)}>
                  Done
                </Button>
              </div>
            </PopoverPopup>
          </Popover>
          {state.branch && <span className="text-muted-foreground">{state.branch}</span>}
          <div className="ms-auto">
            <Button
              type="button"
              size="sm"
              disabled={
                !canSubmit ||
                state.busy ||
                state.options?.available !== true ||
                !state.environmentId.trim() ||
                !state.branch.trim()
              }
              onClick={onSend}
              aria-label="Send to Codex Cloud"
            >
              {state.busy ? "Submitting…" : <ArrowUpIcon />}
            </Button>
          </div>
          {state.message && (
            <p role="status" className="w-full px-1 text-muted-foreground">
              {state.message}
            </p>
          )}
          {state.receipt?.url && (
            <a href={state.receipt.url} target="_blank" rel="noreferrer" className="px-1 underline">
              Open Cloud task
            </a>
          )}
        </>
      )}
    </div>
  );
}
