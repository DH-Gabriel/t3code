import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import "~/index.css";

const mocks = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  create: vi.fn(),
  discover: vi.fn(),
}));
vi.mock("~/state/entities", () => ({
  readProject: ({ projectId }: { projectId: ProjectId }) =>
    mocks.projects.find((project) => project.id === projectId) ?? null,
  useProjects: () => mocks.projects,
  useThreadShell: () => null,
  useProject: () => null,
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { create: mocks.create, discoverRepositories: mocks.discover },
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("~/state/use-orchestration-command", () => ({
  useOrchestrationCommand: (command: unknown) => command,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { updateMetadata: vi.fn() } }));

import { ThreadProjectPicker } from "./ThreadProjects";

it.each([
  { name: "unchanged parent", workspaceRoot: "/parent", selectedCount: 1 },
  { name: "moved parent", workspaceRoot: "/moved-parent", selectedCount: 0 },
])(
  "registers selected repos before sending and ignores stale results for $name",
  async ({ workspaceRoot, selectedCount }) => {
    vi.clearAllMocks();
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("parent");
    const draftId = DraftId.make("discovery-draft");
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, {
      threadId: ThreadId.make("draft-thread"),
    });
    mocks.projects = [
      {
        environmentId,
        id: projectId,
        title: "parent",
        workspaceRoot: "/parent",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-11-09T00:00:00Z",
        updatedAt: "2026-11-09T00:00:00Z",
      },
    ];
    mocks.discover.mockResolvedValue(
      AsyncResult.success({
        repositories: [{ name: "backend", workspaceRoot: "/parent/backend" }],
        truncated: false,
        unreadableDirectoryCount: 0,
      }),
    );
    mocks.create.mockResolvedValueOnce(AsyncResult.fail(new Error("Registration failed")));
    using _draft = {
      [Symbol.dispose]() {
        store.clearDraftThread(draftId);
        store.setRepositorySelectionPending(draftId, false);
      },
    };
    await using screen = await render(<ThreadProjectPicker draftId={draftId} />);
    await userEvent.click(screen.getByRole("button", { name: "Select thread projects" }));
    const child = page.getByRole("checkbox", { name: /backend/ });
    await expect.element(child).toBeVisible();
    expect(mocks.create).not.toHaveBeenCalled();
    await userEvent.click(child);
    await expect.element(child).toBeEnabled();
    expect(store.getDraftSession(draftId)?.repositoryProjectIds).toEqual([]);
    expect(store.isRepositorySelectionPending(draftId)).toBe(false);

    let finishRegistration = () => {};
    const registration = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    mocks.create.mockImplementationOnce(async ({ input }: { input: { projectId: ProjectId } }) => {
      await registration;
      return AsyncResult.success({ id: input.projectId });
    });
    await userEvent.click(child);
    await expect.element(child).toBeDisabled();
    expect(store.isRepositorySelectionPending(draftId)).toBe(true);
    mocks.projects = [{ ...mocks.projects[0]!, workspaceRoot }];
    await screen.rerender(<ThreadProjectPicker draftId={draftId} />);
    await act(async () => {
      finishRegistration();
      await registration;
    });
    await expect
      .element(screen.getByRole("button", { name: "Select thread projects" }))
      .toHaveTextContent(`Projects · ${selectedCount + 1}`);
    expect(store.getDraftSession(draftId)?.repositoryProjectIds).toHaveLength(selectedCount);
    expect(store.isRepositorySelectionPending(draftId)).toBe(false);
  },
);
