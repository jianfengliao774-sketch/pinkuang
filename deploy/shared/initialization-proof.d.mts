export const INITIALIZATION_PROOF_ABI: string[];
export interface InitializationExecutionProof {
  kind: 'direct' | 'wrapped';
  coordinator: string;
  outerTo: string;
  outerDataHash: string;
  plannedDataHash: string;
  addresses: { timelock: string; beacon: string; factory: string; shareMarket: string };
}
export function verifyInitializationExecution(input: {
  record: {
    account: string;
    input: { governanceMode: string; ownerMultisig: string; operator: string; treasury: string };
    addresses: Record<string, string>;
    steps: readonly { id: string; status: string; address?: string; codehash?: string }[];
  };
  step: { id: string; nonce?: number; txHash?: string; dataHash?: string };
  tx: {
    chainId: bigint; value: bigint; from: string; nonce: number; hash: string;
    to: string | null; data: string; blockNumber: number | null; blockHash: string | null;
  };
  receipt: {
    from: string; to: string | null; hash: string; status: number | null;
    blockNumber: number; blockHash: string; logs: readonly unknown[];
  };
}): InitializationExecutionProof;
