import { randomUUID } from "node:crypto";
import { QueueDriver, InternalMessage } from "@squareboat/nest-queue-strategy";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SendMessageCommandInput,
  SQSClient,
  SQSClientConfig,
} from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import { SqsJob } from "./job";

/** Options of a `connections.<name>` entry that uses `SqsQueueDriver`. */
export interface SqsQueueDriverOptions {
  /**
   * Region for queue URLs whose host does not name one (ElasticMQ, LocalStack...).
   * AWS queue URLs (`sqs.<region>.amazonaws.com`, VPC endpoints...) are signed with
   * their own region. Default: `AWS_REGION`.
   */
  region?: string;
  /** Queue URL without the queue name: `https://sqs.<region>.amazonaws.com/<account-id>`. */
  prefix?: string;
  /** Queue name, or a full queue URL (`prefix` and `suffix` are then not used). */
  queue?: string;
  /** Added to the queue name unless it already ends with it (before `.fifo`), e.g. `-staging`. */
  suffix?: string;
  /** Access key id, used with `secretKey`. Leave both empty to use the AWS default credential chain. */
  accessKey?: string;
  /** Secret access key, used with `accessKey`. */
  secretKey?: string;
  /** Profile from `~/.aws/credentials` / `~/.aws/config`. Used instead of the access keys. */
  profile?: string;
  /**
   * Credentials (`{ accessKeyId, secretAccessKey, sessionToken }`) or a credential provider.
   * Used when neither `profile` nor `accessKey`/`secretKey` is set.
   */
  credentials?: SQSClientConfig["credentials"];
  /** Endpoint for every request. Usually not needed: requests go to the queue URL's host. */
  endpoint?: string;
  /**
   * Extra `SQSClient` options (`maxAttempts`, `logger`, `requestHandler`...), spread over
   * the ones the driver sets. A `requestHandler` options object is merged with the
   * default `{ requestTimeout: 30_000, throwOnRequestTimeout: true }`.
   */
  clientConfig?: SQSClientConfig;
  /**
   * FIFO queues only: the `MessageGroupId`, or a function that returns it for a message.
   * Messages of one group are delivered in order, one at a time. Default: `"default"`
   * (one group, so the whole queue is processed in order).
   */
  messageGroupId?: string | ((message: InternalMessage) => string);
  /**
   * FIFO queues only: `"random"` (default) sends a random `MessageDeduplicationId` with
   * every push; `"content"` sends none, for queues with content-based deduplication;
   * or a function that returns the id for a message.
   */
  messageDeduplicationId?: "random" | "content" | ((message: InternalMessage) => string);
  [key: string]: any;
}

/** Hosts that name their region, like SDK v2 read it from `sqs.<region>.`. */
const REGION_HOSTS = [
  /^sqs(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/, // sqs.<region>, sqs-fips.<region>
  /^([a-z0-9-]+)\.queue\.amazonaws\.com(?:\.cn)?$/, // legacy <region>.queue.amazonaws.com
  /\.sqs\.([a-z0-9-]+)\.vpce\.amazonaws\.com(?:\.cn)?$/, // VPC endpoints
];

/**
 * SDK v3 has no request timeout by default, so a stalled connection hung pull()
 * forever (v2 had a 120 s socket timeout). 30 s is above ReceiveMessage's 20 s
 * long poll; without throwOnRequestTimeout the SDK only logs a warning.
 */
const DEFAULT_REQUEST_HANDLER = { requestTimeout: 30_000, throwOnRequestTimeout: true };

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
 * Full queue URL from the connection options. `queue` may also be a full URL
 * (then `suffix` is not applied). `suffix` is added to the queue name unless
 * the name already ends with it, before `.fifo` for FIFO queues.
 */
export function buildQueueUrl(prefix: string | undefined, queue: string, suffix = ""): string {
  if (/^https?:\/\//i.test(queue)) return queue;
  const fifo = queue.endsWith(".fifo");
  let name = fifo ? queue.slice(0, -".fifo".length) : queue;
  if (suffix && !name.endsWith(suffix)) name += suffix;
  return `${String(prefix ?? "").replace(/\/+$/, "")}/${name}${fifo ? ".fifo" : ""}`;
}

export class SqsQueueDriver implements QueueDriver {
  private clients = new Map<string, SQSClient>();
  private credentials: SQSClientConfig["credentials"];
  private fifoDelayWarned = false;

  constructor(private options: SqsQueueDriverOptions) {
    const dedup = options.messageDeduplicationId;
    if (dedup !== undefined && typeof dedup !== "function" && dedup !== "random" && dedup !== "content") {
      throw new Error(
        `@squareboat/nest-queue-sqs: messageDeduplicationId must be "random", "content" or a function, got ${JSON.stringify(dedup)}`
      );
    }
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
    return buildQueueUrl(this.options.prefix, queue || this.options.queue || "", this.options.suffix);
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
      const { requestHandler, ...clientConfig } = this.options.clientConfig ?? {};
      client = new SQSClient({
        region,
        credentials: this.credentials,
        endpoint,
        ...clientConfig,
        requestHandler:
          typeof (requestHandler as { handle?: unknown } | undefined)?.handle === "function"
            ? requestHandler // a handler instance
            : { ...DEFAULT_REQUEST_HANDLER, ...(requestHandler as object | undefined) },
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /**
   * Destroys the SDK clients, closing their keep-alive sockets. nest-queue calls it
   * on application shutdown. Later calls open new clients.
   */
  async disconnect(): Promise<void> {
    for (const client of this.clients.values()) client.destroy();
    this.clients.clear();
  }

  async push(message: string, rawPayload: InternalMessage): Promise<void> {
    const QueueUrl = this.urlFor(rawPayload.queue);
    const input: SendMessageCommandInput = { MessageBody: message, QueueUrl };
    if (QueueUrl.endsWith(".fifo")) {
      Object.assign(input, this.fifoParams(rawPayload));
    } else {
      input.DelaySeconds = rawPayload.delay;
    }
    await this.clientFor(QueueUrl).send(new SendMessageCommand(input));
  }

  /**
   * FIFO queues need a MessageGroupId and (without content-based deduplication) a
   * MessageDeduplicationId, and reject a per-message DelaySeconds.
   */
  private fifoParams(message: InternalMessage): Partial<SendMessageCommandInput> {
    const { messageGroupId = "default", messageDeduplicationId: dedup = "random" } = this.options;
    if (message.delay && !this.fifoDelayWarned) {
      this.fifoDelayWarned = true;
      console.warn(
        `@squareboat/nest-queue-sqs: FIFO queues do not support a per-message delay, so "delay" ` +
          `(nest-queue's default is 10 s) is ignored. Set DelaySeconds on the queue instead.`
      );
    }
    return {
      MessageGroupId: typeof messageGroupId === "function" ? messageGroupId(message) : messageGroupId,
      MessageDeduplicationId:
        typeof dedup === "function" ? dedup(message) : dedup === "content" ? undefined : randomUUID(),
    };
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
