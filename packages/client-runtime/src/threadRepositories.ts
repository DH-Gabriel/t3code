import type {
  OrchestrationProjectShell,
  ProjectId,
  RepositoryIdentity,
  ThreadRepositoryAttachment,
} from "@t3tools/contracts";

export interface ThreadRepositoryCheckout {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly checkoutPath: string;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly title: string;
}

export function threadRepositoryCheckouts(
  thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly repositoryAttachments?: ReadonlyArray<ThreadRepositoryAttachment>;
  },
  primaryProject: Pick<OrchestrationProjectShell, "workspaceRoot" | "title" | "repositoryIdentity">,
  projects: ReadonlyArray<OrchestrationProjectShell> = [],
): ReadonlyArray<ThreadRepositoryCheckout> {
  return [
    {
      id: "primary",
      projectId: thread.projectId,
      checkoutPath: thread.worktreePath ?? primaryProject.workspaceRoot,
      repositoryIdentity: primaryProject.repositoryIdentity ?? null,
      title: primaryProject.title,
    },
    ...(thread.repositoryAttachments ?? [])
      .filter((attachment) => attachment.detachedAt === null)
      .map((attachment) => {
        const project = projects.find(
          (candidate) =>
            candidate.id === attachment.projectId &&
            candidate.workspaceRoot === attachment.checkoutPath,
        );
        return {
          ...attachment,
          repositoryIdentity: project?.repositoryIdentity ?? attachment.repositoryIdentity,
          title:
            project?.title ??
            attachment.repositoryIdentity?.displayName ??
            attachment.repositoryIdentity?.name ??
            attachment.checkoutPath.split(/[\\/]/u).filter(Boolean).at(-1) ??
            attachment.checkoutPath,
        };
      }),
  ];
}
