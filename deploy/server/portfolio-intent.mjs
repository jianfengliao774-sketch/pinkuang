import { Interface, ZeroAddress, getAddress } from 'ethers';
import { decodeFirstoOrder, verifyFirstoSignedAsk } from '../src/firsto-purchase.mjs';

// These are deliberately narrower than the deployed ABIs. No raw forwarding,
// token approval, ownership change, or implementation upgrade is a product action.
export const PRODUCT_PORTFOLIO_ABI = new Interface([
  'function deposit(uint8 shares) payable', 'function withdrawDeposit()',
  'function finalizeFundingFailure()', 'function claimFailedFunding()',
  'function buyOfficial(address child,uint256 listingId)', 'function buyFirsto(address child,bytes encodedOrder)',
  'function finalizeAcquisition()', 'function collectChildBem(address child)',
  'function claimBem()', 'function withdrawBnb()',
  'function transfer(address to,uint256 value) returns(bool)',
  'function proposeChildSale(address child,uint256 price,uint256 referencePrice,uint64 referenceAt)',
  'function voteChildSale(uint256 proposalId,bool support)', 'function executeChildSale(uint256 proposalId)',
  'function settleChildSale()', 'function expireChildSale()',
  'event Deposited(address indexed member,uint8 shares,uint256 amount)',
]);
export const PRODUCT_PORTFOLIO_FACTORY_ABI = new Interface([
  'function createPortfolio(uint256 budgetWei,uint256 absoluteCapWei,uint256 unitCapWei,uint64 fundingDeadline,uint64 purchaseDeadline)',
  'event PortfolioCreated(address indexed portfolio,uint256 budgetWei,uint256 absoluteCapWei,uint256 unitCapWei)',
]);
const views = new Interface([
  'function operator() view returns(address)', 'function legacyFactory() view returns(address)',
  'function isPool(address) view returns(bool)', 'function OFFICIAL_FACTORY() view returns(address)',
  'function factory() view returns(address)', 'function budgetWei() view returns(uint256)',
  'function childInfo(address) view returns(address collection,uint256 tokenId,uint256 purchaseCost,bool official,bool sold)',
]);
const same = (a,b) => getAddress(a) === getAddress(b);

/** Reads use the caller's pinned block; the journal checks fee and nonce,
 * persists the intent and consumes a one-shot permission without simulation. */
export async function verifyPortfolioIntent(provider, record, decoded, block, graph, fail) {
  const tag = `0x${block.number.toString(16)}`;
  if (graph?.productKind !== 'budget' || !same(graph.factory,record.factory) || !graph.legacyFactory)
    fail(409,'The reviewed integrated portfolio deployment is required.');
  const read = async (to,name,args=[]) => views.decodeFunctionResult(name,
    await provider.send('eth_call',[{to,data:views.encodeFunctionData(name,args)},tag]));
  const legacyFactory = (await read(record.factory,'legacyFactory'))[0];
  if (!same(legacyFactory,graph.legacyFactory)) fail(409,'Portfolio legacy Factory binding changed.');
  if (record.targetType === 'portfolioFactory') {
    if (!same(record.target,record.factory) || !same((await read(record.factory,'operator'))[0],record.account))
      fail(403,'Only the portfolio operator may create a budget project.');
    return;
  }
  if (!(await read(record.factory,'isPool',[record.target]))[0]
    || !same((await read(record.target,'OFFICIAL_FACTORY'))[0],record.factory)
    || !same((await read(record.target,'legacyFactory'))[0],legacyFactory))
    fail(409,'Portfolio is not registered to the reviewed Factory.');
  if (decoded.name==='transfer' && (decoded.args[0]===ZeroAddress || decoded.args[1]===0n || decoded.args[1]>100n))
    fail(400,'Portfolio transfer requires a nonzero recipient and 1-100 shares.');
  if (decoded.name === 'deposit') {
    const budget = (await read(record.target,'budgetWei'))[0];
    if (budget === 0n || budget % 100n !== 0n || BigInt(record.value) !== budget / 100n * decoded.args[0])
      fail(409,'Portfolio deposit differs from the current budget share price.');
  }
  const purchase = ['buyOfficial','buyFirsto'].includes(decoded.name);
  if (purchase && !same((await read(record.factory,'operator'))[0],record.account))
    fail(403,'Only the portfolio operator may purchase a child miner.');
  if (purchase || ['collectChildBem','proposeChildSale'].includes(decoded.name)) {
    const child = decoded.args[0];
    if (await provider.getCode(child,block.number) === '0x'
      || !(await read(legacyFactory,'isPool',[child]))[0]
      || !same((await read(child,'factory'))[0],legacyFactory)
      || !same((await read(child,'OFFICIAL_FACTORY'))[0],legacyFactory))
      fail(409,'Child miner is not registered to the reviewed legacy Factory.');
    const existing = await read(record.target,'childInfo',[child]);
    if (purchase ? existing.collection !== ZeroAddress : existing.collection === ZeroAddress)
      fail(409,purchase ? 'Child miner is already held by this project.' : 'Child miner is not held by this project.');
  }
  if (decoded.name === 'buyFirsto') await verifyFirstoSignedAsk(
    {request:({method,params})=>provider.send(method,params)},decodeFirstoOrder(decoded.args[1]),{blockTag:tag});
}
