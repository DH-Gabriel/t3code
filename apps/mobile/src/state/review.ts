import { createReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/review";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const EMPTY_GIT_SECTIONS = Object.freeze<ReadonlyArray<ReviewDiffPreviewSource>>([]);

// The last answered preview per worktree, so review keeps showing git sections while the live
// query is not mounted. useReviewSections still hides them unless the session grants file reads.
const lastGitSectionsFamily = Atom.family((key: string) =>
  Atom.make({ comparisonKey: "", sources: EMPTY_GIT_SECTIONS }).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:review:git-sections:${key}`),
  ),
);

const lastComparisonSectionsFamily = Atom.family((key: string) => {
  const [checkoutKey, comparisonKey] = JSON.parse(key) as [string, string];
  return Atom.make((get) => {
    const value = get(lastGitSectionsFamily(checkoutKey));
    return value.comparisonKey === comparisonKey ? value.sources : EMPTY_GIT_SECTIONS;
  });
});

export function lastReviewGitSectionsAtom(
  environmentId: EnvironmentId,
  cwd: string,
  baseRef?: string | null,
  commitSha?: string | null,
) {
  return lastComparisonSectionsFamily(
    JSON.stringify([
      JSON.stringify([environmentId, cwd]),
      JSON.stringify([baseRef ?? null, commitSha ?? null]),
    ]),
  );
}

export const reviewEnvironment = createReviewEnvironmentAtoms(connectionAtomRuntime, {
  onDiffPreviewAnswer: (target, value, registry) => {
    const atom = lastGitSectionsFamily(JSON.stringify([target.environmentId, target.input.cwd]));
    const comparisonKey = JSON.stringify([
      target.input.baseRef ?? null,
      target.input.commitSha ?? null,
    ]);
    return Effect.sync(() => registry.set(atom, { comparisonKey, sources: value.sources }));
  },
});
