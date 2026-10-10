import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const FORMAT = 'scrypt-v1';

@Injectable()
export class PasswordHasherService {
  async hash(password: string) {
    const salt = randomBytes(16);
    const derived = await this.derive(password, salt);

    return [
      FORMAT,
      COST,
      BLOCK_SIZE,
      PARALLELIZATION,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, encoded: string) {
    const [format, cost, blockSize, parallelization, saltValue, hashValue, extra] = encoded.split('$');
    if (
      format !== FORMAT
      || cost !== String(COST)
      || blockSize !== String(BLOCK_SIZE)
      || parallelization !== String(PARALLELIZATION)
      || !saltValue
      || !hashValue
      || extra !== undefined
    ) {
      return false;
    }

    try {
      const expected = Buffer.from(hashValue, 'base64url');
      if (expected.length !== KEY_LENGTH) return false;
      const actual = await this.derive(password, Buffer.from(saltValue, 'base64url'));
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  verifyLegacy(actual: string, expected: string) {
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private derive(password: string, salt: Buffer) {
    return new Promise<Buffer>((resolve, reject) => {
      nodeScrypt(password, salt, KEY_LENGTH, {
        N: COST,
        r: BLOCK_SIZE,
        p: PARALLELIZATION,
        maxmem: 64 * 1024 * 1024,
      }, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    });
  }
}
