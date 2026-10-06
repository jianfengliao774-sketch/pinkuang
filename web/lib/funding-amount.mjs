import { AMOUNT_DISPLAY_PLACES, displayAmount, displayDecimal } from './amount-display.mjs';

// Presentation for the operator's fundraising total only; never use this to alter a quoted Wei amount.
const WEI_PER_DISPLAY_UNIT = 10n ** BigInt(18 - AMOUNT_DISPLAY_PLACES);
const DISPLAY_SCALE = 10n ** BigInt(AMOUNT_DISPLAY_PLACES);
export function fundingAmount(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(value.trim()))
    throw new Error('募集总额请输入有效的 BNB 金额。');
  const [whole, fraction = ''] = value.trim().split('.');
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  const units = (wei + WEI_PER_DISPLAY_UNIT / 2n) / WEI_PER_DISPLAY_UNIT;
  const rounded = `${units / DISPLAY_SCALE}.${(units % DISPLAY_SCALE).toString().padStart(AMOUNT_DISPLAY_PLACES, '0')}`;
  const approximate = wei !== units * WEI_PER_DISPLAY_UNIT;
  const display = wei > 0n && units === 0n ? displayAmount(wei) : displayDecimal(rounded);
  return Object.freeze({ rounded, approximate, display: `${approximate ? '≈ ' : ''}${display}` });
}
