export interface Command {
  name: string;
  description: string;
  execute: (message: any) => Promise<void>;
}
