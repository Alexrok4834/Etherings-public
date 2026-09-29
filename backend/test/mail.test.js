import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureMailTransport, ResendMailTransport, VERIFICATION_SUBJECT, verificationBody } from '../src/mail.js';

const from = 'EtheRings <no-reply@auth.etherings.xyz>';

test('capture transport uses approved subject and body', async () => {
  const capture = new CaptureMailTransport();
  await capture.sendVerification('owner@example.test', '12345678');
  assert.deepEqual(capture.messages, [{
    email: 'owner@example.test', code: '12345678', subject: VERIFICATION_SUBJECT,
    text: "Your EtheRings verification code is:\n\n12345678\n\nThis code expires in 10 minutes.\n\nIf you didn't request this code, you can ignore this email.\n\n— EtheRings"
  }]);
});

test('Resend transport sends exact fields and fails closed on API rejection', async () => {
  let request;
  const client = { emails: { async send(value) { request = value; return { data: { id: 'accepted-test-id' }, error: null }; } } };
  const transport = new ResendMailTransport({ apiKey: 'synthetic-test-only', from, client });
  assert.equal(await transport.sendVerification('owner@example.test', '12345678'), 'accepted-test-id');
  assert.deepEqual(request, {
    from, to: ['owner@example.test'], subject: VERIFICATION_SUBJECT,
    text: verificationBody('12345678')
  });
  client.emails.send = async () => ({ data: null, error: { name: 'validation_error' } });
  await assert.rejects(transport.sendVerification('owner@example.test', '12345678'), error =>
    error.message === 'Alpha email delivery was not accepted' && error.code === 'validation_error');
  assert.throws(() => new ResendMailTransport({ apiKey: '', from, client }));
  assert.throws(() => new ResendMailTransport({ apiKey: 'synthetic-test-only', from: 'wrong@example.test', client }));
});
