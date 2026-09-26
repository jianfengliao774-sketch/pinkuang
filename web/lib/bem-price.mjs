export const BEM_ADDRESS = '0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a';
export const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const USDT_ADDRESS = '0x55d398326f99059ff775485246999027b3197955';
export const PANCAKE_V3_FACTORY = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
export const WBNB_USDT_POOL = '0x172fcd41e0913e95784454622d1c3724f546f849';
export const BEM_POOL = '0x28b12792f9d81bd529bc5572434e861c9edbbbc2';
export const PRICE_MAX_AGE_MS = 60_000;
export const PRICE_REFRESH_MS = 15_000;
export function calculateBnbUsdt(sqrtPriceX96) {
  // This pool's token0 is USDT and token1 is WBNB, both with 18 decimals.
  // slot0 expresses WBNB per USDT, so invert for USDT per WBNB.
  const sqrt = BigInt(sqrtPriceX96);
  if (sqrt <= 0n) throw new Error('INVALID_PRICE');
  const ratio = (Number(sqrt) / 2 ** 96) ** 2;
  const price = 1 / ratio;
  if (!Number.isFinite(price) || price <= 0) throw new Error('INVALID_PRICE');
  return price;
}
export function calculateBemUsdt(sqrtPriceX96, bnbUsdt) {
  if (BigInt(sqrtPriceX96) <= 0n) throw new Error('INVALID_PRICE');
  const sqrt = Number(BigInt(sqrtPriceX96));
  const bnbPrice = Number(bnbUsdt);
  // BEM (token0) has 8 decimals; WBNB (token1) has 18 decimals.
  const price = (sqrt / 2 ** 96) ** 2 * 10 ** (8 - 18) * bnbPrice;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(bnbPrice) || bnbPrice <= 0) throw new Error('INVALID_PRICE');
  return price;
}
export function validBemQuote(quote, now = Date.now()) {
  const age = now - Date.parse(quote?.updatedAt);
  return quote?.status === 'ok' && quote?.chainId === 56 && quote?.tokenAddress === BEM_ADDRESS
    && quote?.poolAddress === BEM_POOL && quote?.conversionPoolAddress === WBNB_USDT_POOL
    && quote?.source === 'PancakeSwap V3' && quote?.quoteCurrency === 'USDT'
    && typeof quote?.priceUsdt === 'number' && Number.isFinite(quote.priceUsdt) && quote.priceUsdt > 0
    && Number.isFinite(age) && age >= -5000 && age <= PRICE_MAX_AGE_MS;
}
