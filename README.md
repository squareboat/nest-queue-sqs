# AWS SQS Strategy for Nest Queue

Package for AWS SQS strategy package for [@squareboat/nest-queue](https://squareboat.com/open-source/nest-queue/)

## Installation

```bash
npm i @squareboat/nest-queue @squareboat/nest-queue-sqs
```

## Usage

```typescript
import { Module } from "@nestjs/common";
import { QueueModule } from "@squareboat/nest-queue";
import { SqsQueueDriver } from "@squareboat/nest-queue-sqs";

@Module({
  imports: [
    QueueModule.register({
      isGlobal: true,
      default: "notifications",
      connections: {
        notifications: {
          driver: SqsQueueDriver,
          region: "ap-south-1",
          prefix: "https://sqs.ap-south-1.amazonaws.com/123456789012",
          queue: "notifications",
          // credentials: pick one, or leave both out to use the AWS default chain
          // (env vars, ~/.aws, IAM role)
          accessKey: process.env.AWS_ACCESS_KEY_ID,
          secretKey: process.env.AWS_SECRET_ACCESS_KEY,
          // profile: "default",
        },
      },
    }),
  ],
})
export class AppModule {}
```

| Option | Description |
|---|---|
| `region` | Region of the queue. It must match the region in `prefix`. |
| `prefix` | Queue URL without the queue name: `https://sqs.<region>.amazonaws.com/<account-id>` |
| `queue` | Queue name. A full queue URL also works (`prefix` and `suffix` are then not used). |
| `suffix` | Optional, added to the queue name unless it already ends with it (before `.fifo` for FIFO queues), e.g. `-staging`: `orders.fifo` becomes `orders-staging.fifo` |
| `accessKey`, `secretKey` | Access key credentials |
| `profile` | Profile from `~/.aws/credentials`, used instead of access keys |
| `endpoint` | Custom endpoint, e.g. LocalStack or ElasticMQ. Usually not needed: hosts outside AWS in `prefix` are used as the endpoint. |
| `clientConfig` | Optional extra [`SQSClient` options](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/), e.g. `{ maxAttempts: 5 }`. A `requestHandler` options object is merged with the default `{ requestTimeout: 30_000, throwOnRequestTimeout: true }`. |
| `messageGroupId` | FIFO queues: `MessageGroupId` of every message, or a function of the message that returns it. Default `"default"`. |
| `messageDeduplicationId` | FIFO queues: `"random"` (default, a random id per message), `"content"` (none, for queues with content-based deduplication) or a function of the message that returns the id. |

### FIFO queues

For queue URLs ending in `.fifo`, every message is sent with:

- a `MessageGroupId`: the `messageGroupId` option, `"default"` if not set. With one group, the queue is processed in order, one message at a time. To process groups in parallel, return a group per message, e.g. `messageGroupId: (message: InternalMessage) => message.job` (`InternalMessage` comes from `@squareboat/nest-queue`).
- a `MessageDeduplicationId`: a random id, so every dispatched job is delivered, also when the same job is dispatched twice within SQS's 5 minute deduplication window. Set `messageDeduplicationId: "content"` if the queue has content-based deduplication and you want SQS to drop identical messages.
- no `DelaySeconds`: SQS rejects a per-message delay on FIFO queues, so the job's `delay` (nest-queue's default is 10 seconds) is ignored and a warning is logged once. Set `DelaySeconds` on the queue itself instead, and dispatch with `delay: 0` to drop the warning.

If you get `NonExistentQueue` / `QueueDoesNotExist`, compare the queue URL in the SQS console with `prefix` + `/` + `queue` + `suffix`, and check that `region` matches it.

## Other Available Queues

- Sync (Added by default in [@squareboat/nest-queue](https://squareboat.com/open-source/nest-queue/))
- AWS SQS ([@squareboat/nest-queue-sqs](https://github.com/squareboat/nest-queue-sqs))
- Redis ([@squareboat/nest-queue-redis](https://github.com/squareboat/nest-queue-redis))
- RabbitMQ (Coming Soon)

## Documentation

To read the complete documentation, [click here](https://squareboat.com/open-source/nest-queue/docs/drivers).

## Contributing

To know about contributing to this package, read the guidelines [here](./CONTRIBUTING.md)

## About Us

We are a bunch of dreamers, designers, and futurists. We are high on collaboration, low on ego, and take our happy hours seriously. We'd love to hear more about your product. Let's talk and turn your great ideas into something even greater! We have something in store for everyone. [☎️ 📧 Connect with us!](https://squareboat.com/contact)

## License

The MIT License. Please see License File for more information. Copyright © 2020 SquareBoat.

Made with ❤️ by [Squareboat](https://squareboat.com)
