import { formatEther, getAddress, parseEther } from 'ethers';
import { uint } from './chain-client.mjs';
import { OFFICIAL_COLLECTIONS } from './live-admin.mjs';
import { parseOperatorImport } from './operator-quotes.mjs';

const amountPattern = /^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/;
const text = value => typeof value === 'string' ? value.trim() : '';

/** Validate before any preview/read starts. Display rounding never changes these exact Wei values. */
export function operatorCreateInput({ form, mode = 'createPool', imported = '', autoSelection = null }) {
  const errors = {}, params = {}, importedMode = mode === 'createFlexiblePoolChecked' && !autoSelection;
  let data, values = form;
  if (importedMode) {
    try {
      data = parseOperatorImport(imported);
      values = { ...data.params, circuitId: uint(data.params.circuitId).toString(),
        targetRaise: formatEther(uint(data.params.targetRaiseWei ?? data.params.targetRaise)),
        priceCap: formatEther(uint(data.params.priceCapWei ?? data.params.priceCap)) };
    } catch (problem) {
      return { valid: false, errors: { imported: text(imported)
        ? '完整报价参数无效，请重新导入或在上方选择矿机。'
        : '请先在上方选择矿机并填入方案，或导入完整报价。' }, reason: text(imported)
        ? '完整报价参数无效，请重新导入或在上方选择矿机。'
        : '请先在上方选择矿机并填入方案，或导入完整报价。' };
    }
  }
  try {
    const address = getAddress(values.circuits);
    if (!OFFICIAL_COLLECTIONS.some(value => getAddress(value) === address)) throw Error();
    params.circuits = address;
  } catch { errors.circuits = '请选择有效的矿机系列。'; }
  const id = text(values.circuitId);
  if (!id) errors.circuitId = '请填写矿机编号。';
  else if (!/^\d+$/.test(id)) errors.circuitId = '矿机编号请输入非负整数。';
  else try { params.circuitId = uint(BigInt(id)).toString(); }
    catch { errors.circuitId = '矿机编号超出有效范围。'; }

  for (const [field, label] of [['targetRaise', '募集总额'], ['priceCap', '购机价格上限']]) {
    const value = text(values[field]);
    if (!value) { errors[field] = `请填写${label}。`; continue; }
    if (!amountPattern.test(value)) { errors[field] = `${label}请输入 BNB 数字金额，最多 18 位小数。`; continue; }
    try {
      const wei = uint(parseEther(value));
      if (wei <= 0n) errors[field] = `${label}必须大于 0 BNB。`;
      else params[`${field}Wei`] = wei.toString();
    } catch { errors[field] = `${label}金额超出有效范围。`; }
  }
  if (params.targetRaiseWei && BigInt(params.targetRaiseWei) % 100n !== 0n)
    errors.targetRaise = '募集总额需能平均分为 100 份，最多保留 16 位小数。';
  if (params.priceCapWei && params.targetRaiseWei && BigInt(params.priceCapWei) > BigInt(params.targetRaiseWei))
    errors.priceCap = '购机价格上限不能超过募集总额。';

  for (const [field, deadline, label] of [['fundingHours', 'fundingDeadline', '募集截止'], ['purchaseHours', 'purchaseDeadline', '购机期限']]) {
    if (importedMode && values[deadline] !== undefined) {
      try { if (uint(values[deadline], 64) <= 0n) throw Error(); params[deadline] = values[deadline]; }
      catch { errors[field] = `${label}时间无效，请重新导入完整报价。`; }
      continue;
    }
    const value = text(values[field]);
    if (!value) errors[field] = `请填写${label}小时数。`;
    else if (!/^\d+$/.test(value)) errors[field] = `${label}请输入正整数小时。`;
    else try {
      const hours = uint(BigInt(value), 32);
      if (hours <= 0n) errors[field] = `${label}必须大于 0 小时。`;
      else params[field] = hours.toString();
    } catch { errors[field] = `${label}小时数超出有效范围。`; }
  }
  if (params.fundingDeadline && params.purchaseDeadline && BigInt(params.purchaseDeadline) <= BigInt(params.fundingDeadline))
    errors.purchaseHours = '购机截止必须晚于募集截止，请重新导入完整报价。';
  const reason = Object.values(errors).join(' ');
  return { valid: !reason, errors, reason, input: reason ? null : importedMode
    ? { kind: mode, params: { ...data.params, ...params }, flexible: data.flexible,
      expectedTaskId: data.expectedTaskId, expectedReferenceWeight: data.expectedReferenceWeight }
    : { kind: mode, params } };
}
