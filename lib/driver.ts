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

/** The host SDK v3 resolves for a region; any other host must be passed as `endpoint`. */
const STANDARD_HOST = /^sqs\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/;

/**
 * Signing region and endpoint for a queue URL. Requests always go to the queue
 * URL's host; for hosts other than sqs.<region>.amazonaws.com (VPC endpoints,
 * FIPS, legacy hosts, ElasticMQ, LocalStack...) that host is also passed as
 * the endpoint, otherwise SDK v3 logs a mismatch warning on every call.
 */
function targetFor(queueUrl: string): { region?: string; endpoint?: string } {
  let url: URL;
  try {
    url = new URL(queueUrl);
  } catch {
    return {};
  }
  const host = url.hostname.toLowerCase();
  const endpoint = STANDARD_HOST.test(host) ? undefined : url.origin;
  if (host === "queue.amazonaws.com") return { region: "us-east-1", endpoint }; // legacy us-east-1 host
  for (const re of REGION_HOSTS) {
    const match = re.exec(host);
    if (match) return { region: match[1], endpoint };
  }
  return { endpoint };
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
    const target = targetFor(queueUrl);
    const region = target.region ?? this.options.region;
    const endpoint = this.options.endpoint || target.endpoint;
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
