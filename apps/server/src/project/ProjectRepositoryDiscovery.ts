// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import {
  ProjectDiscoverRepositoriesError,
  type ProjectDiscoverRepositoriesInput,
  type ProjectDiscoverRepositoriesResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class ProjectRepositoryDiscovery extends Context.Service<
  ProjectRepositoryDiscovery,
  {
    readonly discover: (
      input: ProjectDiscoverRepositoriesInput,
    ) => Effect.Effect<ProjectDiscoverRepositoriesResult, ProjectDiscoverRepositoriesError>;
  }
>()("t3/project/ProjectRepositoryDiscovery") {}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".venv",
  ".pnpm-store",
  ".yarn",
  ".t3",
  ".expo",
  "__pycache__",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
]);
const MAX_DEPTH = 3;
const MAX_DIRECTORIES = 1_000;
const MAX_ENTRIES = 10_000;
const MAX_REPOSITORIES = 100;

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const vcs = yield* VcsProcess.VcsProcess;
  const path = yield* Path.Path;

  const discover: ProjectRepositoryDiscovery["Service"]["discover"] = Effect.fn(
    "ProjectRepositoryDiscovery.discover",
  )(function* ({ projectId }) {
    const parent = yield* projects
      .getShell(projectId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectDiscoverRepositoriesError({ projectId, failure: "read-projects", cause }),
        ),
      );
    if (Option.isNone(parent)) {
      return yield* new ProjectDiscoverRepositoriesError({
        projectId,
        failure: "project-not-found",
      });
    }
    const root = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(parent.value.workspaceRoot),
      catch: (cause) =>
        new ProjectDiscoverRepositoriesError({ projectId, failure: "read-root", cause }),
    });
    const repositories: Array<ProjectDiscoverRepositoriesResult["repositories"][number]> = [];
    const queue = [{ directory: root, depth: 0 }];
    let truncated = false;
    let unreadableDirectoryCount = 0;
    let entryCount = 0;
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      const scanned = yield* Effect.tryPromise({
        try: async () => {
          const stat = await NodeFSP.lstat(current.directory);
          if (stat.isSymbolicLink()) return null;
          const canonical = await NodeFSP.realpath(current.directory);
          const relative = path.relative(root, canonical);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return null;
          const children: string[] = [];
          let gitMarker = false;
          const directory = await NodeFSP.opendir(canonical);
          for await (const entry of directory) {
            if (++entryCount > MAX_ENTRIES) {
              truncated = true;
              break;
            }
            if (entry.name === ".git" && (entry.isDirectory() || entry.isFile())) gitMarker = true;
            if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
            if (current.depth >= MAX_DEPTH || queue.length + children.length >= MAX_DIRECTORIES) {
              truncated = true;
              continue;
            }
            children.push(path.join(canonical, entry.name));
          }
          return { canonical, gitMarker, children };
        },
        catch: (cause) =>
          new ProjectDiscoverRepositoriesError({ projectId, failure: "read-root", cause }),
      }).pipe(
        Effect.catch((error) => {
          if (current.depth === 0) return Effect.fail(error);
          unreadableDirectoryCount++;
          return Effect.succeed(null);
        }),
      );
      if (scanned !== null) {
        if (current.depth > 0 && scanned.gitMarker) {
          const repository = yield* vcs
            .run({
              operation: "ProjectRepositoryDiscovery.discover",
              command: "git",
              args: ["rev-parse", "--show-toplevel"],
              cwd: scanned.canonical,
              timeoutMs: 5_000,
              maxOutputBytes: 16_384,
              allowNonZeroExit: true,
            })
            .pipe(Effect.option);
          if (Option.isNone(repository) || repository.value.exitCode !== 0)
            unreadableDirectoryCount++;
          if (
            Option.isSome(repository) &&
            repository.value.exitCode === 0 &&
            path.resolve(repository.value.stdout.trim()) === scanned.canonical
          ) {
            repositories.push({
              name: path.basename(scanned.canonical),
              workspaceRoot: scanned.canonical,
            });
            if (repositories.length >= MAX_REPOSITORIES) {
              truncated = true;
              break;
            }
          }
        }
        for (const directory of scanned.children)
          queue.push({ directory, depth: current.depth + 1 });
      }
      if (entryCount > MAX_ENTRIES) break;
    }
    const registered = yield* projects
      .listShells()
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectDiscoverRepositoriesError({ projectId, failure: "read-projects", cause }),
        ),
      );
    const idsByRoot = new Map<string, ProjectId>();
    yield* Effect.forEach(
      registered,
      (project) =>
        Effect.tryPromise({
          try: () => NodeFSP.realpath(project.workspaceRoot),
          catch: (cause) =>
            new ProjectDiscoverRepositoriesError({ projectId, failure: "read-projects", cause }),
        }).pipe(
          Effect.tap((canonical) =>
            Effect.sync(() => {
              idsByRoot.set(canonical, project.id);
            }),
          ),
          Effect.ignore,
        ),
      { concurrency: 16 },
    );
    return {
      repositories: repositories
        .map((repository) => {
          const existingProjectId = idsByRoot.get(repository.workspaceRoot);
          return existingProjectId === undefined
            ? repository
            : { ...repository, projectId: existingProjectId };
        })
        .toSorted((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot)),
      truncated,
      unreadableDirectoryCount,
    };
  });
  return ProjectRepositoryDiscovery.of({ discover });
});

export const layer = Layer.effect(ProjectRepositoryDiscovery, make);
