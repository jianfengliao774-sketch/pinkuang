export const FRESH_DELEGATION_MANAGER:Readonly<{address:string;codeHash:string}>;
export const FRESH_DELEGATOR:Readonly<{address:string;codeHash:string}>;
export const FRESH_BALANCE_ENFORCER:Readonly<{address:string;codeHash:string}>;
export function assertFreshActivationWalletScope(accountCode:string):{delegator:string};
export function expectedFreshActivationCall(record:unknown,step:unknown):{target:string;data:string;previousAddress:string;nextAddress:string;eventName:string};
export function decodeFreshActivationEnvelope(input:unknown):Record<string,unknown>;
export function verifyFreshActivationExecution(input:unknown):Record<string,unknown>;
