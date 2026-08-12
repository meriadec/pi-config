import type { ActionId, ActionPolicy, WorkPolicies } from "./domain.ts";

export type PolicySource =
  | { level: "topic"; key: string }
  | { level: "repository"; key: string }
  | { level: "global" };

export interface ResolvedPolicy {
  policy: ActionPolicy;
  source: PolicySource;
}

export function resolveActionPolicy(
  policies: WorkPolicies,
  action: ActionId,
  subject: { topicId: string; repository: string },
): ResolvedPolicy {
  const topicPolicy = policies.topics[subject.topicId]?.[action];
  if (topicPolicy !== undefined) {
    return { policy: topicPolicy, source: { level: "topic", key: subject.topicId } };
  }
  const repositoryPolicy = policies.repositories[subject.repository]?.[action];
  if (repositoryPolicy !== undefined) {
    return { policy: repositoryPolicy, source: { level: "repository", key: subject.repository } };
  }
  const policy = policies.defaults[action];
  if (policy === undefined) {
    throw new Error(`No global policy exists for ${action}.`);
  }
  return { policy, source: { level: "global" } };
}
