// A channel connects the agent to one messaging surface. Telegram is the only one in v0.
export interface Channel {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}
