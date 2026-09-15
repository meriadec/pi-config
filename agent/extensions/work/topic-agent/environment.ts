export interface TopicAgentEnvironment {
  readonly topicId: string;
  readonly socketPath: string;
  readonly registrationToken: string;
  readonly sessionId: string;
  readonly affiliationToken?: string;
  readonly topicName?: string;
}

/** Reads the stable Topic Agent capability environment. Delegation Jobs are always disabled. */
export function readTopicAgentEnvironment(
  env: NodeJS.ProcessEnv,
): TopicAgentEnvironment | undefined {
  if (env["PI_SUB_JOB_ID"] && env["PI_SUB_JOB_DIR"]) return undefined;

  const topicId = env["PI_WORK_TOPIC_ID"];
  const socketPath = env["PI_WORK_SOCKET"];
  const registrationToken = env["PI_WORK_REGISTRATION_TOKEN"];
  const sessionId = env["PI_WORK_SESSION_ID"];
  const affiliationToken = env["PI_WORK_AFFILIATION"];
  const topicName = env["PI_WORK_TOPIC_NAME"];
  if (
    topicId === undefined ||
    topicId.length === 0 ||
    socketPath === undefined ||
    !socketPath.startsWith("/") ||
    registrationToken === undefined ||
    registrationToken.length === 0 ||
    sessionId === undefined ||
    sessionId.length === 0
  ) {
    return undefined;
  }
  return {
    topicId,
    socketPath,
    registrationToken,
    sessionId,
    ...(affiliationToken === undefined || affiliationToken.length === 0
      ? {}
      : { affiliationToken }),
    ...(topicName === undefined || topicName.length === 0 ? {} : { topicName }),
  };
}
