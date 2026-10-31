import { QueueDriver, InternalMessage } from "@squareboat/nest-queue-strategy";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  SQSClientConfig,
} from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import { SqsJob } from "./job";

/** Hosts that name their region, like SDK v2 read it from `sqs.<region>.`. */
const REGION_HOSTS = [
  /^sqs(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/, // sqs.<region>, sqs-fips.<region>
  /^([a-z0-9-]+)\.queue\.amazonaws\.com(?:\.cn)?$/, // legacy <region>.queue.amazonaws.com
  /\.sqs\.([a-z0-9-]+)\.vpce\.amazonaws\.com(?:\.cn)?$/, // VPC endpoints
];

/** Region named by the queue URL's host, if any. */
function regionFromUrl(queueUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(queueUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === "queue.amazonaws.com") return "us-east-1"; // legacy us-east-1 host
  for (const re of REGION_HOSTS) {
    const match = re.exec(host);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Requests always go to the queue URL's host. For hosts outside AWS
 * (ElasticMQ, LocalStack...) pass that host as the endpoint too, otherwise
 * SDK v3 logs a mismatch warning on every call.
 */
function localEndpoint(prefix: unknown): string | undefined {
  if (typeof prefix !== "string") return undefined;
  try {
    const url = new URL(prefix);
    return /\.amazonaws\.com(\.cn)?$/i.test(url.hostname) ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Full queue URL from the connection options. `queue` may also be a full URL.
 * `suffix` (documented, but ignored before 0.1.0) is added to the queue name,
 * before `.fifo` for FIFO queues.
 */
export function buildQueueUrl(prefix: string | undefined, queue: string, suffix = ""): string {
  if (/^https?:\/\//i.test(queue)) return queue;
  let name = queue;
  if (suffix && !name.endsWith(suffix)) {
    name = name.endsWith(".fifo") ? name.slice(0, -".fifo".length) + suffix + ".fifo" : name + suffix;
  }
  return `${String(prefix ?? "").replace(/\/+$/, "")}/${name}`;
}

export class SqsQueueDriver implements QueueDriver {
  private clients = new Map<string, SQSClient>();
  private queueUrl: string;
  private credentials: SQSClientConfig["credentials"];

  constructor(private options: Record<string, any>) {
    if (options.profile) {
      this.credentials = fromIni({ profile: options.profile });
    } else if (options.accessKey && options.secretKey) {
      this.credentials = {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      };
    } else {
      // undefined: the SDK's default chain is used (env, ~/.aws, IAM role)
      this.credentials = options.credentials;
    }

    this.queueUrl = this.urlFor(options.queue);
    this.clientFor(this.queueUrl);
  }

  private urlFor(queue: string | undefined): string {
    return buildQueueUrl(this.options.prefix, queue || this.options.queue, this.options.suffix);
  }

  /**
   * SDK v3 signs with the client's region, while v2 took it from the queue
   * URL. Sign with the URL's region when it has one (one client per region),
   * else with `region` / AWS_REGION.
   */
  private clientFor(queueUrl: string): SQSClient {
    const region = regionFromUrl(queueUrl) ?? this.options.region;
    const endpoint = this.options.endpoint || localEndpoint(this.options.prefix || this.queueUrl);
    const key = `${region}|${endpoint}`;
    let client = this.clients.get(key);
    if (!client) {
      client = new SQSClient({ region, credentials: this.credentials, endpoint });
      this.clients.set(key, client);
    }
    return client;
  }

  async push(message: string, rawPayload: InternalMessage): Promise<void> {
    const QueueUrl = this.urlFor(rawPayload.queue);
    await this.clientFor(QueueUrl).send(
      new SendMessageCommand({ DelaySeconds: rawPayload.delay, MessageBody: message, QueueUrl })
    );
  }

  async pull(options: Record<string, any>): Promise<SqsJob | null> {
    const QueueUrl = this.urlFor(options.queue);
    const response = await this.clientFor(QueueUrl).send(
      new ReceiveMessageCommand({
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ["All"],
        QueueUrl,
        VisibilityTimeout: 30,
        WaitTimeSeconds: 20,
      })
    );
    const message = response.Messages ? response.Messages[0] : null;
    return message ? new SqsJob(message) : null;
  }

  async remove(job: SqsJob, options: Record<string, any>): Promise<void> {
    const QueueUrl = this.urlFor(options.queue);
    await this.clientFor(QueueUrl).send(
      new DeleteMessageCommand({ QueueUrl, ReceiptHandle: job.data.ReceiptHandle })
    );
  }

  async purge(options: Record<string, any>): Promise<void> {
    const QueueUrl = this.urlFor(options.queue);
    await this.clientFor(QueueUrl).send(new PurgeQueueCommand({ QueueUrl }));
  }

  async count(options: Record<string, any>): Promise<number> {
    const QueueUrl = this.urlFor(options.queue);
    const response = await this.clientFor(QueueUrl).send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["ApproximateNumberOfMessages"] })
    );
    return +(response.Attributes?.ApproximateNumberOfMessages ?? 0);
  }
}
