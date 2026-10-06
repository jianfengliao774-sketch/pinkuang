export function isFreshActivationWrapper(tx: unknown): boolean;
export function verifyWrappedFreshActivation(provider: unknown,record: unknown,step: unknown,tx: unknown,receipt: unknown,
  options?: {verifyPrefix?: (completed:number,block:{number:number;hash:string|null})=>Promise<void>;
    includeCurrent?:boolean;historicalPrefix?:boolean}):Promise<unknown>;
