// Presentation for the operator's fundraising total only; never use this to alter a quoted Wei amount.
const WEI_PER_MILLI_BNB = 10n ** 15n;
export function fundingAmount(value) {
  if (typeof value !== 'string' || !/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(value.trim()))
    throw new Error('募集总额请输入有效的 BNB 金额。');
  const [whole, fraction = ''] = value.trim().split('.');
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  const milli = (wei + WEI_PER_MILLI_BNB / 2n) / WEI_PER_MILLI_BNB;
  const rounded = `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}`;
  const approximate = wei !== milli * WEI_PER_MILLI_BNB;
  return Object.freeze({ rounded, approximate, display: `${approximate ? '≈ ' : ''}${rounded}` });
}
