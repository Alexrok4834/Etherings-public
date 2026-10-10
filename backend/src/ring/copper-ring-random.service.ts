import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { CopperVisualVariant } from './game-ring.entity';

const visualVariants = Object.freeze(Object.values(CopperVisualVariant));

export type CopperInitialAttributes = {
  comfort: number;
  charm: number;
  quality: number;
  luck: number;
};

@Injectable()
export class CopperRingRandomService {
  generateAttributes(): CopperInitialAttributes {
    return {
      comfort: this.nextInt(2, 21),
      charm: this.nextInt(2, 21),
      quality: this.nextInt(2, 21),
      luck: this.nextInt(2, 21),
    };
  }

  selectVisualVariant(): CopperVisualVariant {
    return visualVariants[this.nextInt(0, visualVariants.length)];
  }

  protected nextInt(min: number, maxExclusive: number) {
    return randomInt(min, maxExclusive);
  }
}
