export class DeliveryDeferred extends Error {
  readonly code: string;
  readonly retryAt: number;

  constructor(code: string, retryAt: number) {
    super(code);
    this.code = code;
    this.retryAt = retryAt;
  }
}
