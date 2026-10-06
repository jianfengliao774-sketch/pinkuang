import { getAddress } from 'ethers';

export const ORIGINAL_GAS_WALLET = getAddress('0xA285d1933e32b5990625aC1F5BEa205Cf2606619');

// This is a fail-closed operational gate, not proof that v2 has stopped.
// Before changing the flag, verify all v2 senders are disabled and their
// journals and on-chain pending nonces are reconciled.
export function requireOriginalSenderDrained(gasWallet, env = process.env) {
  if (getAddress(gasWallet) === ORIGINAL_GAS_WALLET && env.BEMINE_V2_GAS_SENDER_DRAINED !== '1')
    throw new Error('The original Gas wallet requires a drained and disabled v2 sender before v4 may send.');
}
