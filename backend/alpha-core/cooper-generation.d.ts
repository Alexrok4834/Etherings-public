export const COOPER_VISUAL_CODES: ReadonlyArray<string>;
export function generateCooperInitial(sample?: (min: number, max: number) => number): {
  comfort: number;
  charm: number;
  quality: number;
  luck: number;
  visualVariantCode: string;
};
