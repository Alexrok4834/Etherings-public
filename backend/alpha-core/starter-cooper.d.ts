export function createStarterCooper(options: {
  pool: any;
  walletEnvironment: string;
  now?: () => Date;
  sample?: (min: number, max: number) => number;
}): {
  ensureForAccount(client: any, accountId: string): Promise<unknown>;
  claim(token: string | null): Promise<unknown>;
  inventory(token: string | null): Promise<unknown>;
};
