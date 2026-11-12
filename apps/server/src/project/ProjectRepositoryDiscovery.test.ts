// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, type OrchestrationProjectShell } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ProjectRepositoryDiscovery from "./ProjectRepositoryDiscovery.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

const projectId = ProjectId.make("parent");
const project = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id,
  workspaceRoot,
  title: id,
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  projectIcon: null,
  scripts: [],
  pinnedAt: null,
  archivedAt: null,
  createdAt: "2026-11-09T00:00:00.000Z",
  updatedAt: "2026-11-09T00:00:00.000Z",
});

const git = Effect.fn("ProjectRepositoryDiscovery.test.git")(function* (
  cwd: string,
  args: string[],
) {
  const process = yield* VcsProcess.VcsProcess;
  yield* process.run({ operation: "discovery-test", command: "git", cwd, args, timeoutMs: 10_000 });
});

const fixture = Effect.fn("ProjectRepositoryDiscovery.test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-repository-discovery-" });
  const canonicalRoot = yield* fs.realPath(root);
  const registered = [project(projectId, canonicalRoot)];
  const service = yield* ProjectRepositoryDiscovery.ProjectRepositoryDiscovery.pipe(
    Effect.provide(
      ProjectRepositoryDiscovery.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            getShell: (id) =>
              Effect.succeed(Option.fromNullishOr(registered.find((entry) => entry.id === id))),
            listShells: () => Effect.succeed(registered),
          }),
        ),
      ),
    ),
  );
  const init = (relativePath: string) => git(root, ["init", path.join(root, relativePath)]);
  return { root: canonicalRoot, fs, path, registered, service, init };
});

const layer = VcsProcess.layer.pipe(
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-discovery-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer, { excludeTestServices: true })("ProjectRepositoryDiscovery", (it) => {
  it.effect(
    "finds child repositories under a plain folder and reuses registered canonical paths",
    () =>
      Effect.gen(function* () {
        const { root, service, init, registered } = yield* fixture();
        yield* init("auth");
        yield* init("group/creator");
        registered.push(project(ProjectId.make("auth"), `${root}/auth/../auth`));
        expect(yield* service.discover({ projectId })).toEqual({
          repositories: [
            { name: "auth", workspaceRoot: `${root}/auth`, projectId: "auth" },
            { name: "creator", workspaceRoot: `${root}/group/creator` },
          ],
          truncated: false,
          unreadableDirectoryCount: 0,
        });
        expect(registered).toHaveLength(2);
      }),
  );

  it.effect(
    "scans inside a parent repository without treating ordinary folders as repositories",
    () =>
      Effect.gen(function* () {
        const { root, fs, service, init } = yield* fixture();
        yield* init(".");
        yield* fs.makeDirectory(`${root}/ordinary`, { recursive: true });
        yield* init("ordinary/child");
        expect((yield* service.discover({ projectId })).repositories).toEqual([
          { name: "child", workspaceRoot: `${root}/ordinary/child` },
        ]);
      }),
  );

  it.effect("supports worktrees with a .git file and skips cache folders and symlinks", () =>
    Effect.gen(function* () {
      const { root, fs, service, init } = yield* fixture();
      yield* init("source");
      yield* git(`${root}/source`, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      yield* git(`${root}/source`, ["worktree", "add", "../worktree"]);
      yield* init("node_modules/hidden");
      yield* init(".cache/hidden");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-outside-" });
      yield* git(outside, ["init"]);
      if ((yield* HostProcess.Platform) !== "win32") {
        yield* fs.symlink(outside, `${root}/escape`);
        yield* fs.symlink(`${root}/source`, `${root}/alias`);
      }
      expect(
        (yield* service.discover({ projectId })).repositories.map((entry) => entry.name),
      ).toEqual(["source", "worktree"]);
    }),
  );

  it.effect("reports incomplete scans at the depth and directory limits", () =>
    Effect.gen(function* () {
      const { root, fs, service, init } = yield* fixture();
      yield* init("a/b/visible");
      yield* init("a/b/visible/deeper");
      const depth = yield* service.discover({ projectId });
      expect(depth.repositories.map((entry) => entry.name)).toEqual(["visible"]);
      expect(depth.truncated).toBe(true);
      yield* Effect.forEach(
        Array.from({ length: 1_001 }, (_, index) => `${root}/dir-${index}`),
        (directory) => fs.makeDirectory(directory),
        { concurrency: 16 },
      );
      expect((yield* service.discover({ projectId })).truncated).toBe(true);
    }),
  );

  it.effect("bounds large folders and repository result sets", () =>
    Effect.gen(function* () {
      const repositories = yield* fixture();
      yield* Effect.forEach(
        Array.from({ length: 101 }, (_, index) => `repo-${index}`),
        repositories.init,
        { concurrency: 8 },
      );
      const result = yield* repositories.service.discover({ projectId });
      expect(result.repositories).toHaveLength(100);
      expect(result.truncated).toBe(true);

      const files = yield* fixture();
      yield* Effect.forEach(
        Array.from({ length: 10_001 }, (_, index) => `${files.root}/file-${index}`),
        (file) => files.fs.writeFileString(file, ""),
        { concurrency: 32 },
      );
      expect(yield* files.service.discover({ projectId })).toEqual({
        repositories: [],
        truncated: true,
        unreadableDirectoryCount: 0,
      });
    }),
  );

  it.effect("reports unreadable children and fails when the registered root cannot be read", () =>
    Effect.gen(function* () {
      const { root, fs, service } = yield* fixture();
      yield* fs.makeDirectory(`${root}/blocked`);
      const { opendir } = yield* Effect.promise(() =>
        vi.importActual<typeof NodeFSP>("node:fs/promises"),
      );
      using _read = vi.spyOn(NodeFSP, "opendir").mockImplementation((...args) => {
        if (args[0] === `${root}/blocked`)
          return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
        return opendir(...args);
      });
      expect((yield* service.discover({ projectId })).unreadableDirectoryCount).toBe(1);
      yield* fs.makeDirectory(`${root}/broken`);
      yield* fs.writeFileString(`${root}/broken/.git`, "gitdir: missing\n");
      expect((yield* service.discover({ projectId })).unreadableDirectoryCount).toBe(2);
      yield* fs.remove(root, { recursive: true });
      expect(yield* service.discover({ projectId }).pipe(Effect.flip)).toMatchObject({
        failure: "read-root",
      });
      yield* fs.writeFileString(root, "replaced");
      expect(yield* service.discover({ projectId }).pipe(Effect.flip)).toMatchObject({
        failure: "read-root",
      });
      expect(
        yield* service.discover({ projectId: ProjectId.make("missing") }).pipe(Effect.flip),
      ).toMatchObject({ failure: "project-not-found" });
    }),
  );
});
