import { useAtomValue } from "@effect/atom-react";
import { threadRepositoryCheckouts } from "@t3tools/client-runtime/thread-repositories";
import { Atom } from "effect/reactivity";

import { useProjects } from "../../state/entities";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { clearReviewCommentTarget } from "./reviewCommentSelection";

const selectedRepository = Atom.family((key: string) =>
  Atom.make("primary").pipe(Atom.keepAlive, Atom.withLabel(`mobile:review:repository:${key}`)),
);
const comparison = Atom.family((key: string) =>
  Atom.make<{ baseRef: string | null; commitSha: string | null }>({
    baseRef: null,
    commitSha: null,
  }).pipe(Atom.keepAlive, Atom.withLabel(`mobile:review:comparison:${key}`)),
);

export function useReviewRepository() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const projects = useProjects().filter(
    (project) => project.environmentId === selectedThread?.environmentId,
  );
  const key = JSON.stringify([selectedThread?.environmentId, selectedThread?.id]);
  const selectionAtom = selectedRepository(key);
  const selection = useAtomValue(selectionAtom);
  const checkouts =
    selectedThread && selectedThreadProject
      ? threadRepositoryCheckouts(
          { ...selectedThread, worktreePath: selectedThreadCwd },
          selectedThreadProject,
          projects,
        )
      : [];
  const historyCheckouts = (selectedThread?.repositoryAttachments ?? [])
    .filter((attachment) => attachment.detachedAt !== null)
    .map((attachment) => ({
      ...attachment,
      title:
        projects.find((project) => project.id === attachment.projectId)?.title ??
        attachment.repositoryIdentity?.displayName ??
        attachment.checkoutPath.split(/[\\/]/u).filter(Boolean).at(-1) ??
        attachment.checkoutPath,
    }));
  const historyCheckout = selection.startsWith("history:")
    ? historyCheckouts.find((candidate) => `history:${candidate.id}` === selection)
    : undefined;
  const checkout =
    historyCheckout ??
    checkouts.find((candidate) => candidate.id === selection) ??
    checkouts[0] ??
    null;
  const cwd = checkout?.checkoutPath ?? selectedThreadCwd;
  const comparisonAtom = comparison(JSON.stringify([key, checkout?.id, cwd]));
  const value = useAtomValue(comparisonAtom);
  return {
    checkouts,
    historyCheckouts,
    isHistorical: historyCheckout !== undefined,
    checkout,
    cwd,
    ...value,
    selectRepository: (id: string) => {
      clearReviewCommentTarget();
      appAtomRegistry.set(selectionAtom, id);
    },
    selectHistory: (id: string) => {
      clearReviewCommentTarget();
      appAtomRegistry.set(selectionAtom, `history:${id}`);
    },
    selectBase: (baseRef: string | null) =>
      appAtomRegistry.set(comparisonAtom, { baseRef, commitSha: null }),
    selectCommit: (commitSha: string | null) =>
      appAtomRegistry.set(comparisonAtom, { ...value, commitSha }),
  };
}
