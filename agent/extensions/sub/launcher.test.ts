import { describe, expect, test } from "bun:test";
import { readTopicAgentEnvironment } from "../work/topic-agent/reporter.ts";
import { buildChildEnvironment } from "./launcher.ts";

const topicAgentEnvironment: NodeJS.ProcessEnv = {
  PI_WORK_TOPIC_ID: "topic-123",
  PI_WORK_SOCKET: "/tmp/workd.sock",
  PI_WORK_REGISTRATION_TOKEN: "registration-token",
  PI_WORK_SESSION_ID: "main-session",
  PI_WORK_AFFILIATION: "window-affiliation",
  PI_WORK_TOPIC_NAME: "Topic 123",
};

describe("Delegation Job child environment", () => {
  test("removes Topic Agent identity and preserves other parent configuration", () => {
    const parentEnvironment: NodeJS.ProcessEnv = {
      ...topicAgentEnvironment,
      HOME: "/home/agent",
      PATH: "/usr/local/bin:/usr/bin",
      ANTHROPIC_API_KEY: "model-credential",
      PI_WORK_BASE: "/home/agent/work",
      UNRELATED_VALUE: "kept",
      PI_SUB_JOB_ID: "stale-job",
      PI_SUB_JOB_DIR: "/tmp/stale-job",
      PI_SUB_PARENT_CWD: "/tmp/stale-parent",
    };

    const childEnvironment = buildChildEnvironment(
      { cwd: "/repo", jobId: "job-123", jobDir: "/tmp/sub/job-123" },
      parentEnvironment,
    );

    expect(childEnvironment).toEqual({
      HOME: "/home/agent",
      PATH: "/usr/local/bin:/usr/bin",
      ANTHROPIC_API_KEY: "model-credential",
      PI_WORK_BASE: "/home/agent/work",
      UNRELATED_VALUE: "kept",
      PI_SUB_JOB_ID: "job-123",
      PI_SUB_JOB_DIR: "/tmp/sub/job-123",
      PI_SUB_PARENT_CWD: "/repo",
    });
    expect(readTopicAgentEnvironment(childEnvironment)).toBeUndefined();
    expect(parentEnvironment).toMatchObject(topicAgentEnvironment);
  });
});
