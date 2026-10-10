import { Resend } from 'resend';
import { VERIFICATION_SUBJECT, verificationBody } from '@etherings/alpha-core/verification-email';
export { VERIFICATION_SUBJECT, verificationBody } from '@etherings/alpha-core/verification-email';

export class CaptureMailTransport {
  constructor() { this.messages = []; }
  async sendVerification(email, code) {
    this.messages.push({ email, code, subject: VERIFICATION_SUBJECT, text: verificationBody(code) });
  }
}

export class ResendMailTransport {
  constructor({ apiKey, from, client } = {}) {
    if (!apiKey || from !== 'EtheRings <no-reply@auth.etherings.xyz>') {
      throw new Error('Alpha Resend mail configuration is missing or invalid');
    }
    this.from = from;
    this.client = client ?? new Resend(apiKey);
  }

  async sendVerification(email, code) {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: [email],
      subject: VERIFICATION_SUBJECT,
      text: verificationBody(code)
    });
    if (error || !data?.id) {
      const failure = new Error('Alpha email delivery was not accepted');
      failure.code = error?.name ?? 'RESEND_REJECTED';
      throw failure;
    }
    return data.id;
  }
}
