import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  canRead: true,
  canEdit: true,
  nextId: 0,
  create: vi.fn(),
  discover: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children: ReactNode;
    accessibilityRole?: "alert";
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../settings/components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (props: {
    label: string;
    value: boolean;
    disabled: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <label>
      {props.label}
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onValueChange(event.target.checked)}
      />
    </label>
  ),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { create: mocks.create, discoverRepositories: mocks.discover },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === "filesystem:read" ? mocks.canRead : mocks.canEdit,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/threads", () => ({ threadEnvironment: {} }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `test-${++mocks.nextId}` }));
vi.mock("./new-task-flow-provider", async () => {
  const { useState } = await import("react");
  return {
    useNewTaskFlow: () => {
      const [repositoryProjectIds, setRepositoryProjectIds] = useState<ProjectId[]>([]);
      return {
        selectedProject: mocks.projects[0],
        submitting: false,
        repositoryProjectIds,
        setRepositoryProjectIds,
      };
    },
  };
});

import { NewTaskRepositorySelector } from "./ThreadRepositorySelector";

function setup(options: { canRead?: boolean } = {}) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.canRead = options.canRead ?? true;
  mocks.canEdit = true;
  mocks.nextId = 0;
  mocks.projects = [
    {
      environmentId: EnvironmentId.make("environment"),
      id: ProjectId.make("parent"),
      title: "parent",
      workspaceRoot: "/parent",
      repositoryIdentity: null,
      defaultModelSelection: null,
      defaultThreadEnvMode: "worktree",
      scripts: [],
      createdAt: "2026-11-09T00:00:00Z",
      updatedAt: "2026-11-09T00:00:00Z",
    },
  ];
  const parent = mocks.projects[0]!;
  mocks.projects.push(
    { ...parent, id: ProjectId.make("known"), title: "known", workspaceRoot: "/parent/known" },
    {
      ...parent,
      id: ProjectId.make("archived"),
      title: "archived",
      workspaceRoot: "/parent/archived",
      archivedAt: "2026-11-09T00:00:00Z",
    },
  );
  mocks.discover.mockResolvedValue(
    AsyncResult.success({
      repositories: [
        { name: "child", workspaceRoot: "/parent/child" },
        { name: "known", workspaceRoot: "/parent/known", projectId: ProjectId.make("known") },
        {
          name: "archived",
          workspaceRoot: "/parent/archived",
          projectId: ProjectId.make("archived"),
        },
      ],
      truncated: false,
      unreadableDirectoryCount: 0,
    }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<NewTaskRepositorySelector />));
  return {
    container,
    render() {
      act(() => root.render(<NewTaskRepositorySelector />));
    },
    async expand() {
      await act(async () => container.querySelector("button")!.click());
    },
    child() {
      return container.querySelector<HTMLInputElement>('input[aria-label="child"]')!;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("keeps failed registrations unattached and reuses a successful registration when reselected", async () => {
  using screen = setup();
  const registered = new Set<ProjectId>();
  mocks.create.mockResolvedValueOnce(AsyncResult.fail(new Error("Registration failed")));
  mocks.create.mockImplementation(async ({ input }: { input: { projectId: ProjectId } }) => {
    registered.add(input.projectId);
    return AsyncResult.success(undefined);
  });

  expect(mocks.discover).not.toHaveBeenCalled();
  await screen.expand();
  expect(registered.size).toBe(0);
  expect(screen.child().checked).toBe(false);
  const knownRows = screen.container.querySelectorAll<HTMLInputElement>(
    'input[aria-label="known"]',
  );
  expect(knownRows).toHaveLength(1);
  await act(async () => knownRows[0]!.click());
  expect(knownRows[0]!.checked).toBe(true);
  expect(registered.size).toBe(0);
  expect(
    screen.container.querySelector<HTMLInputElement>('input[aria-label="archived"]')!.disabled,
  ).toBe(true);

  await act(async () => screen.child().click());
  expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
    "Registration failed",
  );
  expect(screen.child().checked).toBe(false);
  expect(screen.child().disabled).toBe(false);

  await act(async () => screen.child().click());
  expect(screen.child().checked).toBe(true);
  expect(registered.size).toBe(1);
  await act(async () => screen.child().click());
  expect(screen.child().checked).toBe(false);
  await act(async () => screen.child().click());
  expect(screen.child().checked).toBe(true);
  expect(registered.size).toBe(1);
});

it("requires file read access for discovery and operate access for selection", async () => {
  using screen = setup({ canRead: false });
  await screen.expand();
  expect(mocks.discover).not.toHaveBeenCalled();
  expect(screen.container.querySelector('input[aria-label="child"]')).toBeNull();
  await screen.expand();
  mocks.canRead = true;
  mocks.canEdit = false;
  screen.render();
  await screen.expand();
  expect(screen.child().disabled).toBe(true);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("discards a delayed selection when the same project's folder changes", async () => {
  using screen = setup();
  let finish = () => {};
  const registration = new Promise<void>((resolve) => {
    finish = resolve;
  });
  using _registration = {
    [Symbol.dispose]() {
      finish();
    },
  };
  mocks.create.mockImplementation(async () => {
    await registration;
    return AsyncResult.success(undefined);
  });
  await screen.expand();
  await act(async () => screen.child().click());
  expect(screen.child().disabled).toBe(true);
  mocks.projects[0] = { ...mocks.projects[0]!, workspaceRoot: "/moved-parent" };
  screen.render();
  await act(async () => {
    finish();
    await registration;
  });
  expect(screen.container.textContent).toContain("1 selected");
});
