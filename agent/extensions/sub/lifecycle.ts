import {
  type DelegationJobStatusRecord,
  pathExists,
  readJobStatus,
  resultPath,
  transitionJobStatus,
} from "./mailbox.ts";

export const CHILD_RESULT_WARNING =
  "Delegation Result was not sent. Continue this child or use /sub-done.";

export interface ChildDelegationJob {
  jobId: string;
  jobDir: string;
}

export interface ChildLifecycleWarning {
  show(message: string | undefined): void;
}

/** Coordinates one child session with its durable Job Mailbox lifecycle. */
export class ChildDelegationLifecycle {
  private readonly job: ChildDelegationJob;
  private readonly warning: ChildLifecycleWarning;
  private readonly now: () => Date;

  constructor(
    job: ChildDelegationJob,
    warning: ChildLifecycleWarning,
    now: () => Date = () => new Date(),
  ) {
    this.job = job;
    this.warning = warning;
    this.now = now;
  }

  async restore(): Promise<DelegationJobStatusRecord> {
    const record = await readJobStatus(this.job.jobDir);
    this.warning.show(record.status === "waiting" ? CHILD_RESULT_WARNING : undefined);
    return record;
  }

  async agentStart(): Promise<DelegationJobStatusRecord> {
    const record = await transitionJobStatus(this.job.jobDir, "thinking", this.now());
    this.warning.show(undefined);
    return record;
  }

  async agentSettled(): Promise<DelegationJobStatusRecord> {
    if (await pathExists(resultPath(this.job.jobDir))) {
      const record = await readJobStatus(this.job.jobDir);
      this.warning.show(undefined);
      return record;
    }

    const record = await transitionJobStatus(this.job.jobDir, "waiting", this.now());
    this.warning.show(record.status === "waiting" ? CHILD_RESULT_WARNING : undefined);
    return record;
  }

  completed(): void {
    this.warning.show(undefined);
  }
}
