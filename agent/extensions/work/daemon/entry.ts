#!/usr/bin/env bun
import { createConfigStore, createTopicStore, createWorkPaths } from "../shared/index.ts";
import { I3KittyDesktopController } from "./desktop.ts";
import { MainAgentManager } from "./main-agent.ts";
import { LocalProcessRunner } from "./process-runner.ts";
import { TopicProvisioner } from "./provisioner.ts";
import { PullRequestObserver } from "./pull-request-observer.ts";
import { WorkDaemon } from "./server.ts";
import { TopicService } from "./topic-service.ts";

export async function runWorkDaemon(): Promise<void> {
  const paths = createWorkPaths();
  const topics = createTopicStore(paths);
  const runner = new LocalProcessRunner();
  const desktop = new I3KittyDesktopController({
    runner,
    ...(process.env["PI_WORK_NODE_EXECUTABLE"] === undefined
      ? {}
      : { nodeCommand: process.env["PI_WORK_NODE_EXECUTABLE"] }),
    ...(process.env["PI_WORK_PI_EXECUTABLE"] === undefined
      ? {}
      : { piCommand: process.env["PI_WORK_PI_EXECUTABLE"] }),
    ...(process.env["PI_WORK_SHELL"] === undefined
      ? {}
      : { shellCommand: process.env["PI_WORK_SHELL"] }),
  });
  const mainAgent = new MainAgentManager({ topics, desktop, socketPath: paths.socket });
  const ghCommand = process.env["PI_WORK_GH_EXECUTABLE"];
  const topicService = new TopicService({
    config: createConfigStore(paths),
    topics,
    provisioner: new TopicProvisioner({
      topics,
      runner,
      ...(ghCommand === undefined ? {} : { ghCommand }),
    }),
    desktop,
    mainAgent,
    pullRequests: new PullRequestObserver({
      runner,
      ...(ghCommand === undefined ? {} : { ghCommand }),
    }),
  });
  const daemon = new WorkDaemon({
    socketPath: paths.socket,
    topicService,
    mainAgent,
    ...(process.env["XDG_RUNTIME_DIR"] === undefined
      ? {}
      : { runtimeDirectory: process.env["XDG_RUNTIME_DIR"] }),
  });
  let shutdownStarted = false;
  const shutdown = (): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void daemon.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await daemon.start();
}

if (import.meta.main) {
  runWorkDaemon().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown daemon startup error.";
    console.error(`pi-workd: ${message}`);
    process.exitCode = 1;
  });
}
