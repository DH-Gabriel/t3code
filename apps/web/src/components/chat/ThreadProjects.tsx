import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ProjectId,
  type ProjectDiscoverRepositoriesResult,
} from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { readProject, useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentScope } from "~/state/session";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { threadEnvironment } from "~/state/threads";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { newProjectId } from "~/lib/utils";

type RepositoryDiscoveryState =
  | { readonly key: string; readonly status: "loading" }
  | {
      readonly key: string;
      readonly status: "ready";
      readonly result: ProjectDiscoverRepositoriesResult;
    }
  | { readonly key: string; readonly status: "error"; readonly message: string };

export function ThreadProjectPicker({
  threadRef,
  draftId,
}: {
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
}) {
  const thread = useThreadShell(threadRef ?? null);
  const draft = useComposerDraftStore((state) => (draftId ? state.getDraftSession(draftId) : null));
  const environmentId = threadRef?.environmentId ?? draft?.environmentId ?? null;
  const context = thread ?? draft;
  const allProjects = useProjects().filter((project) => project.environmentId === environmentId);
  const projects = allProjects.filter((project) => !project.archivedAt);
  const primaryProject = projects.find((project) => project.id === context?.projectId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { canReadFiles, isPending: fileAccessPending } = useFilesystemReadAccess(environmentId);
  const update = useOrchestrationCommand(threadEnvironment.updateMetadata, { reportFailure: true });
  const createProject = useOrchestrationCommand(projectEnvironment.create, { reportFailure: true });
  const discoverRepositories = useAtomCommand(projectEnvironment.discoverRepositories, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [discoveryState, setDiscoveryState] = useState<RepositoryDiscoveryState | null>(null);
  const [saving, setSaving] = useState(false);
  const discoveryKey =
    environmentId && context
      ? JSON.stringify([environmentId, context.projectId, primaryProject?.workspaceRoot])
      : null;
  const discovery = discoveryState?.key === discoveryKey ? discoveryState : null;
  const selectedIds =
    draft?.repositoryProjectIds ??
    (thread?.repositoryAttachments ?? [])
      .filter((attachment) => attachment.detachedAt === null)
      .map((attachment) => attachment.projectId);
  if (!context || environmentId === null) return null;
  const busy = threadRuntimeIsActive(thread?.runtime);
  const scan = async () => {
    if (!canReadFiles || discoveryKey === null) return;
    const key = discoveryKey;
    setDiscoveryState({ key, status: "loading" });
    const result = await discoverRepositories({
      environmentId,
      input: { projectId: context.projectId },
    });
    setDiscoveryState((current) => {
      if (current?.key !== key) return current;
      if (result._tag === "Success") return { key, status: "ready", result: result.value };
      const error = squashAtomCommandFailure(result);
      return {
        key,
        status: "error",
        message: error instanceof Error ? error.message : "Could not find child repositories.",
      };
    });
  };
  const setProjects = async (repositoryProjectIds: ReadonlyArray<ProjectId>) => {
    if (
      readProject({ environmentId, projectId: context.projectId })?.workspaceRoot !==
      primaryProject?.workspaceRoot
    )
      return;
    if (draftId) {
      const store = useComposerDraftStore.getState();
      const current = store.getDraftSession(draftId);
      if (current?.environmentId !== environmentId || current.projectId !== context.projectId)
        return;
      store.setDraftThreadContext(draftId, { repositoryProjectIds });
      return;
    }
    if (!threadRef) return;
    await update({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        repositoryProjectIds,
      },
    });
  };
  const toggle = async (projectId: ProjectId, checked: boolean) => {
    setSaving(true);
    await setProjects(
      checked ? [...selectedIds, projectId] : selectedIds.filter((id) => id !== projectId),
    ).finally(() => setSaving(false));
  };
  const addRepository = async (
    repository: ProjectDiscoverRepositoriesResult["repositories"][number],
  ) => {
    setSaving(true);
    const target = draftId ?? threadRef;
    if (target) useComposerDraftStore.getState().setRepositorySelectionPending(target, true);
    await (async () => {
      const existing = allProjects.find(
        (project) =>
          normalizeProjectPathForComparison(project.workspaceRoot) ===
          normalizeProjectPathForComparison(repository.workspaceRoot),
      );
      let projectId = repository.projectId ?? existing?.id;
      if (projectId === undefined) {
        const created = await createProject({
          environmentId,
          input: {
            projectId: newProjectId(),
            title: repository.name,
            workspaceRoot: repository.workspaceRoot,
            createWorkspaceRootIfMissing: false,
          },
        });
        if (created._tag !== "Success") return;
        projectId = created.value.id;
      }
      await setProjects([...new Set([...selectedIds, projectId])]);
    })().finally(() => {
      setSaving(false);
      if (target) useComposerDraftStore.getState().setRepositorySelectionPending(target, false);
    });
  };
  const foundRepositories =
    discovery?.status === "ready"
      ? discovery.result.repositories.filter(
          (repository) =>
            !projects.some(
              (project) =>
                project.id === repository.projectId ||
                normalizeProjectPathForComparison(project.workspaceRoot) ===
                  normalizeProjectPathForComparison(repository.workspaceRoot),
            ),
        )
      : [];
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void scan();
      }}
    >
      <PopoverTrigger
        render={<Button size="xs" variant="ghost" />}
        aria-label="Select thread projects"
      >
        Projects · {selectedIds.length + 1}
        <ChevronDownIcon className="size-3" />
      </PopoverTrigger>
      <PopoverPopup width="md" align="end">
        <p className="mb-2 text-sm font-medium">Thread projects</p>
        <div className="max-h-72 overflow-y-auto">
          <div className="mb-2 border-b border-border pb-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-muted-foreground">
                Repositories in {primaryProject?.title ?? "this project"}
              </p>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canReadFiles || discovery?.status === "loading"}
                onClick={() => void scan()}
              >
                {discovery?.status === "loading" ? "Scanning…" : "Refresh"}
              </Button>
            </div>
            {!canReadFiles ? (
              <p className="py-2 text-xs text-muted-foreground">
                {fileAccessPending
                  ? "Checking file access…"
                  : "File access is required to find child repositories."}
              </p>
            ) : null}
            {discovery?.status === "error" ? (
              <p role="alert" className="py-2 text-xs text-destructive">
                {discovery.message}
              </p>
            ) : null}
            {foundRepositories.map((repository) => {
              const archived = allProjects.some(
                (project) => project.id === repository.projectId && project.archivedAt,
              );
              return (
                <label
                  key={repository.workspaceRoot}
                  className="flex cursor-pointer items-center gap-3 py-2"
                >
                  <Checkbox
                    checked={
                      repository.projectId !== undefined &&
                      selectedIds.includes(repository.projectId)
                    }
                    disabled={!canOperate || saving || busy || archived}
                    onCheckedChange={() => void addRepository(repository)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {repository.name}
                      {archived ? " · Archived" : ""}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {repository.workspaceRoot}
                    </span>
                  </span>
                </label>
              );
            })}
            {discovery?.status === "ready" && foundRepositories.length === 0 ? (
              <p className="py-2 text-xs text-muted-foreground">
                No additional repositories found.
              </p>
            ) : null}
            {discovery?.status === "ready" && discovery.result.truncated ? (
              <p className="py-2 text-xs text-muted-foreground">
                The scan reached its limit. Add a project for a deeper folder to find more
                repositories.
              </p>
            ) : null}
            {discovery?.status === "ready" && discovery.result.unreadableDirectoryCount > 0 ? (
              <p className="py-2 text-xs text-muted-foreground">Some folders could not be read.</p>
            ) : null}
          </div>
          {projects.map((project) => (
            <label key={project.id} className="flex cursor-pointer items-center gap-3 py-2">
              <Checkbox
                checked={project.id === context.projectId || selectedIds.includes(project.id)}
                disabled={!canOperate || saving || busy || project.id === context.projectId}
                onCheckedChange={(checked) => void toggle(project.id, checked)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">
                  {project.title}
                  {project.id === context.projectId ? " · Primary" : ""}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {busy
            ? "Projects can change when the turn finishes."
            : "The agent works across these projects. Each checkout keeps its own changes and PRs."}
        </p>
      </PopoverPopup>
    </Popover>
  );
}
