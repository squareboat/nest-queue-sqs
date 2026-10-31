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
