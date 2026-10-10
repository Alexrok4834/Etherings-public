export type AlphaAuthResult = { status: number; body: unknown };
export type AlphaAuth = {
  register(body: unknown): Promise<AlphaAuthResult>;
  resend(body: unknown): Promise<AlphaAuthResult>;
  verify(body: unknown): Promise<AlphaAuthResult>;
  login(body: unknown): Promise<AlphaAuthResult>;
  reauthenticate(token: string | null, body: unknown): Promise<AlphaAuthResult>;
  changePassword(token: string | null, body: unknown): Promise<AlphaAuthResult>;
  me(token: string | null): Promise<AlphaAuthResult>;
  logout(token: string | null): Promise<AlphaAuthResult>;
};
export function normalizeEmail(value: unknown): string | null;
export function createAuth(options: {
  pool: any;
  mailer: { sendVerification(email: string, code: string): Promise<unknown> };
  codeSecret: string;
  now?: () => number;
  onVerified?: (client: any, accountId: string) => Promise<unknown>;
}): AlphaAuth;
