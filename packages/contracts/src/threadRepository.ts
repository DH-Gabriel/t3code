import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";

export const ThreadRepositoryAttachment = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  checkoutPath: TrimmedNonEmptyString,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  attachedAt: IsoDateTime,
  detachedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadRepositoryAttachment = typeof ThreadRepositoryAttachment.Type;
