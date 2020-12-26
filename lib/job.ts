import { DriverJob } from "@squareboat/nest-queue-strategy";

export class SqsJob extends DriverJob {
  public getMessage(): string {
    return this.data.Body;
  }
}
