import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PasswordHasherService } from './password-hasher.service';

describe('PasswordHasherService', () => {
  it('stores a salted scrypt hash and verifies only the original password', async () => {
    const service = new PasswordHasherService();
    const first = await service.hash('correct horse battery staple');
    const second = await service.hash('correct horse battery staple');

    assert.match(first, /^scrypt-v1\$16384\$8\$1\$/);
    assert.notEqual(first, second);
    assert.equal(await service.verify('correct horse battery staple', first), true);
    assert.equal(await service.verify('wrong password', first), false);
    assert.equal(await service.verify('correct horse battery staple', 'invalid'), false);
  });
});
