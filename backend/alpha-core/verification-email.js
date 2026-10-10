export const VERIFICATION_SUBJECT = 'EtheRings verification code';

export function verificationBody(code) {
  return `Your EtheRings verification code is:\n\n${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can ignore this email.\n\n— EtheRings`;
}
