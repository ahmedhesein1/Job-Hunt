import type { InsertJobInput, InsertResult, JobItem } from '../../src/data/jobs';

/** In-memory store with the same conditional semantics as the DynamoDB transaction. */
export class FakeStore {
  jobs = new Map<string, Record<string, unknown>>();
  dedupe = new Map<string, { clusterId: string; firstJobId: string }>();
  outbox = new Map<string, Record<string, unknown>>();
  attached: Array<{ jobId: string; sourceId: string }> = [];
  capRemaining = Number.POSITIVE_INFINITY;

  lookupDedupe = async (urlHash: string | undefined, fpHash: string) => {
    const out: { url?: { clusterId: string; firstJobId: string }; fp?: { clusterId: string; firstJobId: string } } = {};
    const u = urlHash ? this.dedupe.get(`URL#${urlHash}`) : undefined;
    const f = this.dedupe.get(`FP#${fpHash}`);
    if (u) out.url = u;
    if (f) out.fp = f;
    return out;
  };
  getJob = async (id: string) => this.jobs.get(id) as JobItem | undefined;
  attachDuplicate = async (jobId: string, sourceId: string) => {
    this.attached.push({ jobId, sourceId });
    return true;
  };
  insertJob = async (input: InsertJobInput): Promise<InsertResult> => {
    if (this.jobs.has(input.jobId)) return 'exists';
    if ((input.urlHash && this.dedupe.has(`URL#${input.urlHash}`)) || (input.fpHash && this.dedupe.has(`FP#${input.fpHash}`))) return 'dedupe-race';
    if (input.capUpdate) {
      if (this.capRemaining <= 0) return 'cap-reached';
      this.capRemaining -= 1;
    }
    this.jobs.set(input.jobId, input.jobItem);
    if (input.urlHash) this.dedupe.set(`URL#${input.urlHash}`, { clusterId: input.clusterId, firstJobId: input.jobId });
    if (input.fpHash) this.dedupe.set(`FP#${input.fpHash}`, { clusterId: input.clusterId, firstJobId: input.jobId });
    if (input.notificationPut) this.outbox.set(String(input.notificationPut.Item.PK), input.notificationPut.Item);
    return 'created';
  };
}
