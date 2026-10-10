export type CooperBreedingPrice = Readonly<{
  firstUses: number;
  secondUses: number;
  ertExact: string;
  eruPrincipalExact: string;
  eruFeeExact: string;
  eruTotalExact: string;
  eruPrincipalUnits: bigint;
  eruFeeUnits: bigint;
}>;

export declare function cooperBreedingPrice(
  firstUses: number,
  secondUses: number,
): CooperBreedingPrice | null;
