import { QueueDriver, InternalMessage } from "@squareboat/nest-queue-strategy";
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { fromIni } from "@aws-sdk/credential-providers";
import { SqsJob } from "./job";

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

export class SqsQueueDriver implements QueueDriver {
  private client: SQSClient;
  private queueUrl: string;

  constructor(private options: Record<string, any>) {
    if (options.profile) {
      options["credentials"] = fromIni({ profile: options.profile });
    } else if (options.accessKey && options.secretKey) {
      options["credentials"] = {
        accessKeyId: options.accessKey,
        secretAccessKey: options.secretKey,
      };
    }

    // no credentials given: the SDK's default chain is used (env, ~/.aws, IAM role)
    this.client = new SQSClient({
      region: options.region,
      credentials: options.credentials,
      endpoint: options.endpoint || localEndpoint(options.prefix),
    });
    this.queueUrl = options.prefix + "/" + options.queue;
  }

  async push(message: string, rawPayload: InternalMessage): Promise<void> {
    const params = {
      DelaySeconds: rawPayload.delay,
      MessageBody: message,
      QueueUrl: this.options.prefix + "/" + rawPayload.queue,
    };

    await this.client.send(new SendMessageCommand(params));
    return;
  }

  async pull(options: Record<string, any>): Promise<SqsJob | null> {
    const params = {
      MaxNumberOfMessages: 1,
      MessageAttributeNames: ["All"],
      QueueUrl: this.options.prefix + "/" + options.queue,
      VisibilityTimeout: 30,
      WaitTimeSeconds: 20,
    };
    const response = await this.client.send(new ReceiveMessageCommand(params));
    const message = response.Messages ? response.Messages[0] : null;
    return message ? new SqsJob(message) : null;
  }

  async remove(job: SqsJob, options: Record<string, any>): Promise<void> {
    const params = {
      QueueUrl: this.options.prefix + "/" + options.queue,
      ReceiptHandle: job.data.ReceiptHandle,
    };

    await this.client.send(new DeleteMessageCommand(params));

    return;
  }

  async purge(options: Record<string, any>): Promise<void> {
    const params = {
      QueueUrl: this.options.prefix + "/" + options.queue,
    };

    await this.client.send(new PurgeQueueCommand(params));

    return;
  }

  async count(options: Record<string, any>): Promise<number> {
    const params = {
      QueueUrl: this.options.prefix + "/" + options.queue,
      AttributeNames: ["ApproximateNumberOfMessages" as const],
    };
    const response: Record<string, any> = await this.client.send(
      new GetQueueAttributesCommand(params)
    );
    return +response.Attributes.ApproximateNumberOfMessages;
  }
}
