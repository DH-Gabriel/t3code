import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type RepositoryIdentity,
} from "@t3tools/contracts";

import { nativePullRequestDestination } from "./pullRequestNavigation";

const environmentId = EnvironmentId.make("environment");
const project = (name: string) => ({
  id: ProjectId.make(name),
  environmentId,
  repositoryIdentity: {
    canonicalKey: `github.com/acme/${name}`,
    provider: SourceControlProviderKind.make("github"),
    displayName: `acme/${name}`,
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: `https://github.com/acme/${name}`,
    },
  } satisfies RepositoryIdentity,
});

describe("nativePullRequestDestination", () => {
  it("opens the linked repository's project and never lends the primary project to another repository", () => {
    const primary = project("primary");
    const attached = project("attached");
    const context = { environmentId, projectId: primary.id };
    const url = "https://github.com/acme/attached/pull/42";
    expect(
      nativePullRequestDestination(url, context, [primary, attached], () => true),
    ).toMatchObject({ projectId: attached.id, repository: "acme/attached", number: 42 });
    expect(nativePullRequestDestination(url, context, [primary], () => true)).toBeNull();
    expect(
      nativePullRequestDestination(
        url,
        context,
        [primary, { ...attached, environmentId: EnvironmentId.make("other") }],
        () => true,
      ),
    ).toBeNull();
  });
});
