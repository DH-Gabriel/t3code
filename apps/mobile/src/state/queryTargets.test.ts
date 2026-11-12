import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildCheckpointDiffTargets } from "./queryTargets";

describe("buildCheckpointDiffTargets", () => {
  it.each([0, 2])(
    "keeps repository history isolated for ranges beginning at %i",
    (fromTurnCount) => {
      const target = {
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("thread"),
        fromTurnCount,
        toTurnCount: fromTurnCount + 1,
        ignoreWhitespace: false,
      };
      const primary = buildCheckpointDiffTargets(target);
      const attached = buildCheckpointDiffTargets({
        ...target,
        repositoryAttachmentId: "extra-repo",
      });
      expect((attached.turn ?? attached.fullThread)?.input).toMatchObject({
        repositoryAttachmentId: "extra-repo",
      });
      expect((primary.turn ?? primary.fullThread)?.input).not.toHaveProperty(
        "repositoryAttachmentId",
      );
      expect(attached).not.toEqual(primary);
    },
  );
});
