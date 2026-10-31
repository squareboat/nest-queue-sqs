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
          prefix: "https://sqs.ap-south-1.amazonaws.com/123456789012",
          queue: "notifications",
          // credentials: pick one, or leave them out (or empty) to use the AWS default
          // chain (env vars, ~/.aws, IAM role)
          accessKey: process.env.AWS_ACCESS_KEY_ID ?? "",
          secretKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
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
| `prefix` | Queue URL without the queue name: `https://sqs.<region>.amazonaws.com/<account-id>`. VPC endpoint, FIPS and legacy `queue.amazonaws.com` URLs work too. |
| `queue` | Queue name. A full queue URL also works (`prefix` and `suffix` are then not used). |
| `suffix` | Optional, added to the queue name unless it already ends with it (before `.fifo` for FIFO queues), e.g. `-staging`: `orders.fifo` becomes `orders-staging.fifo` |
| `region` | Only for queue URLs without a region in the host (ElasticMQ, LocalStack...). Requests to AWS queue URLs are signed with the URL's region. Default: `AWS_REGION`. |
| `accessKey`, `secretKey` | Access key credentials. Empty values fall back to the AWS default chain. |
| `profile` | Profile from `~/.aws/credentials` / `~/.aws/config`, used instead of access keys |
| `credentials` | Credentials object `{ accessKeyId, secretAccessKey, sessionToken }` or an SDK credential provider. The only way to pass a `sessionToken`. Used when neither `profile` nor access keys are set. |
| `endpoint` | Custom endpoint for every request. Usually not needed: requests go to the queue URL's host. |
| `clientConfig` | Optional extra [`SQSClient` options](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/sqs/), e.g. `{ maxAttempts: 5 }`. A `requestHandler` options object is merged with the default `{ requestTimeout: 30_000, throwOnRequestTimeout: true }`: each attempt fails after 30 seconds (above the 20 second long poll of `pull()`), and the SDK makes 3 attempts. |
| `messageGroupId` | FIFO queues: `MessageGroupId` of every message, or a function of the message that returns it. Default `"default"`. |
| `messageDeduplicationId` | FIFO queues: `"random"` (default, a random id per message), `"content"` (none, for queues with content-based deduplication) or a function of the message that returns the id. |

If you get `NonExistentQueue` / `QueueDoesNotExist`, compare the queue URL in the SQS console with `prefix` + `/` + `queue` + `suffix`.

### FIFO queues

For queue URLs ending in `.fifo`, every message is sent with:

- a `MessageGroupId`: the `messageGroupId` option, `"default"` if not set. With one group, the queue is processed in order, one message at a time. To process groups in parallel, return a group per message (example below).
- a `MessageDeduplicationId`: a random id, so every dispatched job is delivered, also when the same job is dispatched twice within SQS's 5 minute deduplication window. Set `messageDeduplicationId: "content"` if the queue has content-based deduplication and you want SQS to drop identical messages.
- no `DelaySeconds`: SQS rejects a per-message delay on FIFO queues, so the job's `delay` (nest-queue's default is 10 seconds) is ignored and a warning is logged once. Set `DelaySeconds` on the queue itself instead, and dispatch with `delay: 0` to drop the warning.

```typescript
import { InternalMessage, QueueModule } from "@squareboat/nest-queue";
import { SqsQueueDriver } from "@squareboat/nest-queue-sqs";

export const queueModule = QueueModule.register({
  default: "orders",
  connections: {
    orders: {
      driver: SqsQueueDriver,
      prefix: "https://sqs.ap-south-1.amazonaws.com/123456789012",
      queue: "orders.fifo",
      // one group per job name: each job's messages in order, different jobs in parallel
      messageGroupId: (message: InternalMessage) => message.job,
    },
  },
});
```

### Node.js

Node.js 20 or newer. AWS SDK v3 releases published after the first week of January 2027 require Node.js 22 or newer (on Node 20 the SDK already logs a `NodeVersionSupportWarning`). On Node 20, keep `@aws-sdk/client-sqs` at an earlier release (your lockfile, or npm `overrides`), or move to Node 22+.

## Upgrading from 0.0.x

0.1.0 moves from `aws-sdk` v2 (end of support) to `@aws-sdk/client-sqs` v3. The options stay the same (`apiVersion` is no longer used), but:

- **Region**: as with v2, requests to AWS queue URLs are signed with the region in the URL. `region` is only used for URLs without one.
- **Default credentials**: when you set no credentials and both `AWS_PROFILE` and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` are set, v3 uses the profile (and logs a warning); v2 used the access keys. Set only one of them, or pass `accessKey`/`secretKey`.
- **Errors**: SDK errors no longer have `err.code` / `err.statusCode`. Use `err.name` (e.g. `"QueueDoesNotExist"`) and `err.$metadata.httpStatusCode`.
- **`suffix`** was documented but ignored before 0.1.0; it is now added to the queue name. Remove it from your config if your queue URLs worked without it.
- **FIFO queues** now work (every push failed before): see [FIFO queues](#fifo-queues).
- **Timeouts and retries**: each request attempt now fails after 30 seconds, with 3 attempts (v2: a 120 second socket timeout, 4 attempts). Change them with `clientConfig`.
- **Shutdown**: nest-queue (0.2.0 and later) calls the driver's new `disconnect()` on application shutdown, which closes the SDK's sockets.

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
