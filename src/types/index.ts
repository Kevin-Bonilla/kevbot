export interface Command {
  name: string;
  description: string;
  execute: (message: any, client: any) => Promise<void>;
  requiredChannelId?: string;
}
