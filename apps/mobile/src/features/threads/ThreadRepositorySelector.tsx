import { useAtomValue } from "@effect/atom-react";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ProjectDiscoverRepositoriesResult,
  ProjectId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { uuidv4 } from "../../lib/uuid";
import { useProjects } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { useNewTaskFlow } from "./new-task-flow-provider";

function RepositoryProjectChoices(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly primaryProjectId: ProjectId;
  readonly repositoryProjectIds: ReadonlyArray<ProjectId>;
  readonly disabled: boolean;
  readonly onChange: (ids: ReadonlyArray<ProjectId>) => void | Promise<void>;
  readonly onPendingChange?: (pending: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<ProjectDiscoverRepositoriesResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [createdProjects, setCreatedProjects] = useState<ReadonlyMap<string, ProjectId>>(new Map());
  const changing = useRef(false);
  const currentParent = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- discards pending registration results after the parent checkout changes or the picker unmounts
  useEffect(() => {
    currentParent.current = true;
    return () => {
      currentParent.current = false;
    };
  }, []);
  const canReadFiles = useEnvironmentScope(props.environmentId, AuthFilesystemReadScope);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const discoverRepositories = useAtomCommand(projectEnvironment.discoverRepositories, {
    reportFailure: false,
  });
  const expand = () => {
    setExpanded(!expanded);
    if (expanded || !canReadFiles || discovering) return;
    setDiscovering(true);
    setDiscoveryError(null);
    return discoverRepositories({
      environmentId: props.environmentId,
      input: { projectId: props.primaryProjectId },
    })
      .then((result) => {
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        if (!currentParent.current) return;
        setDiscovery(result.value);
      })
      .catch((cause: unknown) => {
        setDiscoveryError(
          cause instanceof Error ? cause.message : "Could not find repositories. Try again.",
        );
      })
      .finally(() => setDiscovering(false));
  };
  const selected = new Set([props.primaryProjectId, ...props.repositoryProjectIds]);
  const discoveredRepositories = (canReadFiles ? (discovery?.repositories ?? []) : []).filter(
    (repository) =>
      !props.projects.some((project) => project.id === repository.projectId) &&
      !findProjectByPath(props.projects, repository.workspaceRoot),
  );
  const change = (value: boolean, projectId: ProjectId | undefined, workspaceRoot?: string) => {
    if (props.disabled || changing.current) return;
    changing.current = true;
    setPending(true);
    props.onPendingChange?.(true);
    setError(null);
    return (async () => {
      if (!projectId && workspaceRoot) {
        projectId = ProjectId.make(uuidv4());
        const result = await createProject({
          environmentId: props.environmentId,
          input: {
            ...buildProjectCreateCommand({
              commandId: CommandId.make(uuidv4()),
              projectId,
              workspaceRoot,
            }),
            createWorkspaceRootIfMissing: false,
          },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        const createdProjectId = projectId;
        setCreatedProjects((current) => new Map(current).set(workspaceRoot, createdProjectId));
      }
      if (!projectId || !currentParent.current) return;
      const next = new Set(props.repositoryProjectIds);
      if (value) next.add(projectId);
      else next.delete(projectId);
      await props.onChange([...next]);
    })()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not update projects. Try again.");
      })
      .finally(() => {
        changing.current = false;
        setPending(false);
        props.onPendingChange?.(false);
      });
  };
  return (
    <View className="mx-4 mb-4 overflow-hidden rounded-2xl bg-grouped-card">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        className="min-h-14 flex-row items-center justify-between px-4"
        onPress={() => void expand()}
      >
        <Text className="text-base text-foreground">Projects</Text>
        <Text className="text-sm text-foreground-muted">{selected.size} selected</Text>
      </Pressable>
      {expanded ? (
        <>
          {props.projects.map((project) => (
            <SettingsSwitchRow
              key={project.id}
              label={`${project.title}${project.id === props.primaryProjectId ? " (primary)" : ""}`}
              value={selected.has(project.id)}
              subtitle={
                project.archivedAt
                  ? "Archived. Unarchive this project to attach it."
                  : project.workspaceRoot
              }
              disabled={
                props.disabled ||
                pending ||
                project.id === props.primaryProjectId ||
                project.archivedAt != null
              }
              onValueChange={(value) => void change(value, project.id)}
            />
          ))}
          {discoveredRepositories.map((repository) => {
            const projectId = repository.projectId ?? createdProjects.get(repository.workspaceRoot);
            const unavailable = repository.projectId !== undefined;
            return (
              <SettingsSwitchRow
                key={repository.workspaceRoot}
                label={repository.name}
                subtitle={
                  unavailable
                    ? "Project unavailable. Unarchive it to attach it."
                    : repository.workspaceRoot
                }
                value={projectId !== undefined && selected.has(projectId)}
                disabled={props.disabled || pending || unavailable}
                onValueChange={(value) => void change(value, projectId, repository.workspaceRoot)}
              />
            );
          })}
          {discovering ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">Finding repositories…</Text>
          ) : null}
          {!canReadFiles ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">
              File read access is required to find repositories.
            </Text>
          ) : null}
          {discoveryError || error ? (
            <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-foreground-muted">
              {error ?? discoveryError}
            </Text>
          ) : null}
          {discovery?.truncated ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">
              Search limit reached. Some repositories may be missing.
            </Text>
          ) : null}
          {discovery && discovery.unreadableDirectoryCount > 0 ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">
              Some folders could not be read.
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function ThreadRepositorySelector({ thread }: { readonly thread: EnvironmentThreadShell }) {
  const projects = useProjects().filter(
    (project) => project.environmentId === thread.environmentId,
  );
  const canEdit = useAtomValue(
    orchestrationEnvironment.v2.dispatchCommand.permissionAtom(thread.environmentId),
  );
  const update = useAtomCommand(threadEnvironment.updateMetadata, "thread projects update");
  const repositoryProjectIds = (thread.repositoryAttachments ?? [])
    .filter((entry) => entry.detachedAt === null)
    .map((entry) => entry.projectId);
  return (
    <RepositoryProjectChoices
      key={`${thread.environmentId}:${thread.projectId}:${projects.find((project) => project.id === thread.projectId)?.workspaceRoot}`}
      environmentId={thread.environmentId}
      projects={projects}
      primaryProjectId={thread.projectId}
      repositoryProjectIds={repositoryProjectIds}
      disabled={!canEdit}
      onChange={async (ids) => {
        const result = await update({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, repositoryProjectIds: ids },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }}
    />
  );
}

export function NewTaskRepositorySelector() {
  const flow = useNewTaskFlow();
  const canEdit = useEnvironmentScope(
    flow.selectedProject?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const projects = useProjects().filter(
    (project) => project.environmentId === flow.selectedProject?.environmentId,
  );
  if (!flow.selectedProject) return null;
  return (
    <RepositoryProjectChoices
      key={`${flow.selectedProject.environmentId}:${flow.selectedProject.id}:${flow.selectedProject.workspaceRoot}`}
      environmentId={flow.selectedProject.environmentId}
      projects={projects}
      primaryProjectId={flow.selectedProject.id}
      repositoryProjectIds={flow.repositoryProjectIds}
      disabled={flow.submitting || flow.repositorySelectionPending || !canEdit}
      onChange={flow.setRepositoryProjectIds}
      onPendingChange={flow.setRepositorySelectionPending}
    />
  );
}
