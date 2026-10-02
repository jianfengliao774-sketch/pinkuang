"use client";
import { readPageRound } from '../lib/live-page.mjs';
import { activityAmounts } from '../lib/activity-summary.mjs';
import { activityPage, appendActivityPage, loadActivityPage } from '../lib/activity-pagination.mjs';
import { cachedYieldWindow, readYieldWindow } from '../lib/yield-history.mjs';
import { claimDisplayState } from '../lib/claim-display.mjs';
import { publishedProjectIntent, readPublishedProject, readPublishedPoolDisplay, mergePublishedProjects } from '../lib/published-project.mjs';
import ActivityOperation from './ActivityOperation';
import { displayListSnapshot, displayOnlySnapshot, invalidateDisplaySnapshots, pageDisplayKey, readDisplaySnapshot, readPoolDisplaySnapshot, writeDisplaySnapshot, writePoolDisplaySnapshots } from '../lib/display-snapshot.mjs';
import { pageRefreshDue, refreshIntervalMs } from '../lib/page-refresh.mjs';
import { startDisplayUpdates } from '../lib/display-updates.mjs';
import { startReceiptDisplayCatchup } from '../lib/receipt-display-refresh.mjs';
import { awaitingTransactionFinality } from '../lib/transaction-notice.mjs';
import { directMemberTransaction, readMemberReceipt, readMemberTransactions, saveMemberTransactions, sendMemberWalletTransaction } from '../lib/member-wallet-transactions.mjs';
import { useEffect, useMemo, useRef, useState } from "react";
import { ZeroAddress, getAddress, isAddress } from "ethers";
import {
  Sun,
  Moon,
  Blocks,
  LayoutDashboard,
  Layers3,
  ArrowLeftRight,
  Wallet,
  Vote,
  FileText,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  ChevronDown,
  Menu,
  X,
  RefreshCw,
  ShieldCheck,
  BookOpen,
  Share2,
  CheckCircle2,
  AlertCircle,
  Search,
  Download,
  ExternalLink,
  Bell,
  Send,
} from "lucide-react";
import { useI18n } from "../lib/i18n";
import BrandMark from "./BrandMark";
import PoolSortMenu from "./PoolSortMenu";
import { projectDirectory, projectMatchesStatus } from '../lib/project-directory.mjs';
import MoreServicesNotice from "./MoreServicesNotice";
import Notifications from "./Notifications";
import SiteOverview from "./SiteOverview";
import BemPriceStat from "./BemPriceStat";
import LiveYieldChart from "./LiveYieldChart";
import LiveGovernance from "./LiveGovernance";
import LiveOperator from "./LiveOperator";
import FreshAuthorityConsole from "./FreshAuthorityConsole";
import FirstoMarketBoard from "./FirstoMarketBoard";
import LivePortfolios, { clearRecentPortfolioDisplays } from "./LivePortfolios";
import { preparePortfolioAction, readPortfolioDisplayRow } from "../lib/live-portfolios.mjs";
import { prepareBudgetQueueStep, beginBudgetQueueStep, budgetQueuePreviewMatches, budgetPurchaseQueueSupported } from "../lib/budget-purchase-plan.mjs";
import { recoverAuthorityQueueStep } from "../lib/authority-queue-recovery.mjs";
import PortfolioProjectShare from "./PortfolioProjectShare";
import { walletConnectEnabled, walletConnectForPage } from "../lib/walletconnect.mjs";
import WalletConnectModal, { WalletIcon } from "./WalletConnectModal";
import { createWalletDiscovery, walletConnectionError } from "../lib/wallet-discovery.mjs";
import { startWalletSession } from '../lib/wallet-session.mjs';
import { sameUnsignedIntent } from "../lib/ui-context.mjs";
import { READ_CANCELLED, retryReadRound, settleReadRound } from "../lib/read-retry.mjs";
import { prepareAdminAction, readOperatorStatus, sameAdminPurchasePreview } from "../lib/live-admin.mjs";
import { approvedOperatorCall, approvedPortfolioPurchase, authorityActionStatus, signAuthorityAction, submitAuthorityAction } from "../lib/authority-client.mjs";
import ProjectShare from "./ProjectShare";
import ShareSaleDialogContent from './ShareSaleDialogContent';
import TransactionResultDialog from './TransactionResultDialog';
import { normalizeTransactionResult } from '../lib/transaction-result.mjs';
import { applyMarketOrderFeedback, marketOrderFeedback } from '../lib/market-order-feedback.mjs';
import { publicShareBaseForPath } from "../lib/project-share.mjs";
import { resolveDeployConsoleUrl } from "../lib/deploy-console-url.mjs";
import { createReadOnlyHttpProvider, fetchLiveJson, validatePinnedGenesis } from "../lib/live-config.mjs";
import { loadProductConfig, loadProductDisplayConfig, validateCurrentProductGraph } from "../lib/product-config.mjs";
import { validateFreshManifest } from '../lib/fresh-product-config.mjs';
import { freshIdentityReadable, freshOperationsReady, freshReadClientIdentity } from '../lib/fresh-boot-recovery.mjs';
import { assetOverview } from '../lib/asset-overview.mjs';
import { rememberPortfolioDisplay, readPortfolioDisplay } from '../lib/portfolio-display-cache.mjs';
import { boundedReadPreview } from '../lib/bounded-read-preview.mjs';
import { readDeploymentAccount } from '../lib/deployment-account.mjs';
import pinnedGenesis from '../public/data/frontend-manifest.json' with { type: 'json' };
import { readShareDailyCapacityPrice, shareDailyCapacityPriceWei, poolDailyCapacityPriceWei } from "../lib/share-daily-capacity.mjs";
import { readCapacityDisplay, writeCapacityDisplay } from "../lib/capacity-display-cache.mjs";
import { createLiveDataClient } from "../lib/live-data.mjs";
import { readCurrentPoolMembers } from "../lib/live-members.mjs";
import {
  connectWallet,
  authenticate,
  readPending,
  sendProductTransaction,
  recoverPending,
  cancelPendingNonce,
  retryLegacyEnvelope,
  abandonPrepared,
  requireCurrentProductStage,
} from "../lib/live-transactions.mjs";
import { prepareProductAction } from "../lib/live-actions.mjs";
import { shareListingView } from "../lib/share-listing-view.mjs";
import { displayDecimal, displayGasFee, displayPreciseAmount } from "../lib/amount-display.mjs";
import { abi, readPoolSnapshot } from "../lib/chain-client.mjs";
import {
  amount,
  shortAddress,
  viewPool,
  parseProductRoute,
  sumKnown,
  exportActivityCsv,
  explorerAddress,
  explorerTransaction,
  currentDetailActionReady,
  currentPositionsActionReady,
  currentMarketOrderActionReady,
  canOpenFundingAction,
} from "../lib/live-view.mjs";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const minimumSharePriceWei = 10000000000000n;
const recordsPageSize = 5;
const displayStorage = () => { try { return window.localStorage; } catch { return null; } };
const sessionDisplayStorage = () => { try { return window.sessionStorage; } catch { return null; } };
const readPageSnapshot = (storage, manifest, page) => readDisplaySnapshot(storage, manifest, page,
  process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY === 'fresh-v4' ? { maxAgeMs: 30 * 60_000 } : {});
const deploymentConsoleUrl = resolveDeployConsoleUrl(
  process.env.NEXT_PUBLIC_DEPLOY_CONSOLE_URL,
);
const publicBaseUrl =
  process.env.NEXT_PUBLIC_BEMINE_PUBLIC_URL || publicShareBaseForPath(basePath);
const navigation = [
  ["home", "拼矿总览", "BEMine overview", Blocks],
  ["overview", "资产总览", "My portfolio", LayoutDashboard],
  ["pools", "参与拼矿", "Join a pool", Layers3],
  ["market", "矿机转让", "Marketplace", ArrowLeftRight],
  ["rewards", "收益中心", "Rewards", Wallet],
  ["governance", "共同决策", "Governance", Vote],
  ["records", "公开记录", "Public records", FileText],
];
const statuses = {
  Funding: ["募集中", "Funding"],
  Funded: ["待购机", "Awaiting purchase"],
  Active: ["挖矿中", "Operating"],
  Listed: ["整机出售中", "For sale"],
  Closed: ["已结束", "Closed"],
  Refunding: ["可退款", "Refunding"],
  Unknown: ["状态待核对", "Unknown"],
};
const transactionLabels = {
  authenticating: ['正在核对钱包登录…', 'Checking wallet login…'],
  'awaiting-login-signature': ['请在钱包中确认登录消息', 'Confirm the login message in your wallet'],
  rechecking: ['正在核对最新交易信息…', 'Checking the latest transaction details…'],
  preparing: ['正在核对余额与 Gas 费用…', 'Checking your balance and Gas fees…'],
  'recording-intent': ['正在确认订单信息…', 'Confirming order details…'],
  authorizing: ['正在打开钱包…', 'Opening your wallet…'],
  'awaiting-signature': ['请在钱包弹窗中确认交易', 'Confirm the transaction in your wallet'],
  pending: ['交易已提交，正在核对链上结果…', 'Transaction submitted. Checking the on-chain result…'],
  'needs-verification': ['发送结果待核对，请检查钱包记录', 'Submission needs verification. Check your wallet history'],
  confirmed: ['', ''],
};
const actionNames = {
  deposit: ["认购份额", "Subscribe"],
  claim: ["领取 BEM", "Claim BEM"],
  harvest: ["归集矿机收益", "Collect miner output"],
  withdrawBnb: ["领取矿池 BNB", "Withdraw pool BNB"],
  marketWithdraw: ["领取市场 BNB", "Withdraw market BNB"],
  withdrawDeposit: ["撤回全部认购", "Withdraw subscription"],
  finalizeFailure: ["开启到期退款", "Enable refunds"],
  list: ["出售份额", "List shares"],
  fill: ["买入份额", "Buy shares"],
  cancel: ["撤销挂单", "Cancel order"],
  expire: ["解锁到期挂单", "Unlock expired order"],
  propose: ["发起出售提案", "Propose miner sale"],
  vote: ["提交表决", "Submit vote"],
  executeSale: ["执行整机挂牌", "Execute listing"],
  completeFirstoSale: ["购买整台矿机", "Buy whole miner"],
  cancelExpired: ["解除到期挂牌", "Clear expired listing"],
  delist: ["整机下架投票", "Miner delisting vote"],
};
const textError = (error) =>
  String(
    error?.shortMessage ||
      error?.message ||
      "暂时无法完成操作 / Unable to complete this action.",
  ).slice(0, 350);
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  a.toLowerCase() === b.toLowerCase();

function Button({ children, secondary = false, ...props }) {
  return (
    <button className={`btn${secondary ? " secondary" : ""}`} {...props}>
      {children}
    </button>
  );
}
function Chip({ pool }) {
  const letter = /behemoth|巨兽/i.test(pool?.name ?? "") ? "B" : /tapeout/i.test(pool?.name ?? "") ? "T" : null;
  return (
    <span className={`chip ${pool?.color || "blue"}`}>
      {pool?.kind === 'portfolio' || !letter ? <Layers3 size={24}/> : <svg aria-hidden="true" width="30" height="30" viewBox="0 0 32 32" fill="none">
        <rect x="7" y="7" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M11 3v4m5-4v4m5-4v4M11 25v4m5-4v4m5-4v4M3 11h4m-4 5h4m-4 5h4M25 11h4m-4 5h4m-4 5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        <text x="16" y="21" fill="currentColor" textAnchor="middle" fontSize="14" fontWeight="700">{letter}</text>
      </svg>}
    </span>
  );
}
function StateBadge({ state, L }) {
  return (
    <span className={`badge ${(state || "Unknown").toLowerCase()}`}>
      <i />
      {L(...(statuses[state] || statuses.Unknown))}
    </span>
  );
}
function Empty({ title, children }) {
  return (
    <div className="live-empty">
      <Layers3 size={30} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
function Metric({ title, value, unit, note, primary = false }) {
  return (
    <div className={`metric${primary ? " primary" : ""}`}>
      <div className="metric-label">{title}</div>
      <div className="metric-value">
        {value}
        <small>{unit}</small>
      </div>
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
}

export default function LivePlatform() {
  const { locale, setLocale, t } = useI18n();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [appearance, setAppearance] = useState("light"),
    [menu, setMenu] = useState(false),
    [route, setRoute] = useState({ route: "home", pool: null });
  const routeIdentity = useRef(route);
  const verifiedBoot = useRef(null);
  const readClientIdentity = useRef(null);
  const walletLanguage = useRef(locale);
  const portfolioReturnRoute = useRef('pools');
  walletLanguage.current = locale;
  const [boot, setBoot] = useState({ status: "loading" }),
    [bootAttempt, setBootAttempt] = useState(0),
    [bootRecoveryExhausted, setBootRecoveryExhausted] = useState(false),
    [client, setClient] = useState(null),
    [account, setAccount] = useState(null),
    [wallet, setWallet] = useState(null),
    [walletChecking, setWalletChecking] = useState(false);
  const [wallets, setWallets] = useState([]),
    [walletUiReady, setWalletUiReady] = useState(false),
    [walletInfo, setWalletInfo] = useState(null),
    [connectingId, setConnectingId] = useState(null),
    [connectionError, setConnectionError] = useState(""),
    [walletQr, setWalletQr] = useState(null);
  const qrConnector = useRef(null);
  const [pools, setPools] = useState([]),
    [positions, setPositions] = useState([]),
    [stats, setStats] = useState(null),
    [detail, setDetail] = useState(null),
    [governance, setGovernance] = useState(null),
    [governanceProof, setGovernanceProof] = useState(null),
    [members, setMembers] = useState([]),
    [membersRead, setMembersRead] = useState({ status: "idle" }),
    [indexedOrders, setOrders] = useState([]),
    [activity, setActivity] = useState([]),
    [source, setSource] = useState(null);
  const [recordsPage, setRecordsPage] = useState(0);
  const recordsPageRef = useRef(recordsPage);
  recordsPageRef.current = recordsPage;
  const [detailPreview, setDetailPreview] = useState(null);
  const [poolCursor, setPoolCursor] = useState(null),
    [positionCursor, setPositionCursor] = useState(null),
    [orderCursor, setOrderCursor] = useState(null),
    [activityCursor, setActivityCursor] = useState(null),
    [marketCredit, setMarketCredit] = useState(null);
  const [yieldData, setYieldData] = useState(null),
    [yieldLoading, setYieldLoading] = useState(false),
    [yieldError, setYieldError] = useState(''),
    [yieldDays, setYieldDays] = useState(30);
  const [loadedRoute, setLoadedRoute] = useState("");
  const [orderCapacity, setOrderCapacity] = useState({});
  const [poolCapacity, setPoolCapacity] = useState({});
  const [capacityNow, setCapacityNow] = useState(0);
  const [poolQuoteRevision, setPoolQuoteRevision] = useState(0);
  const [loadedAccount, setLoadedAccount] = useState(null);
  const [marketOrderIdentity, setMarketOrderIdentity] = useState('');
  const [positionsAccount, setPositionsAccount] = useState(null);
  const [operator, setOperator] = useState(null);
  const [deploymentIdentity, setDeploymentIdentity] = useState(null);
  const deploymentProof = useRef(null);
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [positionsReadLoading, setPositionsReadLoading] = useState(false);
  const [marketOrdersLoading, setMarketOrdersLoading] = useState(false);
  const [positionsReadError, setPositionsReadError] = useState("");
  const [marketOrdersError, setMarketOrdersError] = useState("");
  const [positionsReadSource, setPositionsReadSource] = useState(null);
  const [marketOrderSource, setMarketOrderSource] = useState(null);
  const [activityReadLoading, setActivityReadLoading] = useState(false);
  const [activityReadError, setActivityReadError] = useState("");
  const [activityReadSource, setActivityReadSource] = useState(null);
  const [activityTotals, setActivityTotals] = useState({ totalCount: null, overviewTotalCount: null });
  const activityPageRequest = useRef(null);
  const [statsReadError, setStatsReadError] = useState("");
  const [statsSource, setStatsSource] = useState(null);
  const [notificationClaim, setNotificationClaim] = useState(null);
  const [memberTransactions, setMemberTransactions] = useState([]);
  const [transactionResults, setTransactionResults] = useState([]);
  const [publishingProject, setPublishingProject] = useState(null);
  const publishedProjects = useRef([]);
  const publishedPortfolios = useRef([]);
  const shownTransactionResults = useRef(new Set());
  const transactionResult = transactionResults[0] ?? null;
  function showTransactionResult(input, options) {
    let result = normalizeTransactionResult(input, { locale, ...options });
    if (!result && options?.creationPending) result = { kind: 'pending', reason: 'publication', hash: input?.hash,
      title: L('项目正在发布', 'Publishing project'),
      message: L('交易已提交，正在等待链上确认。确认成功后会显示项目地址，请勿重复发布。',
        'Transaction submitted. The project address will appear after confirmation. Do not submit it again.') };
    if (!result && options?.creationFailure) result = { kind: 'failed', reason: 'publication',
      title: L('项目发布失败', 'Project publication failed'), message: textError(input) };
    if (result && input?.poolAddress && input?.status === 'confirmed') result = { ...result,
      projectAddress: input.poolAddress, projectKind: input.projectKind, reason: 'publication',
      title: L('项目发布成功', 'Project published'),
      message: L('新项目已在链上创建，可查看项目或前往项目大厅。',
        'Your new project is confirmed on chain. View it or open the project directory.') };
    if (!result) return false;
    if (result.key && shownTransactionResults.current.has(result.key)) return true;
    if (result.key) shownTransactionResults.current.add(result.key);
    setTransactionResults(previous => [...previous.filter(item => !(item.kind === 'pending' && item.reason === 'publication')), result].slice(-20));
    return true;
  }
  const [readRetry, setReadRetry] = useState(null), [readFailed, setReadFailed] = useState(false);
  const [cachedPage, setCachedPage] = useState(false);
  const [loading, setLoading] = useState(false),
    [revalidating, setRevalidating] = useState(false),
    [busy, setBusy] = useState(false),
    [transactionStage, setTransactionStage] = useState(null),
    [transactionGasWei, setTransactionGasWei] = useState(null),
    [error, setError] = useState(""),
    [, setMessage] = useState(""),
    [refresh, setRefresh] = useState(0),
    [receiptDisplayRefresh, setReceiptDisplayRefresh] = useState(0),
    [operatorRefresh, setOperatorRefresh] = useState(0);
  const displayRefreshKey = `${refresh}:${receiptDisplayRefresh}`;
  const [modal, setModal] = useState(null),
    [quantity, setQuantity] = useState("1"),
    [price, setPrice] = useState(""),
    [prepared, setPrepared] = useState(null),
    [pending, setPending] = useState(null),
    [recoveryHash, setRecoveryHash] = useState("");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("Funding"),
    [sort, setSort] = useState("funded"),
    [detailTab, setDetailTab] = useState("asset"),
    [marketTab, setMarketTab] = useState("shares"),
    [operatorTab, setOperatorTab] = useState("publish");
  const epoch = useRef(0),
    pageCache = useRef(new WeakMap()),
    readCache = useRef(new WeakMap()),
    positionsReadEpoch = useRef(0),
    marketOrdersEpoch = useRef(0),
    activityReadEpoch = useRef(0),
    capacityEpoch = useRef(0),
    modalRef = useRef(null),
    restoreFocus = useRef(null),
    connectedWallet = useRef(null),
    discovery = useRef(null),
    connectionLock = useRef(null),
    submissionLock = useRef(null),
    lastConfirmed = useRef(null),
    walletEpoch = useRef(0),
    activeModal = useRef(null);
  const lastPageRefresh = useRef(new Map());
  const fastSnapshotRetries = useRef(new Map());
  const portfolioRead = useRef({ busy: false, failed: false });
  const capacityDisplay = useRef({ pools: {}, orders: {} });
  const refreshState = useRef(null);
  const receiptDisplayState = useRef(null);
  const invalidateDisplayOnReorg = (service, problem) => {
    if (problem?.code !== 'source_reorg' || !service) return;
    invalidateDisplaySnapshots(displayStorage(), service.manifest);
    invalidateDisplaySnapshots(sessionDisplayStorage(), service.manifest);
    clearRecentPortfolioDisplays();
    pageCache.current.delete(service);
    readCache.current.delete(service);
  };
  const clearWalletDisplay = () => {
    setPools([]); setPoolCursor(null); setDetail(null); setDetailPreview(null);
    setPositions([]); setPositionCursor(null); setPositionsLoaded(false); setPositionsAccount(null);
    setOrders([]); setOrderCursor(null); setActivity([]); setActivityCursor(null);
    setGovernance(null); setGovernanceProof(null); setYieldData(null); setMarketCredit(null); setNotificationClaim(null);
    setTransactionResults([]);
    setPublishingProject(null); publishedProjects.current = []; publishedPortfolios.current = [];
    setSource(null); setPositionsReadSource(null); setMarketOrderSource(null); setActivityReadSource(null);
    setLoadedAccount(null); setLoadedRoute(''); setCachedPage(false);
  };
  capacityDisplay.current = { pools: poolCapacity, orders: orderCapacity };
  refreshState.current = { loading: loading || revalidating || positionsReadLoading || marketOrdersLoading || activityReadLoading,
    busy, modal: !!modal || !!transactionResult, pending: !!pending,
    failed: readFailed || !!positionsReadError || !!marketOrdersError || !!activityReadError };
  activeModal.current = modal;
  useEffect(() => {
    if (modal?.type !== 'connect-wallet') cancelWalletScan();
  }, [modal]);
  useEffect(() => () => {
    const ticket = connectionLock.current;
    connectionLock.current = null;
    qrConnector.current?.cancel();
    if (ticket?.remote && ticket.provider !== connectedWallet.current) void ticket.provider?.disconnect?.().catch(() => {});
  }, []);
  const config = useMemo(() =>
    boot.status === "ready"
      ? { ...boot, ...boot.manifest, journalBase: boot.journalBase || "/api/journal",
        ...(walletChecking ? { walletSessionReady: false, operationalReady: false, transactionReady: false, userExitReady: false } : {}) }
      : null, [boot, walletChecking]);
  receiptDisplayState.current = {
    route: route.route, marketTab,
    source: loadedRoute === route.route + (route.pool ? `/${route.pool}` : '') ? source : null,
    statsSource, positionsSource: same(positionsAccount, account) ? positionsReadSource : null,
    ordersSource: marketOrderSource, activitySource: activityReadSource,
  };
  const orderFeedback = useMemo(() => marketOrderFeedback(memberTransactions, config?.shareMarket ?? config?.manifest?.shareMarket, account, capacityNow || Date.now()),
    [memberTransactions, config?.shareMarket, config?.manifest?.shareMarket, account, capacityNow]);
  const orders = useMemo(() => applyMarketOrderFeedback(indexedOrders, orderFeedback), [indexedOrders, orderFeedback]);
  const claimState = (row, currency, rowSource = source) => claimDisplayState({
    pool: row?.pool, account, currency,
    balance: account ? currency === 'BEM' ? row?.claimableBEM : row?.bnbOwed : null,
    transactions: memberTransactions, activity, balanceBlock: rowSource?.indexedThrough,
  });
  const detailBemClaim = claimState(detail, 'BEM'), detailBnbClaim = claimState(detail, 'BNB');
  if (boot.status === 'ready') verifiedBoot.current = boot;
  const walletRevision = walletEpoch.current;
  // A permission result belongs to this exact provider, account and read revision.
  // Reject it during render, before the effect cleanup, when any identity changes.
  const operatorContextCurrent = !!wallet && !!account && !!config
    && (config.productFamily !== 'fresh-v4' || freshIdentityReadable(config))
    && connectedWallet.current === wallet && operator?.provider === wallet
    && operator.walletRevision === walletRevision && operator.refresh === operatorRefresh
    && operator.deployment === boot && same(operator.account, account)
    && same(operator.factory, config.factory);
  const directAdministrator = config?.displayOnly === true && config.walletSessionReady !== false
    && !!wallet && !!account && connectedWallet.current === wallet
    && [config.freshAuthority?.administratorOne, config.freshAuthority?.administratorTwo].some(value => same(value, account))
    && !connectingId && !connectionLock.current;
  const isOperator = directAdministrator || operatorContextCurrent && operator.status === 'verified'
    && operator.configured === true && operator.isOperator === true
    && (same(operator.operator, account) || config.stage === 'fresh-active'
      && operator.isAuthorityAdmin === true && same(operator.operator, config.authority))
    && !connectingId && !connectionLock.current;
  const isPortfolioOperator = directAdministrator || operatorContextCurrent && operator.status === 'verified' && operator.isPortfolioOperator === true
    && (same(operator.portfolioOperator, account) || config.stage === 'fresh-active'
      && operator.isAuthorityAdmin === true && same(operator.portfolioOperator, config.authority))
    && !connectingId && !connectionLock.current;
  const hasOperatorAccess = isOperator || isPortfolioOperator;
  const hasDeploymentAccess = (config?.displayOnly === true ? same(account, '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7') : freshIdentityReadable(config)
    && same(deploymentIdentity?.deployer, account)) && !!wallet && !!account
    && connectedWallet.current === wallet
    && !connectingId && !connectionLock.current;
  const operatorServiceReady = config?.displayOnly === true && config.walletSessionReady !== false
    || config?.productFamily !== 'fresh-v4' || freshOperationsReady(config);
  const operatorAccess = !wallet || !account ? 'disconnected' : !config ? 'unavailable'
    : config.productFamily === 'fresh-v4' && !config.displayOnly && !freshIdentityReadable(config) ? 'unavailable'
    : hasOperatorAccess ? (config.displayOnly ? 'configured' : 'verified') : config.displayOnly ? 'denied' : !operatorContextCurrent || operator.status === 'checking' || connectingId ? 'checking'
      : operator.status === 'error' ? 'unavailable' : 'denied';

  useEffect(() => {
    if (route.route === 'operator' && ['disconnected', 'denied'].includes(operatorAccess)) location.hash = 'home';
  }, [route.route, operatorAccess]);

  useEffect(() => {
    if (!client || !boot.displayOnly) return;
    return startDisplayUpdates(boot, {
      isPaused: () => {
        const state = refreshState.current;
        return state.loading || state.busy || state.modal || state.pending || portfolioRead.current.busy
          || ['overview', 'records', 'rewards'].includes(routeIdentity.current.route) && recordsPageRef.current > 0;
      },
      onUpdate: () => setRefresh(value => value + 1),
    });
  }, [client, boot]);

  useEffect(() => {
    let active=true;
    setDeploymentIdentity(null);
    if(wallet&&account&&!config?.displayOnly&&freshIdentityReadable(config)&&client?.provider){
      const key=JSON.stringify([config.rpcUrl,config.chainId,config.artifactDigest,config.factory,config.portfolioFactory,
        config.authority,config.manifest.deployment]);
      if(deploymentProof.current?.key!==key){
        const proof={key,promise:readDeploymentAccount(client.provider,config.manifest)};
        deploymentProof.current=proof;
        proof.promise.catch(()=>{if(deploymentProof.current===proof)deploymentProof.current=null;});
      }
      deploymentProof.current.promise.then(deployer=>{
        if(active&&connectedWallet.current===wallet&&walletEpoch.current===walletRevision)
          setDeploymentIdentity({wallet,account,deployer,revision:walletRevision,boot});
      }).catch(()=>{}); // A missing or inconsistent proof keeps the private-console link hidden.
    }
    return()=>{active=false;};
  },[wallet,account,boot,client,walletRevision]);

  useEffect(() => {
    const service = createWalletDiscovery(window, setWallets);
    discovery.current = service;
    setWalletUiReady(true);
    return () => { service.destroy(); discovery.current = null; connectionLock.current = null; };
  }, []);

  useEffect(() => {
    let active = true;
    let retryTimer;
    setOperator(null);
    if (config?.displayOnly === true) {
      setOperator({ provider: wallet, account, factory: config.factory, deployment: boot,
        walletRevision, refresh: operatorRefresh, status: 'configured', configured: true,
        isOperator: directAdministrator, isPortfolioOperator: directAdministrator,
        isAuthorityAdmin: directAdministrator, operator: config.authority,
        portfolioOperator: config.authority, direct: true });
      return () => { active = false; };
    }
    if (wallet && account && config
      && (config.productFamily !== 'fresh-v4' || freshIdentityReadable(config) && client?.provider)) {
      const binding = { provider: wallet, account, factory: config.factory,
        walletRevision, refresh: operatorRefresh, deployment: boot };
      const current = () => active && connectedWallet.current === wallet && walletEpoch.current === walletRevision;
      setOperator({ ...binding, status: 'checking' });
      // Identity is read-only: extensions need not proxy all chain reads. The
      // actual connected account/provider still owns this result and every signature.
      const provider = config.productFamily === 'fresh-v4' ? client.provider : wallet;
      const read = attempt => readOperatorStatus({ provider, config, account }).then(result => {
        if (current()) setOperator({ ...binding, ...result, status: 'verified' });
      }).catch(() => {
        if (!current()) return;
        if (attempt < 2) retryTimer = setTimeout(() => { if (current()) void read(attempt + 1); }, (attempt + 1) * 2_500);
        else setOperator({ ...binding, status: 'error' });
      });
      void read(0);
    }
    return () => { active = false; clearTimeout(retryTimer); };
  }, [wallet, account, boot, client, operatorRefresh, walletRevision]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("bemine-appearance");
      if (["light", "dark"].includes(stored)) setAppearance(stored);
    } catch {}
    const sync = () => {
      const next = parseProductRoute(location.hash);
      if (next.route !== routeIdentity.current.route || next.pool !== routeIdentity.current.pool) {
        epoch.current++;
        routeIdentity.current = next;
        setRoute(next);
      }
      setMenu(false);
      setModal(null);
      setPrepared(null);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    try {
      localStorage.setItem("bemine-appearance", appearance);
    } catch {}
  }, [appearance]);
  useEffect(() => {
    if (client || boot.status !== 'loading') return;
    // The build-pinned genesis allows a display-only cache to paint while the
    // product graph and manifest are still loading. Route identity must match
    // the URL so a deep link never flashes the home page's previous data.
    const activeRoute = parseProductRoute(location.hash);
    if (activeRoute.route !== route.route || activeRoute.pool !== route.pool) return;
    const pageKey = pageDisplayKey(route, account, marketTab);
    // Route changes can precede product boot. Clear the previous route even
    // when this one has no local page to restore.
    setPools([]); setPoolCursor(null); setDetail(null); setSource(null);
    setCachedPage(false); setLoadedRoute('');
    try {
      const freshV4 = process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY === 'fresh-v4';
      const pinned = freshV4
        ? validateFreshManifest(pinnedGenesis, process.env.NEXT_PUBLIC_V4_MANIFEST_SHA256)
        : validatePinnedGenesis(pinnedGenesis);
      const options = freshV4 ? { maxAgeMs: 30 * 60_000 } : {};
      const cached = route.route === 'detail'
        ? readPoolDisplaySnapshot(displayStorage(), pinned, route, account, options)
        : readDisplaySnapshot(displayStorage(), pinned, pageKey, options);
      if (!cached?.catalog && !cached?.detail) return;
      const visiblePools = cached.catalog?.items.map(viewPool);
      const visibleDetail = cached.detail ? viewPool(cached.detail.item) : null;
      if (visiblePools) { setPools(mergePublishedProjects(visiblePools, publishedProjects.current)); setPoolCursor(cached.catalog.nextCursor); }
      if (visibleDetail) setDetail(visibleDetail);
      setSource(cached.detail?.source ?? cached.catalog?.source);
      setLoadedAccount(account);
      setLoadedRoute(route.route + (route.pool ? `/${route.pool}` : ''));
      setCachedPage(true);
    } catch { /* A corrupt browser cache cannot block the live read. */ }
  }, [client, boot.status, account, route.route, route.pool, marketTab]);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_BEMINE_PRODUCT_FAMILY === 'fresh-v4') {
      let cancelled = false;
      setError('');
      void loadProductDisplayConfig({ basePath }).then(result => {
        if (cancelled) return;
        if (result.status === 'ready') {
          const key = freshReadClientIdentity(result);
          if (readClientIdentity.current !== key) {
            readClientIdentity.current = key;
            setClient(createLiveDataClient(result));
          }
        } else setClient(null);
        setBoot(result);
      }).catch(problem => {
        if (!cancelled) { setBoot({ status: 'error' }); setError(textError(problem)); }
      });
      return () => { cancelled = true; };
    }
    let cancelled = false;
    let retryTimer;
    let pollTimer;
    let shown = false;
    let currentReady = false;
    let pending = false;
    let staleExpiresAt = null;
    let expiredCleared = false;
    setBoot({ status: "loading" });
    setClient(null);
    setError("");
    const retry = attempt => {
      if (attempt < 3) retryTimer = setTimeout(() => void load(attempt + 1), 2_500);
    };
    const load = async (attempt = 0) => {
      if (cancelled || pending || currentReady) return;
      pending = true;
      try {
        const result = await loadProductConfig({ basePath });
        if (cancelled) return;
        if (result.status !== "ready") { setBoot(result); return; }
        // An older verified graph can paint public data, but cannot authorize
        // a wallet action. Keep it visible while bounded retries wait for the
        // journal's already-running single-flight chain refresh.
        if (!shown || result.readMode === 'current') {
          const service = createLiveDataClient(result);
          shown = true;
          setBoot(result);
          setClient(service);
        }
        if (result.readMode === 'current') currentReady = true;
        else {
          staleExpiresAt = Date.now() + 30 * 60_000 - result.snapshotAgeMs;
          retry(attempt);
        }
      } catch (e) {
        if (cancelled) return;
        if (!shown) { setBoot({ status: "error" }); setError(textError(e)); }
        else retry(attempt);
      } finally {
        pending = false;
      }
    };
    const checkStale = () => {
      if (cancelled || currentReady || document.visibilityState !== 'visible') return;
      if (!expiredCleared && staleExpiresAt !== null && Date.now() >= staleExpiresAt) {
        // A failed refresh cannot keep a once-valid product graph on screen forever.
        expiredCleared = true;
        setBoot({ status: 'error' }); setClient(null);
        clearWalletDisplay(); setStats(null); setStatsSource(null);
      }
      void load(3);
    };
    void load();
    pollTimer = setInterval(checkStale, 15_000);
    document.addEventListener('visibilitychange', checkStale);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', checkStale);
    };
  }, [bootAttempt]);
  useEffect(() => {
    if (!wallet?.on || !account) return;
    const invalidate = () => {
      if (connectedWallet.current !== wallet) return;
      epoch.current++;
      walletEpoch.current++;
      setOperator(null);
      setPending(null);
      setPrepared(null);
      const ticket = connectionLock.current;
      if (ticket?.provider === wallet && ticket.target?.reselectAccount === true
        && activeModal.current === ticket.target) ticket.walletContext = walletEpoch.current;
      else setModal(null);
    };
    return startWalletSession({ provider: wallet, account, chainId: 56, followAccountChanges: true,
      isCurrent: () => connectedWallet.current === wallet,
      onInvalidate: invalidate,
      onChecking: () => setWalletChecking(true),
      onRecovered: ({ account: selected }) => {
        if (!same(selected, account)) { clearWalletDisplay(); setAccount(getAddress(selected)); }
        setWalletChecking(false); setMessage('');
        setOperatorRefresh(v => v + 1); setRefresh(v => v + 1);
      },
      onDisconnected: () => {
        setWalletChecking(false); setAccount(null); setWallet(null); setWalletInfo(null);
        connectedWallet.current = null; clearWalletDisplay();
        setMessage(walletLanguage.current==='en' ? 'Wallet or network changed. Please reconnect.' : '钱包账户或网络已改变，请重新连接。');
        setRefresh(v => v + 1);
      },
    });
  }, [wallet, account]);
  useEffect(() => {
    setMemberTransactions(account && config?.displayOnly ? readMemberTransactions(config, account) : []);
  }, [account, config?.factory, config?.portfolioFactory, config?.displayOnly]);
  useEffect(() => {
    if (!account || !config?.displayOnly || !client?.provider || !memberTransactions.some(r => r.status === 'pending')) return;
    const context = walletEpoch.current, provider = client.provider;
    let cancelled = false, reading = false;
    const check = async () => {
      if (reading || document.visibilityState !== 'visible') return;
      reading = true;
      try {
        const updates = await Promise.all(memberTransactions.filter(r => r.status === 'pending').map(async record => {
          try {
            const receipt = await readMemberReceipt(provider, record);
            return { ...record, ...receipt, ...(receipt.status === 'confirmed' ? { confirmedAt: Date.now() } : {}) };
          }
          catch { return record; }
        }));
        if (cancelled || context !== walletEpoch.current) return;
        const settled = updates.filter(r => r.status !== 'pending');
        if (!settled.length) return;
        settled.forEach(record => showTransactionResult(record, { source: 'member-receipt' }));
        setMemberTransactions(previous => {
          const next = previous.map(r => updates.find(update => update.hash === r.hash) ?? r);
          saveMemberTransactions(config, account, next);
          return next;
        });
        setRefresh(v => v + 1);
        setMessage(settled.some(r => r.status === 'failed')
          ? L('交易在链上执行失败，请查看钱包交易记录。', 'Transaction failed on chain. See wallet history.')
          : '');
      } finally { reading = false; }
    };
    void check();
    const timer = setInterval(check, 2_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, config, client, memberTransactions]);
  useEffect(() => {
    if (!client || !account || !config?.displayOnly) return;
    return startReceiptDisplayCatchup(memberTransactions, {
      account, factory: config.factory,
      getState: () => {
        const state = refreshState.current;
        return { ...receiptDisplayState.current, portfolioSource: portfolioRead.current.source,
          visible: document.visibilityState === 'visible',
          busy: state.loading || state.busy || state.modal || state.pending || portfolioRead.current.busy,
          pastFirstRecordsPage: ['overview', 'records', 'rewards'].includes(route.route) && recordsPageRef.current > 0 };
      },
      // This separate generation updates materialized GETs. Governance,
      // quote, wallet and operator RPC reads retain their normal generation.
      onRefresh: () => setReceiptDisplayRefresh(value => value + 1),
    });
  }, [client, account, config?.factory, config?.portfolioFactory, config?.displayOnly,
    memberTransactions, route.route, route.pool, marketTab]);
  useEffect(() => {
    if (!pending?.awaitingFinality || !pending.hash || !account || !config || busy) return;
    const context = walletEpoch.current;
    let cancelled = false, reading = false;
    const check = async () => {
      if (reading || document.visibilityState !== 'visible' || activeModal.current || refreshState.current.busy) return;
      reading = true;
      try {
        const result = await recoverPending({ config, account, hash: pending.hash });
        if (!cancelled && context === walletEpoch.current) await handleResult(result, context);
      } catch { /* Preserve the pending transaction during temporary read failures. */ }
      finally { reading = false; }
    };
    const timer = setInterval(check, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [pending?.awaitingFinality, pending?.hash, account, config, busy]);
  useEffect(() => {
    if (!modal || transactionResult) return;
    restoreFocus.current = document.activeElement;
    modalRef.current?.querySelector("button,input")?.focus();
    const key = (e) => {
      if (e.key === "Escape" && (!busy || modal.type === "connect-wallet")) setModal(null);
      if (e.key === "Tab") {
        const elements = modalRef.current?.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),a[href],summary",
        );
        const visible = [...(elements ?? [])].filter(element => element.getClientRects().length > 0);
        if (!visible.length) return;
        const first = visible[0], last = visible[visible.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      restoreFocus.current?.focus();
    };
  }, [modal, busy, transactionResult]);

  const go = (next, pool) => {
    if (busy) return;
    location.hash = pool ? `${next}/${pool}` : next;
    setDetailTab("asset");
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const openAction = (kind, pool, extra = {}) => {
    if (busy || (loading && kind !== 'deposit' && !['overview', 'rewards', 'market'].includes(route.route))
      || (['overview', 'rewards', 'market'].includes(route.route)
      && ['claim', 'withdrawBnb', 'marketWithdraw', 'harvest', 'list'].includes(kind)
      && (positionsReadLoading || !!positionsReadError))) return;
    if (route.route === 'detail' && ['deposit', 'completeFirstoSale', 'finalizeFailure',
      'withdrawDeposit', 'claim', 'withdrawBnb', 'list'].includes(kind) && !detailActionReadyFor(kind)) return;
    if (['overview', 'rewards', 'market'].includes(route.route)
      && ['claim', 'withdrawBnb', 'marketWithdraw', 'harvest', 'list'].includes(kind)
      && !positionsActionReadyFor(kind)) return;
    if (['fill', 'cancel', 'expire'].includes(kind)) {
      const order = orders.find(row => String(row.id ?? row.orderId) === String(extra.orderId)
        && same(row.pool, pool?.pool));
      if (!marketOrderActionReady(order, kind)) return;
    }
    setError("");
    if (
      kind === "list" &&
      !shareListingView(pool).allowed
    ) {
      setError(
        L("这台矿机暂不支持份额转让", "Shares in this miner cannot be transferred at this stage"),
      );
      return;
    }
    setPrepared(null);
    setQuantity(kind === 'list' ? shareListingView(pool).defaultQuantity : "1");
    setPrice("");
    setModal({ type: "action", kind, pool, ...extra });
  };
  const openDetails = (pool) => {
    if (pool.kind === 'portfolio') { portfolioReturnRoute.current = ['overview','rewards'].includes(route.route) ? route.route : 'pools'; const revision=config?.displayOnly ? refresh : 0; if(!readPortfolioDisplay(config,pool.pool,account,Date.now(),revision))rememberPortfolioDisplay(config,pool,account,Date.now(),revision); go('portfolio', pool.pool); return; }
    // This row was verified by the preceding catalog read. Show its public
    // facts immediately while the new detail read runs; it cannot authorize a
    // wallet action and is never persisted in browser storage.
    setDetailPreview(pool);
    go("detail", pool.pool);
  };
  const date = (value) =>
    value == null
      ? "—"
      : new Date(Number(value) * 1000).toLocaleString(
          locale === "en" ? "en-GB" : "zh-CN",
          { timeZone: "Asia/Shanghai", hour12: false },
        );
  const actionLabel = (kind) => L(...(actionNames[kind] || [kind, kind]));
  const capacityCell = (order) => {
    const capacity = orderCapacity[order.pool?.toLowerCase()];
    if (capacity?.available && capacity.validUntil > capacityNow) return <>
      <strong>{amount(shareDailyCapacityPriceWei(order.pricePerUnitWei, capacity.estimated24hAtomic))}</strong>
      <small>Firsto · {new Date(capacity.observedAt).toLocaleString(locale === "en" ? "en-GB" : "zh-CN")}</small>
    </>;
    if (capacity?.loading) return L("计算中…", "Loading…");
    return <button className="text-button" onClick={() => void readAdditionalOrderCapacity(order)} disabled={!config || loading}>
      {capacity?.available ? L("报价已过期 · 刷新", "Quote expired · refresh") : capacity ? L("暂不可用 · 重试", "Unavailable · retry") : L("查询日产能价", "Check capacity price")}
    </button>;
  };
  const accountNeeded = ["overview", "rewards"].includes(route.route);

  useEffect(() => {
    if (!client || refreshIntervalMs(route.route) === null) return;
    const page = JSON.stringify([route.route, route.pool?.toLowerCase() || '', account?.toLowerCase() || '']);
    lastPageRefresh.current.set(page, Date.now());
    const check = () => {
      if (['overview', 'records', 'rewards'].includes(route.route) && recordsPage > 0) return;
      const state = refreshState.current;
      const now = Date.now();
      if (!pageRefreshDue({ route: route.route, lastAttempt: lastPageRefresh.current.get(page), now,
        visible: document.visibilityState === 'visible',
        busy: state.loading || state.busy || state.modal || state.pending || portfolioRead.current.busy,
        failed: state.failed || portfolioRead.current.failed })) return;
      lastPageRefresh.current.set(page, now);
      setRefresh(value => value + 1);
    };
    const timer = setInterval(check, 5_000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check); };
  }, [client, route.route, route.pool, account, recordsPage]);

  useEffect(() => {
    if (!client || config?.displayOnly) return;
    if (['overview', 'records', 'rewards'].includes(route.route) && recordsPage > 0) return;
    const pageSource = route.route === 'home'
      ? [source, statsSource].find(item => item?.readMode === 'verified_snapshot') ?? statsSource ?? source
      : route.route === 'market' && marketTab === 'shares' ? marketOrderSource : source;
    const page = JSON.stringify([route.route, route.pool?.toLowerCase() || '', account?.toLowerCase() || '', marketTab]);
    if (loadedRoute !== route.route + (route.pool ? `/${route.pool}` : '')
      || (loadedAccount || '').toLowerCase() !== (account || '').toLowerCase()) return;
    if (pageSource?.readMode === 'current' && pageSource.stale !== true) {
      fastSnapshotRetries.current.delete(page);
      return;
    }
    if (pageSource?.cacheOrigin === 'server' || pageSource?.readMode !== 'verified_snapshot' || pageSource.refreshing !== true
      || (fastSnapshotRetries.current.get(page) ?? 0) >= 4) return;
    const timer = setTimeout(() => {
      const state = refreshState.current;
      if (document.visibilityState !== 'visible' || state.loading || state.busy || state.modal
        || state.pending || portfolioRead.current.busy) return;
      fastSnapshotRetries.current.set(page, (fastSnapshotRetries.current.get(page) ?? 0) + 1);
      setRefresh(value => value + 1);
    }, 2_500);
    return () => clearTimeout(timer);
  }, [client, route.route, route.pool, account, marketTab, loadedRoute, loadedAccount,
    source, statsSource, marketOrderSource,
    refresh, loading, revalidating, busy, modal, pending, recordsPage]);

  useEffect(() => {
    if (!client) return;
    if (route.route === 'notifications') {
      setLoadedRoute('notifications'); setLoading(false); setError(''); setReadRetry(null); setReadFailed(false);
      return;
    }
    let cancelled = false;
    const revision = ++epoch.current;
    const current = () => !cancelled && revision === epoch.current;
    const accountKey = account?.toLowerCase() || '';
    const pageKey = pageDisplayKey(route, account, marketTab);
    const cache = pageCache.current.get(client);
    const saved = cache?.get(pageKey);
    const recent = entry => entry && Date.now() - entry.savedAt < 120_000;
    const persisted = recent(saved) ? null : route.route === 'detail'
      ? readPoolDisplaySnapshot(displayStorage(), client.manifest, route, account, { maxAgeMs: 30 * 60_000 })
      : readPageSnapshot(displayStorage(), client.manifest, pageKey);
    const needsCatalog = ['home', 'pools'].includes(route.route)
      || route.route === 'market' && marketTab === 'whole' || (route.route === 'governance' && !account);
    const shared = needsCatalog && !recent(saved) && !persisted
      ? [...(cache?.values() || [])].reverse().find(entry => recent(entry) && entry.account === accountKey && entry.result.catalog)
      : null;
    const sharedDisplay = shared && displayOnlySnapshot(shared.result, client.manifest, shared.savedAt);
    const cached = recent(saved) ? displayOnlySnapshot(saved.result, client.manifest, saved.savedAt)
      : persisted || (sharedDisplay?.catalog ? { catalog: sharedDisplay.catalog } : null);
    const showResult = result => {
      if (result.catalog) {
        setPools(mergePublishedProjects(result.catalog.items.map(viewPool), publishedProjects.current));
        setPoolCursor(result.catalog.nextCursor);
        setSource(result.catalog.source);
      }
      if (result.detail) {
        setDetail(viewPool(result.detail.item));
        setSource(result.detail.source);
      }
      if (result.governance) { setGovernance(result.governance.data);
        setGovernanceProof({ pool: route.pool, account: account || ZeroAddress, source: result.governance.source }); }
      setLoadedAccount(account);
    };
    if (config?.displayOnly && recent(saved) && cached && saved.refresh === displayRefreshKey) {
      showResult(cached);
      setLoadedRoute(route.route + (route.pool ? `/${route.pool}` : ''));
      setCachedPage(false); setLoading(false); setRevalidating(false);
      setError(''); setReadRetry(null); setReadFailed(false);
      return () => { cancelled = true; epoch.current++; };
    }
    const clearRound = progress => {
      setReadRetry(progress.attempt > 1 ? progress : null);
      setReadFailed(false);
      setCachedPage(!!cached);
      setLoadedRoute(cached || (!needsCatalog && route.route !== 'detail')
        ? route.route + (route.pool ? `/${route.pool}` : '') : '');
      setLoadedAccount(null);
      setLoading(!cached);
      setRevalidating(!!cached);
      setError("");
      setPrepared(null);
      // The route's sections own their data. Keep verified display values visible
      // while this page revalidates, instead of clearing unrelated panels.
      if (!cached && progress.attempt === 1) {
        if (needsCatalog) { setPools(mergePublishedProjects([], publishedProjects.current)); setPoolCursor(null); }
        if (route.route === 'detail') { setDetail(null); setGovernance(null); setGovernanceProof(null); setMembers([]);
          setMembersRead({ status: 'idle' }); setYieldData(null); }
        setSource(null);
      }
      if (cached) showResult(cached);
    };
    async function load() {
      return readPageRound(client, { route, account, marketTab });
    }
    retryReadRound(load, { isCurrent: current, onAttempt: clearRound,
      onRetry: progress => { if (current()) setReadRetry(progress); } })
      .then((result) => {
        if (result === READ_CANCELLED || !current()) return;
        if (result.catalog || result.detail) {
          let entries = pageCache.current.get(client);
          if (!entries) { entries = new Map(); pageCache.current.set(client, entries); }
          entries.delete(pageKey);
          entries.set(pageKey, { savedAt: Date.now(), account: accountKey, refresh: displayRefreshKey, result });
          if (entries.size > 8) entries.delete(entries.keys().next().value);
          writeDisplaySnapshot(displayStorage(), client.manifest, pageKey, result);
          writePoolDisplaySnapshots(displayStorage(), client.manifest, result, account);
        }
        showResult(result);
        if (result.detail) setDetailPreview(null);
        setCachedPage(false);
      })
      .catch((e) => {
        if (current()) {
          invalidateDisplayOnReorg(client, e);
          setError(textError(e));
          setReadFailed(true);
          // A failed revalidation must not turn the last verified display into
          // an apparent empty account. Transaction paths still require fresh reads.
          setCachedPage(!!cached);
        }
      })
      .finally(() => {
        if (current()) {
          setLoading(false);
          setRevalidating(false);
          setReadRetry(null);
          setLoadedRoute(route.route + (route.pool ? `/${route.pool}` : ""));
        }
      });
    return () => {
      cancelled = true;
      epoch.current++;
    };
  }, [client, account, route.route, route.pool, marketTab, displayRefreshKey]);

  useEffect(() => {
    if (!client || !['overview', 'rewards', 'governance', 'market'].includes(route.route)) return;
    let cancelled = false;
    ++positionsReadEpoch.current;
    const owner = account?.toLowerCase();
    setPositionsReadError('');
    setPositionsReadSource(null);
    if (!owner) {
      setPositions([]); setPositionCursor(null); setPositionsLoaded(false); setPositionsAccount(null);
      setPositionsReadLoading(false);
      return;
    }
    const cacheKey = `positions:${owner}`;
    const memory = readCache.current.get(client)?.get(cacheKey);
    const cached = displayListSnapshot(memory && Date.now() - memory.savedAt < 120_000
      ? displayOnlySnapshot(memory.result, client.manifest, memory.savedAt)
      : readPageSnapshot(displayStorage(), client.manifest, cacheKey));
    if (cached) {
      setPositions(cached.items.map(viewPool));
      setPositionCursor(cached.nextCursor);
      setPositionsLoaded(true);
      setPositionsAccount(account);
      setMarketCredit(cached.marketBnbOwed);
      setPositionsReadSource(cached.source);
      if (['overview', 'rewards', 'governance'].includes(route.route)) setSource(cached.source);
    } else {
      setPositions([]); setPositionCursor(null); setPositionsLoaded(false); setPositionsAccount(null);
    }
    if (config?.displayOnly && cached && memory?.refresh === displayRefreshKey && Date.now() - memory.savedAt < 120_000) {
      setPositionsReadLoading(false);
      return () => { cancelled = true; ++positionsReadEpoch.current; };
    }
    setPositionsReadLoading(true);
    retryReadRound(() => (client.readDisplayPositions ?? client.readPositions)({ account }), { isCurrent: () => !cancelled })
      .then(result => {
        if (cancelled || result === READ_CANCELLED) return;
        setPositions(result.items.map(viewPool));
        setPositionCursor(result.nextCursor);
        setPositionsLoaded(true);
        setPositionsAccount(account);
        setMarketCredit(result.marketBnbOwed);
        setPositionsReadSource(result.source);
        if (['overview', 'rewards', 'governance'].includes(route.route)) setSource(result.source);
        let entries = readCache.current.get(client);
        if (!entries) { entries = new Map(); readCache.current.set(client, entries); }
        entries.set(cacheKey, { savedAt: Date.now(), refresh: displayRefreshKey, result });
        writeDisplaySnapshot(displayStorage(), client.manifest, cacheKey, result);
      })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setPositionsReadError(textError(error)); } })
      .finally(() => { if (!cancelled) setPositionsReadLoading(false); });
    return () => { cancelled = true; ++positionsReadEpoch.current; };
  }, [client, account, route.route, displayRefreshKey]);

  useEffect(() => {
    if (!client || route.route !== 'market') return;
    let cancelled = false;
    ++marketOrdersEpoch.current;
    setMarketOrdersError('');
    setMarketOrderSource(null);
    setMarketOrderIdentity('');
    if (marketTab === 'whole' || (marketTab === 'mine' && !account)) {
      setOrders([]); setOrderCursor(null); setMarketOrdersLoading(false);
      return;
    }
    const cacheKey = marketTab === 'mine' ? `orders:${account.toLowerCase()}` : 'orders:active';
    const memory = readCache.current.get(client)?.get(cacheKey);
    const cached = displayListSnapshot(memory && Date.now() - memory.savedAt < 120_000
      ? displayOnlySnapshot(memory.result, client.manifest, memory.savedAt)
      : readPageSnapshot(displayStorage(), client.manifest, cacheKey));
    if (cached) {
      setOrders(cached.items);
      setOrderCursor(cached.nextCursor);
      setMarketOrderSource(cached.source);
    } else {
      setOrders([]); setOrderCursor(null);
    }
    if (config?.displayOnly && cached && memory?.refresh === displayRefreshKey && Date.now() - memory.savedAt < 120_000) {
      setMarketOrderIdentity(`${marketTab}:${account?.toLowerCase() || ''}`);
      setMarketOrdersLoading(false);
      return () => { cancelled = true; ++marketOrdersEpoch.current; };
    }
    setMarketOrdersLoading(true);
    retryReadRound(() => (client.readDisplayOrders ?? client.readOrders)(marketTab === 'mine' ? { seller: account } : { active: true }),
      { isCurrent: () => !cancelled })
      .then(result => {
        if (cancelled || result === READ_CANCELLED) return;
        setOrders(result.items);
        setOrderCursor(result.nextCursor);
        setMarketOrderSource(result.source);
        setMarketOrderIdentity(`${marketTab}:${account?.toLowerCase() || ''}`);
        let entries = readCache.current.get(client);
        if (!entries) { entries = new Map(); readCache.current.set(client, entries); }
        entries.set(cacheKey, { savedAt: Date.now(), refresh: displayRefreshKey, result });
        writeDisplaySnapshot(displayStorage(), client.manifest, cacheKey, result);
      })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setMarketOrdersError(textError(error)); } })
      .finally(() => { if (!cancelled) setMarketOrdersLoading(false); });
    return () => { cancelled = true; ++marketOrdersEpoch.current; };
  }, [client, account, route.route, marketTab, displayRefreshKey]);

  useEffect(() => {
    if (!client || !['records', 'overview', 'rewards'].includes(route.route)) return;
    let cancelled = false;
    ++activityReadEpoch.current;
    const owner = route.route === 'records' ? undefined : account;
    setRecordsPage(0);
    setActivityReadError('');
    setActivityReadSource(null);
    setActivityTotals({ totalCount: null, overviewTotalCount: null });
    if (route.route !== 'records' && !owner) {
      setActivity([]); setActivityCursor(null); setActivityReadLoading(false);
      return;
    }
    const cacheKey = `activity:${owner?.toLowerCase() || 'public'}`;
    const memory = readCache.current.get(client)?.get(cacheKey);
    const cached = displayListSnapshot(memory && Date.now() - memory.savedAt < 120_000
      ? displayOnlySnapshot(memory.result, client.manifest, memory.savedAt)
      : readPageSnapshot(displayStorage(), client.manifest, cacheKey));
    if (cached) {
      setActivity(cached.items);
      setActivityCursor(cached.nextCursor);
      setActivityTotals({ totalCount: cached.totalCount, overviewTotalCount: cached.overviewTotalCount });
      setActivityReadSource(cached.source);
      if (route.route === 'records') setSource(cached.source);
    } else {
      setActivity([]); setActivityCursor(null);
    }
    if (config?.displayOnly && cached && memory?.refresh === displayRefreshKey && Date.now() - memory.savedAt < 120_000) {
      setActivityReadLoading(false);
      return () => { cancelled = true; ++activityReadEpoch.current; };
    }
    setActivityReadLoading(true);
    retryReadRound(() => client.readActivity({ account: owner, limit: 50 }), { isCurrent: () => !cancelled })
      .then(result => {
        if (cancelled || result === READ_CANCELLED) return;
        setActivity(result.items);
        setActivityCursor(result.nextCursor);
        setActivityTotals({ totalCount: result.totalCount, overviewTotalCount: result.overviewTotalCount });
        setActivityReadSource(result.source);
        if (route.route === 'records') setSource(result.source);
        let entries = readCache.current.get(client);
        if (!entries) { entries = new Map(); readCache.current.set(client, entries); }
        entries.set(cacheKey, { savedAt: Date.now(), refresh: displayRefreshKey, result });
        writeDisplaySnapshot(displayStorage(), client.manifest, cacheKey, result);
      })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setActivityReadError(textError(error)); } })
      .finally(() => { if (!cancelled) setActivityReadLoading(false); });
    return () => { cancelled = true; ++activityReadEpoch.current; };
  }, [client, account, route.route, displayRefreshKey]);

  useEffect(() => {
    if (!client || route.route !== 'home') return;
    let cancelled = false;
    setStatsReadError('');
    const memory = readCache.current.get(client)?.get('stats');
    const cached = memory && Date.now() - memory.savedAt < 120_000
      ? displayOnlySnapshot(memory.result, client.manifest, memory.savedAt)
      : readPageSnapshot(displayStorage(), client.manifest, 'stats');
    setStats(cached?.data ?? null);
    setStatsSource(cached?.source ?? null);
    if (config?.displayOnly && cached && memory?.refresh === displayRefreshKey && Date.now() - memory.savedAt < 120_000)
      return () => { cancelled = true; };
    retryReadRound(() => (client.readDisplayStats ?? client.readStats)(), { isCurrent: () => !cancelled })
      .then(result => {
        if (cancelled || result === READ_CANCELLED) return;
        setStats(result.data);
        setStatsSource(result.source);
        let entries = readCache.current.get(client);
        if (!entries) { entries = new Map(); readCache.current.set(client, entries); }
        entries.set('stats', { savedAt: Date.now(), refresh: displayRefreshKey, result });
        writeDisplaySnapshot(displayStorage(), client.manifest, 'stats', result);
      })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setStatsReadError(textError(error)); } });
    return () => { cancelled = true; };
  }, [client, route.route, displayRefreshKey]);

  function readCachedSection(key, reader) {
    if (!config?.displayOnly) return reader();
    let cache = readCache.current.get(client);
    if (!cache) { cache = new Map(); readCache.current.set(client, cache); }
    const saved = cache.get(key);
    if (saved?.refresh === displayRefreshKey && Date.now() - saved.savedAt < 120_000)
      return saved.promise ?? Promise.resolve(saved.result);
    const entry = { savedAt: Date.now(), refresh: displayRefreshKey };
    entry.promise = Promise.resolve().then(reader).then(result => {
      entry.result = result; delete entry.promise; return result;
    }, error => { if (cache.get(key) === entry) cache.delete(key); throw error; });
    cache.set(key, entry);
    if (cache.size > 128) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  useEffect(() => {
    if (!client || route.route !== 'detail' || !route.pool || !detail || loading) return;
    let cancelled = false;
    ++activityReadEpoch.current;
    const pool = route.pool;
    const owner = account || ZeroAddress;
    const governanceKey = `pool-governance:${pool.toLowerCase()}:${owner.toLowerCase()}`;
    const activityKey = `pool-activity:${pool.toLowerCase()}`;
    const entries = readCache.current.get(client);
    const reusable = key => {
      const saved = entries?.get(key);
      return config?.displayOnly && saved?.refresh === displayRefreshKey && Date.now() - saved.savedAt < 120_000 ? saved.result : null;
    };
    const currentGovernance = reusable(governanceKey);
    const currentActivity = reusable(activityKey);
    const governanceCache = currentGovernance ?? readPageSnapshot(displayStorage(), client.manifest, governanceKey);
    const activityCache = currentActivity ?? readPageSnapshot(displayStorage(), client.manifest, activityKey);
    const remember = (key, result) => {
      let cache = readCache.current.get(client);
      if (!cache) { cache = new Map(); readCache.current.set(client, cache); }
      cache.set(key, { savedAt: Date.now(), refresh: displayRefreshKey, result });
      writeDisplaySnapshot(displayStorage(), client.manifest, key, result);
    };
    if (governanceCache) { setGovernance(governanceCache.data);
      setGovernanceProof({ pool, account: owner, source: governanceCache.source }); }
    else { setGovernance(null); setGovernanceProof(null); }
    setActivityReadError(''); setActivityReadLoading(!currentActivity);
    if (activityCache) { setActivity(activityCache.items); setActivityCursor(activityCache.nextCursor);
      setActivityReadSource(activityCache.source);
      setActivityTotals({ totalCount: activityCache.totalCount, overviewTotalCount: activityCache.overviewTotalCount }); }
    else { setActivity([]); setActivityCursor(null); setActivityReadSource(null);
      setActivityTotals({ totalCount: null, overviewTotalCount: null }); }
    if (!currentGovernance && detailTab !== 'vote') void readCachedSection(governanceKey, () => client.readGovernance({ pool, account: owner }))
      .then(result => { if (!cancelled) { setGovernance(result.data);
        setGovernanceProof({ pool, account: owner, source: result.source });
        remember(governanceKey, result); } })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error);
        if (!governanceCache) { setGovernance(null); setGovernanceProof(null); } } });
    if (!currentActivity) void readCachedSection(activityKey, () => client.readActivity({ pool }))
      .then(result => {
        if (!cancelled) { setActivity(result.items); setActivityCursor(result.nextCursor);
          setActivityReadSource(result.source);
          setActivityTotals({ totalCount: result.totalCount, overviewTotalCount: result.overviewTotalCount });
          remember(activityKey, result); }
      })
      .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setActivityReadError(textError(error)); } })
      .finally(() => { if (!cancelled) setActivityReadLoading(false); });
    return () => { cancelled = true; ++activityReadEpoch.current; };
  }, [client, config?.displayOnly, account, route.route, route.pool, detail, detailTab, loading, displayRefreshKey]);

  useEffect(() => { setRecordsPage(0); }, [client, route.route, route.pool, account]);

  useEffect(() => {
    if (!["market", "pools", "detail"].includes(route.route)) return;
    setCapacityNow(Date.now());
    const timer = setInterval(() => setCapacityNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [route.route]);

  useEffect(() => {
    let cancelled = false;
    if (!client || !config) { setPoolCapacity({}); return; }
    setPoolCapacity(previous => Object.fromEntries(Object.entries(previous)
      .filter(([, quote]) => quote?.validUntil > Date.now())));
    if (loading || !['pools', 'detail', 'overview', 'market'].includes(route.route)) return;
    const rows = route.route === 'detail' ? (detail ? [detail] : [])
      : route.route === 'pools' ? pools
        : route.route === 'market' ? (marketTab === 'whole' ? pools.filter(row => row.status === 'Listed') : [])
          : positions;
    if (!rows.length) return;
    const provider = createReadOnlyHttpProvider(config);
    const uniqueRows = [...new Map(rows.filter(row => row?.pool).map(row => [row.pool.toLowerCase(), row])).values()];
    let next = 0;
    const worker = async () => {
      while (!cancelled && next < uniqueRows.length) {
        const row = uniqueRows[next++];
        if (!row?.trusted || !row.params || row.unitPriceWei === null) continue;
        const key = row.pool.toLowerCase();
        const previous = capacityDisplay.current.pools[key];
        if (previous?.available && previous.validUntil > Date.now()
          && previous.forPriceWei === row.unitPriceWei.toString()) continue;
        const saved = readCapacityDisplay(displayStorage(), client.manifest, row.pool, row.unitPriceWei);
        if (saved && !cancelled) {
          setPoolCapacity(previous => ({ ...previous, [key]: saved }));
          // A valid identity- and price-bound display quote can be reused until
          // its stated expiry; page refreshes need not re-spend the shared quota.
          if (saved.validUntil > Date.now() + 30_000) continue;
        }
        setPoolCapacity(previous => ({ ...previous, [key]: { ...previous[key], loading: true } }));
        const quote = await readShareDailyCapacityPrice(provider, {
          factory: config.factory, pool: row.pool, pricePerUnitWei: row.unitPriceWei,
          displayOnly: config.displayOnly, params: row.params,
          allowUnownedTarget: ['Funding', 'Funded'].includes(row.status),
        });
        if (!cancelled) {
          const displayed = { ...quote, forPriceWei: row.unitPriceWei.toString() };
          if (quote.available) writeCapacityDisplay(displayStorage(), client.manifest, displayed);
          setPoolCapacity(previous => !quote.available && previous[key]?.available
            && previous[key].validUntil > Date.now() ? previous : { ...previous, [key]: displayed });
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(6, uniqueRows.length) }, worker));
    return () => { cancelled = true; };
  }, [client, route.route, marketTab, pools, positions, detail, boot, refresh, loading, poolQuoteRevision]);

  useEffect(() => {
    const revision = ++capacityEpoch.current;
    setOrderCapacity(previous => Object.fromEntries(Object.entries(previous)
      .filter(([, quote]) => quote?.validUntil > Date.now())));
    if (!client || route.route !== "market" || marketTab === "whole" || !orders.length || !config) return;
    const provider = createReadOnlyHttpProvider(config);
    const firstByPool = new Map();
    for (const order of orders) {
      const key = order.pool?.toLowerCase();
      if (key && !firstByPool.has(key)) firstByPool.set(key, order);
    }
    // Limit automatic lookups against the shared Firsto quota. Others are explicit.
    void Promise.all([...firstByPool].slice(0, 2).map(async ([key, order]) => {
      const cached = capacityDisplay.current.orders[key];
      if (cached?.available && cached.validUntil > Date.now()
        && cached.forPriceWei === order.pricePerUnitWei.toString()) return;
      setOrderCapacity(previous => ({ ...previous, [key]: { loading: true } }));
      const result = await readShareDailyCapacityPrice(provider, {
        factory: config.factory, pool: order.pool, pricePerUnitWei: order.pricePerUnitWei,
        displayOnly: config.displayOnly,
      });
      if (capacityEpoch.current !== revision) return;
      setCapacityNow(Date.now());
      setOrderCapacity(previous => ({ ...previous,
        [key]: { ...result, forPriceWei: order.pricePerUnitWei.toString() } }));
    }));
    return () => { capacityEpoch.current++; };
  }, [client, route.route, marketTab, orders, boot]);

  async function readAdditionalOrderCapacity(order) {
    if (!config || !client || !order?.pool) return;
    const key = order.pool.toLowerCase();
    if (orderCapacity[key]?.loading) return;
    const revision = capacityEpoch.current;
    setOrderCapacity(previous => ({ ...previous, [key]: { loading: true } }));
    const result = await readShareDailyCapacityPrice(createReadOnlyHttpProvider(config), {
      factory: config.factory, pool: order.pool, pricePerUnitWei: order.pricePerUnitWei,
      displayOnly: config.displayOnly,
    });
    if (capacityEpoch.current !== revision) return;
    setCapacityNow(Date.now());
    setOrderCapacity(previous => ({ ...previous, [key]: result }));
  }

  useEffect(() => {
    let cancelled = false;
    const yieldKey = `pool-yield:${route.pool?.toLowerCase() || ''}:${account?.toLowerCase() || 'public'}:${yieldDays}`;
    const query = { pool: route.pool, account: account || undefined, days: yieldDays };
    const enabled = client && route.route === 'detail' && route.pool && detailTab === 'records';
    const cached = enabled
      ? cachedYieldWindow(client, query) ?? readPageSnapshot(displayStorage(), client.manifest, yieldKey) : null;
    setYieldData(cached?.data || null);
    setYieldError(''); setYieldLoading(!!enabled);
    if (enabled)
      readYieldWindow(client, query, { revision: displayRefreshKey })
        .then((result) => {
          if (!cancelled) { setYieldData(result.data);
            writeDisplaySnapshot(displayStorage(), client.manifest, yieldKey, result); }
        })
        .catch(error => { if (!cancelled) { invalidateDisplayOnReorg(client, error); setYieldError(textError(error)); } })
        .finally(() => { if (!cancelled) setYieldLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [client, route.route, route.pool, detailTab, account, yieldDays, displayRefreshKey]);
  function connect() {
    if (busy && !connectionLock.current) return;
    setConnectionError("");
    discovery.current?.refresh();
    setModal(connectionLock.current?.target || { type: "connect-wallet", reselectAccount: !!account });
  }
  function cancelWalletScan() {
    const ticket = connectionLock.current;
    qrConnector.current?.cancel();
    if (!ticket?.remote) return;
    connectionLock.current = null;
    setConnectingId(null); setWalletQr(null); setBusy(false);
    if (ticket.provider !== connectedWallet.current) void qrConnector.current?.disconnect();
  }
  async function selectWallet(entry, remote = false) {
    if (connectionLock.current || busy || activeModal.current?.type !== "connect-wallet") return;
    // Keep the chosen concrete provider, never re-read a mutable window.ethereum here.
    if (!remote && !discovery.current?.getWallets().some(item => item.id === entry.id && item.provider === entry.provider)) return;
    if (remote && (!walletConnectEnabled || entry.id !== 'walletconnect')) return;
    const target = activeModal.current, ticket = { target, remote, walletContext: walletEpoch.current };
    connectionLock.current = ticket;
    setConnectingId(entry.id);
    setOperator(null);
    setConnectionError("");
    setWalletQr(null);
    setBusy(true);
    const current = () => connectionLock.current === ticket && activeModal.current === target
      && ticket.walletContext === walletEpoch.current;
    try {
      if (remote && !qrConnector.current) qrConnector.current = walletConnectForPage();
      const provider = remote ? await qrConnector.current.connect({ onQr: image => { if (current()) setWalletQr(image); } }) : entry.provider;
      ticket.provider = provider;
      if (!current()) { if (remote && provider !== connectedWallet.current) await provider.disconnect?.().catch(() => {}); return; }
      const owner = await connectWallet(provider, { reselectAccount: target.reselectAccount === true && !remote });
      if (!current()) { if (remote && provider !== connectedWallet.current) await provider.disconnect?.().catch(() => {}); return; }
      walletEpoch.current++;
      connectedWallet.current = provider;
      setWalletChecking(false);
      clearWalletDisplay();
      setWallet(provider);
      setWalletInfo({ ...entry, provider });
      setAccount(getAddress(owner));
      setPrepared(null);
      setModal(null);
      setPending(null);
      setMessage("");
    } catch (e) {
      if (current() && e?.code !== 'WC_CANCELLED') setConnectionError(e?.code === 'WC_TIMEOUT'
        ? L('扫码连接已超时，请重新扫码。', 'QR connection timed out. Please scan again.') : walletConnectionError(e, locale));
    } finally {
      if (connectionLock.current === ticket) {
        connectionLock.current = null;
        setConnectingId(null);
        setWalletQr(null);
        setBusy(false);
        if (wallet && account) setRefresh(value => value + 1);
      }
    }
  }
  function showTransactionProgress(state) {
    const reported = typeof state === 'string' ? state : state.status;
    const stage = reported === 'pending' && typeof state === 'object' && !state.hash ? 'needs-verification' : reported;
    setTransactionStage(stage);
    const gasWei = stage === 'awaiting-signature' && typeof state === 'object' ? state.maxGasWei : null;
    setTransactionGasWei(gasWei ?? null);
    const label = L(...(transactionLabels[stage] || transactionLabels.rechecking));
    setMessage(gasWei == null ? label : `${label} · ${L('Gas 费用上限', 'Maximum Gas fee')} ${displayGasFee(gasWei)} BNB`);
  }
  async function connectJournal({ inspect = true, onState } = {}) {
    const context = walletEpoch.current;
    if (!wallet || !account || !config)
      throw new Error(L("请先连接钱包。", "Connect your wallet first."));
    await authenticate({ provider: wallet, account, config, onState });
    if (!inspect) return; // sendProductTransaction performs its own fresh pending-record check.
    const result = await readPending({ account, config });
    if (context !== walletEpoch.current)
      throw new Error(
        L("钱包已改变，请重新核对。", "Wallet changed. Please check again."),
      );
    setPending(result.record ? { ...result.record, canAbandon: result.canAbandon === true,
      canRequestLegacyEnvelope: result.canRequestLegacyEnvelope === true } : null);
    return result;
  }
  async function inspectPending() {
    setBusy(true);
    setError("");
    try {
      const result = await connectJournal();
      setMessage(
        result.record
          ? L(
              "找到待核对的交易，请核对链上结果。",
              "A pending transaction needs verification.",
            )
          : L("没有待核对的交易。", "No pending transaction."),
      );
    } catch (e) {
      setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (busy) return;
    const target = modal,
      context = walletEpoch.current,
      revision = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (!wallet || !account || !config)
        throw new Error(L("请先连接钱包。", "Connect your wallet first."));
      const input = {
        provider: wallet,
        config,
        account,
        pool: target.pool?.pool,
        kind: target.kind,
        quantity,
        price,
        proposalId: target.proposalId,
        support: target.support,
        orderId: target.orderId,
      };
      const result = await prepareProductAction(input);
      if (
        context === walletEpoch.current &&
        revision === epoch.current &&
        activeModal.current === target
      )
        setPrepared({ ...result, forModal: target });
    } catch (e) {
      if (context === walletEpoch.current && activeModal.current === target)
        setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function handleResult(result, context = walletEpoch.current) {
    if (context !== walletEpoch.current) return;
    if (result.walletOnly) {
      setMemberTransactions(previous => {
        const next = [...previous.filter(r => r.hash !== result.hash), result.record].slice(-20);
        saveMemberTransactions(config, account, next);
        return next;
      });
      setPrepared(null); setModal(null); setRefresh(v => v + 1);
      setMessage(L('交易已提交，后台更新链上结果。', 'Transaction submitted. Its on-chain result updates in the background.'));
      return;
    }
    if (result.status === "idle") {
      setPending(null);
      setMessage(L("没有待核对的交易。", "No pending transaction."));
      return;
    }
    if (result.status === "pending") {
      let saved = result.record;
      try {
        const view = await readPending({ account, config });
        saved = view.record ? { ...view.record, canAbandon: view.canAbandon === true,
          canRequestLegacyEnvelope: view.canRequestLegacyEnvelope === true,
          legacyEnvelopeRejected: result.legacyEnvelopeRejected === true } : saved;
      } catch {}
      if (context !== walletEpoch.current) return;
      const awaitingFinality = awaitingTransactionFinality(result);
      setPending(awaitingFinality ? { ...saved, hash: result.hash, awaitingFinality: true } : saved);
      setRecoveryHash(
        result.hash || saved?.recoveryHashes?.at(-1) || saved?.hash || "",
      );
      const fallback = result.legacyEnvelopeRejected
        ? L('钱包拒绝了交易信封，且尚未发现广播。可手动尝试一次兼容交易；请先核对钱包历史。',
          'Your wallet rejected the transaction envelope with no broadcast observed. Check wallet history before trying one legacy transaction manually.')
        : result.hash
        ? L(
            "交易已提交，等待最终确认。请稍后核对结果。",
            "Transaction submitted. Check its final outcome shortly.",
          )
        : L(
            "发送结果待核对。请检查钱包记录，不要重复发送。",
            "The submission outcome needs checking. Review your wallet history; do not send again.",
          );
      setMessage(awaitingFinality ? '' : locale === "zh" && result.message ? result.message : fallback);
      setModal(null);
      return;
    }
    setPending(null);
    setRecoveryHash("");
    setPrepared(null);
    setModal(null);
    setRefresh((v) => v + 1);
    if (route.route === 'operator') setOperatorRefresh(v => v + 1);
    showTransactionResult(result);
    if (result.status === "confirmed" && result.finalized === true && result.action === "claim")
      setNotificationClaim(result);
    setMessage(
      result.status === "confirmed"
        ? ""
        : L(
            "交易未完成原操作，已核对最终结果。",
            "The original action did not complete. Its final outcome has been checked.",
          ),
    );
    const deposit = result.action === "deposit" && result.targetType !== 'portfolio'
      && !same(result.factory, config.portfolioFactory) ? result : null;
    if (result.status === 'confirmed' && result.finalized === true && result.action === 'deposit'
      && result.targetType === 'portfolio' && same(result.factory, config.portfolioFactory)
      && result.poolAddress && result.transactionHash && lastConfirmed.current !== result.transactionHash) {
      try {
        const { item: project } = await readPortfolioDisplayRow(config, client.provider, result.poolAddress, account);
        if (context === walletEpoch.current) {
          lastConfirmed.current = result.transactionHash;
          setModal({ type: 'portfolio-share', pool: project, confirmation: result });
        }
      } catch {
        if (context === walletEpoch.current) setMessage(L('认购已确认，项目资料暂时无法读取，请稍后从项目中分享。', 'Subscription confirmed. Project data is temporarily unavailable; share from the project later.'));
      }
    }
    if (
      result.status === "confirmed" &&
      deposit?.finalized &&
      deposit.poolAddress &&
      deposit.transactionHash &&
      lastConfirmed.current !== deposit.transactionHash
    ) {
      const known = [detail, prepared?.row, ...pools].find(
        (row) =>
          row?.trusted && row.params && same(row.pool, deposit.poolAddress),
      );
      let project = known
        ? { ...viewPool(known), status: "Unknown", remaining: null }
        : null;
      try {
        const snapshot = config.displayOnly
          ? { pools: [(await client.readPool({ pool: deposit.poolAddress, account })).item] }
          : await readPoolSnapshot(wallet, {
          factory: config.factory,
          lens: config.lens,
          account,
          pools: [deposit.poolAddress],
        });
        project = viewPool(snapshot.pools[0]);
      } catch {}
      if (context === walletEpoch.current) {
        if (project?.params) {
          lastConfirmed.current = deposit.transactionHash;
          setModal({ type: "share", pool: project, confirmation: deposit });
        } else
          setMessage(
            L(
              "认购已确认，暂时无法读取项目资料。请稍后在矿机详情中分享。",
              "Subscription confirmed. Project information is temporarily unavailable; share from the miner details later.",
            ),
          );
      }
    }
  }
  // A returned transaction hash is recovery evidence, never permission to send
  // again. Poll the read-only journal until its canonical receipt is final.
  useEffect(() => {
    const hash = pending?.hash || pending?.recoveryHashes?.at(-1);
    if (!hash || !account || !config) return;
    const owner = account, context = walletEpoch.current, started = Date.now();
    let cancelled = false, timer;
    const poll = async () => {
      if (cancelled || context !== walletEpoch.current) return;
      if (submissionLock.current || busy) {
        timer = setTimeout(poll, 3000);
        return;
      }
      try {
        const result = await recoverPending({ config, account: owner, hash });
        if (cancelled || context !== walletEpoch.current) return;
        if (result.status !== 'pending') {
          await handleResult(result, context);
          return;
        }
      } catch { /* Keep the saved hash available for manual recovery. */ }
      if (Date.now() - started < 90_000) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending?.hash, pending?.recoveryHashes?.at(-1), account, config, busy]);
  useEffect(() => {
    const job = publishingProject;
    if (!job || job.client !== client || !same(job.account, account)
      || !same(job.config.factory, config?.factory) || !same(job.config.authority, config?.authority)
      || job.config.artifactDigest !== config?.artifactDigest) return;
    let cancelled = false, timer;
    const current = () => !cancelled;
    const finish = result => {
      if (!current()) return;
      showTransactionResult(result);
      setOperatorRefresh(value => value + 1); setRefresh(value => value + 1);
    };
    const poll = async () => {
      if (cancelled) return;
      try {
        if (!job.result) {
          const status = job.initialStatus ?? await authorityActionStatus(job.config, job.account);
          if (!current()) return;
          job.initialStatus = null;
          if ((!job.hash || same(status.hash, job.hash)) && ['confirmed', 'failed'].includes(status.status)) {
            job.result = await readPublishedProject({ provider: job.client.provider, intent: job.intent,
              status, hash: job.hash || status.hash });
            if (!current()) return;
            if (job.result) finish(job.result);
          }
        }
        if (job.result?.status === 'confirmed' && !job.result.child) {
          // Read the actual registered project directly while its catalog is still catching up.
          if (job.result.projectKind === 'single') {
            const result = await readPublishedPoolDisplay(job.client, job.result, job.intent, job.account);
            if (!current()) return;
            if (current()) {
              const row = viewPool(result.item);
              publishedProjects.current = mergePublishedProjects(publishedProjects.current, [row]).slice(-20);
              setPools(previous => mergePublishedProjects(previous, [row]));
              // The direct row stays in this client session until the directory catches up.
            }
          } else {
            const result = await readPortfolioDisplayRow(job.config, job.client.provider, job.result.poolAddress, job.account);
            if (!current()) return;
            if (current()) {
              rememberPortfolioDisplay(job.config, result.item, job.account);
              publishedPortfolios.current = mergePublishedProjects(publishedPortfolios.current, [result.item]).slice(-20);
            }
          }
          if (current()) { setRefresh(value => value + 1); setOperatorRefresh(value => value + 1); }
          setPublishingProject(null); return;
        }
        if (job.result) { setPublishingProject(null); return; }
      } catch (problem) {
        // A temporary display/status outage never turns a submitted transaction into a failure.
        if (current() && job.result?.status === 'confirmed') setMessage(L('项目已发布，列表资料正在更新。', 'Project published. Its directory data is updating.'));
      }
      if (!cancelled && Date.now() - job.startedAt < 120_000) timer = setTimeout(poll, 3000);
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [publishingProject, client, config?.factory, config?.authority, config?.artifactDigest, account]);
  async function submitFreshAuthority(kind, args, current, creationTransaction) {
    let enteredRelay = false;
    try {
    if (config?.stage !== 'fresh-active' || !isOperator || !wallet || !account || !operatorServiceReady)
      throw new Error('当前钱包没有新合约管理员权限。');
    await requireCurrentProductStage(config);
    const previous = await authorityActionStatus(config, account);
    if (previous?.status && !['idle', 'confirmed', 'failed'].includes(previous.status))
      throw new Error('已有管理员代付交易待确认；先核对状态，不能重复发送。');
    if (!current()) throw new Error('页面或钱包已改变，请重新预览。');
    const command = await signAuthorityAction({ provider: wallet, config, account, kind, args });
    const creation = creationTransaction ? publishedProjectIntent(config, creationTransaction, { account, command }) : null;
    if (!current()) throw new Error('签名期间页面或钱包已改变；请先核对管理员代付状态。');
    // A network error after submission is ambiguous. The relay journal is the
    // source of truth; never resend the same signed command automatically.
    let result;
    try { enteredRelay = true; result = await submitAuthorityAction(config, account, command); }
    catch (problem) {
      const status = await authorityActionStatus(config, account).catch(() => null);
      if (status?.status && status.status !== 'idle') result = status;
      else throw problem;
    }
    if (current()) {
      if (creation) setPublishingProject({ intent: creation, hash: result.hash ?? null,
        initialStatus: result, account, config, client, startedAt: Date.now() });
      if (creation && !['confirmed', 'failed'].includes(result.status)) showTransactionResult(result, { creationPending: true });
      setMessage(result.hash ? `Gas 钱包交易已提交：${result.hash}。请等待链上确认。`
        : '管理员签名已提交，请在运营工作台核对代付状态。');
      setOperatorRefresh(value => value + 1);
      setRefresh(value => value + 1);
    }
    return result;
    } catch (problem) {
      if (!enteredRelay) throw Object.assign(new Error(textError(problem), { cause: problem }), { beforeWalletSubmission: true });
      throw problem;
    }
  }
  async function sendFreshAuthority(kind, args) {
    if (busy || submissionLock.current || !isOperator || !wallet || !account)
      throw new Error('管理员权限或交易状态已变化，请重新读取。');
    const ticket = {}, revision = walletEpoch.current, page = routeIdentity.current;
    submissionLock.current = ticket; setBusy(true); setError('');
    const current = () => revision === walletEpoch.current && page === routeIdentity.current;
    try {
      await connectJournal({ inspect: false });
      return await submitFreshAuthority(kind, args, current);
    } catch (problem) {
      if (current()) showTransactionResult(problem, { source: 'wallet', action: kind });
      throw problem;
    } finally {
      if (submissionLock.current === ticket) submissionLock.current = null;
      setBusy(false);
    }
  }
  async function sendPortfolio(confirmed, input) {
    if (busy || submissionLock.current || !wallet || !account) throw new Error('请等待当前操作完成。');
    const ticket = {}, revision = walletEpoch.current, page = routeIdentity.current;
    submissionLock.current = ticket; setBusy(true); setError('');
    const current = () => revision === walletEpoch.current && page === routeIdentity.current;
    try {
      const member = directMemberTransaction(config, confirmed.transaction, confirmed.action);
      if (!member) await connectJournal({ inspect: false, onState: showTransactionProgress });
      if (!current()) throw new Error('页面或钱包已改变，请重新预览。');
      const checked = config.displayOnly ? confirmed
        : await preparePortfolioAction({ ...input, config, provider: wallet, account });
      if (!current() || !sameUnsignedIntent(confirmed.transaction, checked.transaction)) throw new Error('交易内容已改变，请重新预览。');
      if (config?.stage === 'fresh-active' && checked.action.kind === 'createPortfolio')
        return await submitFreshAuthority('executeApprovedOperation', approvedOperatorCall(config, checked.transaction), current, checked.transaction);
      if (config?.stage === 'fresh-active' && ['buyOfficial', 'buyFirsto'].includes(checked.action.kind)) {
        const command = approvedPortfolioPurchase(config, checked);
        return await submitFreshAuthority(command.kind, command.args, current);
      }
      const result = await (member ? sendMemberWalletTransaction : sendProductTransaction)({ provider: wallet, config, transaction: checked.transaction,
        action: checked.action, onState: state => { if (current()) showTransactionProgress(state); } });
      if (revision === walletEpoch.current) await handleResult(result, revision);
      return result;
    } catch (problem) {
      if (revision === walletEpoch.current) showTransactionResult(problem, { source: 'wallet', action: confirmed.action?.kind,
        creationFailure: confirmed.action?.kind === 'createPortfolio' && problem.beforeWalletSubmission === true });
      throw problem;
    } finally {
      if (submissionLock.current === ticket) submissionLock.current = null;
      setBusy(false); setTransactionStage(null);
    }
  }
  async function sendBudgetQueueStep(confirmed, input) {
    if (busy || submissionLock.current || !wallet || !account || pending) throw Object.assign(new Error(L('请先完成或核对当前操作。', 'Complete or verify the current operation first.')), { beforeWalletSubmission: true });
    if (!budgetPurchaseQueueSupported(config)) throw Object.assign(new Error(L('当前合约阶段不支持连续采购队列。', 'The current contract stage does not support this purchase queue.')), { beforeWalletSubmission: true });
    const ticket = {}, revision = walletEpoch.current, page = routeIdentity.current;
    let enteredSender = false;
    submissionLock.current = ticket; setBusy(true); setError('');
    const current = () => revision === walletEpoch.current && page === routeIdentity.current;
    try {
      await connectJournal({ inspect: false, onState: state => { if (current()) showTransactionProgress(state); } });
      if (!current()) throw new Error(L('页面或钱包已改变，请重新预览。', 'Page or wallet changed. Preview again.'));
      const checked = config.displayOnly ? confirmed
        : await prepareBudgetQueueStep({ ...input, config, provider: wallet, account });
      if (!current() || !budgetQueuePreviewMatches(confirmed, checked)) throw new Error(L('采购内容已改变，请重新预览。', 'Purchase details changed. Preview again.'));
      enteredSender = true;
      if (config.stage === 'fresh-active') {
        if (!checked.authority) throw Object.assign(new Error('缺少逐笔管理员采购意图。'), { beforeWalletSubmission: true });
        const relay = await submitFreshAuthority(checked.authority.kind, checked.authority.args, current);
        if (!relay.hash) return { status: 'pending', message: '签名已提交；先核对代付状态，不能重复发送。' };
        return await recoverAuthorityQueueStep({ config, provider: client?.provider ?? createReadOnlyHttpProvider(config), plan: beginBudgetQueueStep(input.plan, checked),
          index: input.index, hash: relay.hash });
      }
      const result = await sendProductTransaction({ provider: wallet, config, transaction: checked.transaction,
        action: checked.action, onState: state => { if (current()) showTransactionProgress(state); } });
      if (revision === walletEpoch.current) await handleResult(result, revision);
      return result;
    } catch (problem) {
      // This proof is local to this call; never infer it from a timeout or empty journal.
      if (current()) showTransactionResult(problem, { source: 'wallet', action: confirmed.action?.kind });
      if (!enteredSender || problem?.beforeIntent === true || problem?.beforeWalletSubmission === true)
        throw Object.assign(new Error(textError(problem)), { beforeWalletSubmission: true });
      throw problem;
    } finally {
      if (submissionLock.current === ticket) submissionLock.current = null;
      setBusy(false); setTransactionStage(null);
    }
  }
  async function connectBudgetQueue() {
    if (busy || submissionLock.current || !wallet || !account) throw new Error('请先完成当前钱包操作。');
    const ticket = {}, revision = walletEpoch.current, page = routeIdentity.current;
    submissionLock.current = ticket; setBusy(true);
    try {
      await connectJournal({ inspect: false });
      if (revision !== walletEpoch.current || page !== routeIdentity.current) throw new Error('页面或钱包已改变，请重新读取采购记录。');
    } finally {
      if (submissionLock.current === ticket) { submissionLock.current = null; setBusy(false); }
    }
  }
  async function submit() {
    if (busy || submissionLock.current || !prepared || prepared.forModal !== modal) return;
    const ticket = {};
    submissionLock.current = ticket;
    setBusy(true);
    setError("");
    const requestEpoch = walletEpoch.current,
      owner = account, target = modal, revision = epoch.current, confirmed = prepared;
    const current = () => requestEpoch === walletEpoch.current && revision === epoch.current && activeModal.current === target;
    const progress = state => { if (current()) showTransactionProgress(state); };
    let member = false;
    try {
      member = directMemberTransaction(config, confirmed.transaction, { kind: confirmed.kind });
      if (!member) {
        progress('authenticating');
        await connectJournal({ inspect: false, onState: progress });
      }
      if (!current()) throw new Error(L("页面或钱包已改变，请重新预览。", "Page or wallet changed. Preview again."));
      // Member calls hand the exact preview to the wallet immediately; the
      // journal remains only for operations that actually require that service.
      const result = await (member ? sendMemberWalletTransaction : sendProductTransaction)({
        provider: wallet,
        config,
        transaction: confirmed.transaction,
        action: { kind: confirmed.kind },
        onState: progress,
      });
      if (requestEpoch === walletEpoch.current)
        await handleResult(result, requestEpoch);
    } catch (e) {
      if (requestEpoch === walletEpoch.current) {
        setError(textError(e));
        showTransactionResult(e, { source: 'wallet', action: target.kind });
      }
      if (!member) try {
        const state = await readPending({ account: owner, config });
        if (requestEpoch === walletEpoch.current) setPending(state.record ? { ...state.record,
          canAbandon: state.canAbandon === true, canRequestLegacyEnvelope: state.canRequestLegacyEnvelope === true } : null);
      } catch {}
    } finally {
      if (submissionLock.current === ticket) {
        submissionLock.current = null;
        setTransactionStage(null);
        setBusy(false);
      }
    }
  }
  async function sendGovernanceAction(pool, action) {
    const requestEpoch = walletEpoch.current, revision = epoch.current;
    if (busy || submissionLock.current || pending) throw new Error(L("请先核对当前交易。", "Resolve the current transaction first."));
    const ticket = {};
    submissionLock.current = ticket;
    setBusy(true); setError("");
    try {
      if (!config.displayOnly) {
        showTransactionProgress('authenticating');
        await connectJournal({ inspect: false, onState: state => { if (requestEpoch === walletEpoch.current) showTransactionProgress(state); } });
      }
      if (requestEpoch !== walletEpoch.current || revision !== epoch.current)
        throw new Error(L("页面或钱包已改变，请重新预览。", "Page or wallet changed. Preview again."));
      showTransactionProgress('rechecking');
      const checked = await prepareProductAction({ provider: wallet, config, account, pool, ...action });
      if (requestEpoch !== walletEpoch.current || revision !== epoch.current)
        throw new Error(L("页面或钱包已改变，请重新预览。", "Page or wallet changed. Preview again."));
      const member = directMemberTransaction(config, checked.transaction, { kind: checked.kind });
      const result = await (member ? sendMemberWalletTransaction : sendProductTransaction)({ provider: wallet, config,
        transaction: checked.transaction, action: { kind: checked.kind },
        onState: state => { if (requestEpoch === walletEpoch.current) showTransactionProgress(state); } });
      await handleResult(result, requestEpoch);
      return result;
    } catch (problem) {
      if (requestEpoch === walletEpoch.current) showTransactionResult(problem, { source: 'wallet', action: action.kind });
      throw problem;
    } finally { if (submissionLock.current === ticket) { submissionLock.current = null; setBusy(false); setTransactionStage(null); } }
  }
  async function sendAdminAction(preview) {
    const requestEpoch = walletEpoch.current, revision = epoch.current;
    if (busy || submissionLock.current || pending || !isOperator || !operatorServiceReady) throw new Error(L("运营权限或交易状态已变化，请重新读取。", "Operator permissions or transaction state changed."));
    const ticket = {};
    submissionLock.current = ticket;
    setBusy(true); setError("");
    const current = () => requestEpoch === walletEpoch.current && revision === epoch.current;
    try {
      showTransactionProgress('authenticating');
      await connectJournal({ inspect: false, onState: state => { if (current()) showTransactionProgress(state); } });
      if (!current()) throw new Error(L("页面或钱包已改变，请重新预览。", "Page or wallet changed. Preview again."));
      showTransactionProgress('rechecking');
      const checked = config.displayOnly ? preview : await boundedReadPreview(({ provider }) => prepareAdminAction({ provider, config, account, ...preview.input }),
        { provider: config?.productFamily === 'fresh-v4' ? client?.provider : wallet, isCurrent: current });
      if (!current() || !sameUnsignedIntent(preview.transaction, checked.transaction)
        || !sameAdminPurchasePreview(preview, checked))
        throw new Error(L("运营操作参数已变化，请重新预览。", "Operation changed. Preview again."));
      if (config?.stage === 'fresh-active') {
        if (!['createPool', 'createFlexiblePoolChecked', 'createBudgetChildPool'].includes(checked.kind)
          && !(checked.kind === 'mine' && checked.miningAction === 'reclaim'))
          throw new Error('单机采购与挖矿准备、启动由独立服务执行；此处只接受精确建池或回收签名。');
        return await submitFreshAuthority('executeApprovedOperation', approvedOperatorCall(config, checked.transaction,
          { pool: checked.kind === 'mine' ? checked.pool : undefined }), current, checked.kind === 'mine' ? null : checked.transaction);
      }
      const result = await sendProductTransaction({ provider: wallet, config,
        transaction: checked.transaction, action: { kind: checked.kind },
        onState: state => { if (current()) showTransactionProgress(state); } });
      await handleResult(result, requestEpoch);
      return result;
    } catch (problem) {
      if (current() && showTransactionResult(problem, { source: 'wallet', action: preview.kind,
        creationFailure: preview.kind?.startsWith('create') && problem.beforeWalletSubmission === true })) problem.resultPresented = true;
      throw problem;
    } finally { if (submissionLock.current === ticket) { submissionLock.current = null; setBusy(false); setTransactionStage(null); } }
  }
  async function recover() {
    const context = walletEpoch.current;
    setBusy(true);
    setError("");
    try {
      await connectJournal();
      const result = await recoverPending({
        provider: wallet,
        config,
        account,
        hash: recoveryHash.trim() || undefined,
      });
      if (context === walletEpoch.current) await handleResult(result, context);
    } catch (e) {
      if (context === walletEpoch.current) setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function clearUnsent() {
    if (busy || pending?.canAbandon !== true) return;
    const context = walletEpoch.current; setBusy(true); setError('');
    try {
      const result = await abandonPrepared({ account, config });
      if (context === walletEpoch.current) {
        await handleResult(result, context);
        setMessage(L('未签名的准备记录已清除，可重新预览。', 'Unsigned preparation cleared. You can preview again.'));
      }
    } catch (problem) { if (context === walletEpoch.current) setError(textError(problem)); }
    finally { if (context === walletEpoch.current) setBusy(false); }
  }
  async function cancelPending() {
    const context = walletEpoch.current;
    setBusy(true);
    setError("");
    try {
      await connectJournal();
      const result = await cancelPendingNonce({
        provider: wallet,
        config,
        account,
        onState: () => {
          if (context === walletEpoch.current)
            setMessage(
              L(
                "请在钱包核对取消交易及 Gas 费用。",
                "Review the cancellation and gas fee in your wallet.",
              ),
            );
        },
      });
      if (context === walletEpoch.current) await handleResult(result, context);
    } catch (e) {
      if (context === walletEpoch.current) setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function retryLegacyPending() {
    if (busy || !pending?.legacyEnvelopeRejected || !pending?.canRequestLegacyEnvelope
      || !same(pending.account, account)) return;
    const context = walletEpoch.current;
    setBusy(true); setError('');
    try {
      const result = await retryLegacyEnvelope({ provider: wallet, config, account,
        onState: state => { if (context === walletEpoch.current) showTransactionProgress(state); } });
      if (context === walletEpoch.current) await handleResult(result, context);
    } catch (problem) {
      if (context === walletEpoch.current) {
        setError(textError(problem));
        try {
          const view = await readPending({ account, config });
          if (context === walletEpoch.current) setPending(view.record ? { ...view.record,
            canAbandon: view.canAbandon === true,
            canRequestLegacyEnvelope: view.canRequestLegacyEnvelope === true } : null);
        } catch { /* Keep the last durable intent visible if the journal is unavailable. */ }
      }
    } finally {
      if (context === walletEpoch.current) { setBusy(false); setTransactionStage(null); }
    }
  }
  async function more(kind) {
    if (!client || busy || (kind === 'activity' && (activityReadLoading || !!activityReadError))) return false;
    const revision = epoch.current;
    const positionsRevision = positionsReadEpoch.current;
    const ordersRevision = marketOrdersEpoch.current;
    const activityRevision = activityReadEpoch.current;
    setBusy(true);
    setError("");
    try {
      if (kind === "pools") {
        const result = await (client.readDisplayPools ?? client.readPools)({
          account: account || ZeroAddress,
          cursor: poolCursor,
          source,
        });
        if (revision !== epoch.current) return false;
        setPools((old) => [...old, ...result.items.map(viewPool)]);
        setPoolCursor(result.nextCursor);
      } else if (kind === "positions") {
        const result = await (client.readDisplayPositions ?? client.readPositions)({
          account,
          cursor: positionCursor,
          source: positionsReadSource,
        });
        if (revision !== epoch.current || positionsRevision !== positionsReadEpoch.current) return false;
        setPositions((old) => [...old, ...result.items.map(viewPool)]);
        setPositionCursor(result.nextCursor);
      } else if (kind === "orders") {
        const result = await (client.readDisplayOrders ?? client.readOrders)({
          ...(marketTab === "mine" ? { seller: account } : { active: true }),
          cursor: orderCursor,
          source: marketOrderSource,
        });
        if (revision !== epoch.current || ordersRevision !== marketOrdersEpoch.current) return false;
        setOrders((old) => [...old, ...result.items]);
        setOrderCursor(result.nextCursor);
      } else {
        const result = await client.readActivity({
          pool: route.route === "detail" ? route.pool : undefined,
          account: ["overview", "rewards"].includes(route.route)
            ? account
            : undefined,
          cursor: activityCursor,
          // Public history uses a descending block/transaction/log cursor.
          // A newer verified index does not invalidate that historical boundary.
          source: route.route === 'records' ? undefined : activityReadSource,
        });
        if (revision !== epoch.current || activityRevision !== activityReadEpoch.current) return false;
        const appended = appendActivityPage({ items: activity, nextCursor: activityCursor,
          source: activityReadSource, ...activityTotals }, result);
        setActivity(appended.items);
        setActivityCursor(appended.nextCursor);
        setActivityTotals({ totalCount: appended.totalCount, overviewTotalCount: appended.overviewTotalCount });
        if (route.route === 'records') {
          setActivityReadSource(appended.source);
          setSource(appended.source);
        }
      }
      return true;
    } catch (e) {
      if (revision === epoch.current && (kind !== 'activity' || activityRevision === activityReadEpoch.current)) {
        invalidateDisplayOnReorg(client, e); setError(textError(e));
      }
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function readMembers() {
    if (!client || !detail || !config) return;
    const revision = epoch.current;
    setMembersRead({ status: "loading" });
    try {
      const result = await readCachedSection(`pool-members:${detail.pool.toLowerCase()}`, () => readCurrentPoolMembers(client.provider, {
        factory: config.factory, pool: detail.pool, displayOnly: config.displayOnly,
      }));
      if (revision === epoch.current) {
        setMembers(result.members);
        setMembersRead({ status: "ready", blockNumber: result.blockNumber });
      }
    } catch (e) {
      if (revision === epoch.current) {
        setMembers([]);
        setMembersRead({ status: "error", error: textError(e) });
      }
    }
  }
  useEffect(() => {
    if (route.route === 'detail' && detailTab === 'members' && detail?.pool && client && !loading)
      void readMembers();
  }, [client, route.route, detail?.pool, detailTab, source?.indexedThrough, loading, refresh]);
  const heading = (title, subtitle, action) => (
    <div className="page-heading">
      <div>
        <div className="eyebrow">BEMine / {route.route.toUpperCase()}</div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
  const refreshButton = (
    <div className="live-actions">
    {(boot.status === 'loading' || loading || revalidating || readRetry) &&
      <small role="status" data-read-status="updating">{L('更新中…', 'Updating…')}</small>}
    <Button
      secondary
      onClick={() => {
        if (boot.status !== 'ready') { setBootAttempt(v => v + 1); return; }
        const page = JSON.stringify([route.route, route.pool?.toLowerCase() || '', account?.toLowerCase() || '']);
        lastPageRefresh.current.set(page, Date.now());
        setRefresh(v => v + 1);
        if (boot.displayOnly) return;
        // Refresh page data immediately; only rebootstrap the page if the
        // independently verified contract stage actually changed.
        const refreshIdentity = { wallet: connectedWallet.current, revision: walletEpoch.current, route: routeIdentity.current };
        const current = () => refreshIdentity.wallet === connectedWallet.current && refreshIdentity.revision === walletEpoch.current
          && refreshIdentity.route === routeIdentity.current && !activeModal.current && !submissionLock.current;
        void fetchLiveJson(boot.productGraphUrl, { maxBytes: 65536 })
          .then(graph => validateCurrentProductGraph(graph, boot))
          .then(graph => {
            if (!current()) return;
            if (graph.stage !== boot.stage || graph.artifactDigest !== boot.artifactDigest
              || graph.stageActivationBlock !== boot.stageActivationBlock
              || graph.stageActivationHash !== boot.stageActivationHash
              || graph.operationId !== boot.operationId
              || !same(graph.manifest?.factory, boot.manifest?.factory)
              || !same(graph.manifest?.shareMarket, boot.manifest?.shareMarket)
              || (graph.manifest?.portfolioFactory ?? '').toLowerCase()
                !== (boot.manifest?.portfolioFactory ?? '').toLowerCase()
              || graph.readMode === 'current' && (graph.operationalReady !== boot.operationalReady
                || graph.transactionReady !== boot.transactionReady || graph.userExitReady !== boot.userExitReady
                || boot.readMode !== 'current')) setBootAttempt(v => v + 1);
          })
          .catch(error => { if (current()) setError(textError(error)); });
      }}
      disabled={loading || busy || !!modal || !!pending || boot.status === "loading"}
    >
      <RefreshCw size={16} />
      {L("刷新", "Refresh")}
    </Button></div>
  );
  const claimable = positionsLoaded
      ? sumKnown(positions, "claimableBEM")
      : null,
    poolBnb = positionsLoaded ? sumKnown(positions, "bnbOwed") : null;
  const currentPoolQuote = p => {
    const quote = p && poolCapacity[p.pool.toLowerCase()];
    return quote?.available && quote.validUntil > capacityNow
      && quote.collection.toLowerCase() === p.params?.circuits?.toLowerCase()
      && quote.tokenId === p.params?.circuitId?.toString() ? quote : null;
  };
  const currentPoolMetadata = p => {
    const quote = p && poolCapacity[p.pool.toLowerCase()];
    return quote?.metadataAvailable && quote.validUntil > capacityNow
      && quote.collection?.toLowerCase() === p.params?.circuits?.toLowerCase()
      && quote.tokenId === p.params?.circuitId?.toString() ? quote : null;
  };
  const currentPoolCapacityPrice = p => {
    const salePrice = p?.status === 'Listed' && same(governanceProof?.pool, p.pool)
      && same(governanceProof?.account, account || ZeroAddress) ? governance?.salePrice : null;
    return poolDailyCapacityPriceWei(salePrice != null ? { ...p, salePrice } : p, currentPoolQuote(p));
  };
  const poolQuotePlaceholder = p => !["pools", "detail"].includes(route.route) ? "—" : poolCapacity[p.pool.toLowerCase()]?.loading
    ? L("读取中…", "Loading…")
    : <button className="text-button" onClick={() => setPoolQuoteRevision(value => value + 1)}>
      {L("重新读取", "Retry")}
    </button>;
  const shareProject = (p) => ({
    poolAddress: p.pool,
    name: p.name,
    circuitId: p.tokenId,
    state: p.status,
    remainingShares: p.remaining,
  });
  const moreButton = (cursor, kind) =>
    cursor !== null && cursor !== undefined ? (
      <div className="live-more">
        <Button secondary disabled={busy || (kind === 'pools' && loading) || (
          kind === 'positions' ? positionsReadLoading || !!positionsReadError
            : kind === 'orders' ? marketOrdersLoading || !!marketOrdersError
              : kind === 'activity' && route.route !== 'detail' ? activityReadLoading || !!activityReadError : false)} onClick={() => more(kind)}>
          {L("加载更多", "Load more")}
        </Button>
      </div>
    ) : null;
  const poolTable = (rows, holdings = false, hideStatus = false, directory = null, category = null) => {
    const catalog = route.route === "pools" && !holdings;
    const group = category ?? filter;
    const columns = !catalog ? ["miner", ...(hideStatus ? [] : ["status"]), "shares", "unit", "daily", "capacity", "actions"]
      : group === "Funding" ? ["miner", "shares", "unit", "hash", "daily", "capacity", "actions"]
        : group === "Active" ? ["miner", "shares", "unit", "members", "daily", "capacity", "actions"]
          : group === "Listed" ? ["miner", "status", "shares", "unit", "hash", "daily", "capacity", "actions"]
            : ["miner", "status", "shares", "unit", "daily", "capacity", "actions"];
    const titles = {
      miner: L("矿机 / 项目", "Miner / pool"), status: L("状态", "Status"),
      shares: holdings ? L("我的份额", "My shares") : L("已募集", "Funded"),
      unit: L("每份金额", "Price per share"), hash: L("算力 H", "Hash power H"),
      members: L("参与人数", "Participants"),
      daily: holdings ? L("可领取 BEM", "Claimable BEM") : L("预计日产 BEM", "Estimated BEM / day"),
      capacity: holdings ? L("待领取 BNB", "Claimable BNB") : L("日产能价", "Daily capacity price"), actions: "",
    };
    return <div className={`table-wrap${catalog ? " live-catalog-table" : ""}`}>
      <table>
        <thead><tr>{columns.map(column => <th key={column}>{titles[column]}</th>)}</tr></thead>
        <tbody>{rows.map(p => {
          const metadata = currentPoolMetadata(p), quote = currentPoolQuote(p);
          const cells = {
            miner: <button className="asset-cell" onClick={() => openDetails(p)}>
              <Chip pool={p}/><span>
                <strong>{p.kind === 'portfolio' ? L('多矿机项目', 'Multi-miner project') : `${p.name} #${p.tokenId}`}</strong>
                {p.kind !== 'portfolio' && <small>{catalog ? `Task ${metadata?.taskId ?? "—"}` : `${shortAddress(p.pool)}${metadata?.taskId != null ? ` · Task ${metadata.taskId}` : ""}`}</small>}
                {p.kind === 'portfolio' && !catalog && <small>{shortAddress(p.pool)}</small>}
                {p.kind === 'portfolio' && <small>{L(`${p.childCount} 台已购 · ${p.activeChildCount} 台运行`, `${p.childCount} purchased · ${p.activeChildCount} operating`)}</small>}
              </span>
            </button>,
            status: <StateBadge state={p.status} L={L}/>,
            shares: <>{holdings ? (p.shares?.toString() ?? "—") : (p.funded ?? "—")} / 100</>,
            unit: <>{displayPreciseAmount(p.unitPriceWei)} BNB</>,
            hash: metadata?.hashPower ?? "—",
            members: p.members == null ? "—" : `${p.members} ${L("人", "people")}`,
            daily: holdings ? <>{amount(p.claimableBEM,8)} BEM</> : quote
              ? `${displayPreciseAmount(quote.estimated24hAtomic, 8)} BEM`
              : p.kind === 'portfolio' ? L('详情查看', 'See details') : poolQuotePlaceholder(p),
            capacity: holdings ? <>{amount(p.bnbOwed)} BNB</> : currentPoolCapacityPrice(p) != null
              ? displayPreciseAmount(currentPoolCapacityPrice(p))
              : p.kind === 'portfolio' || quote ? '—' : poolQuotePlaceholder(p),
            actions: <div className="live-pool-row-actions">
              {holdings && p.kind !== 'portfolio' && p.shares > 0n && <button className="btn secondary" disabled={!positionsActionsReady || busy || !!pending || !shareListingView(p).allowed}
                onClick={() => openAction('list', p)} aria-label={L(`挂单 ${p.name} #${p.tokenId}`, `List ${p.name} #${p.tokenId}`)}>{L('挂单出售', 'List shares')}</button>}
              {holdings && p.kind !== 'portfolio' && p.shares > 0n && !shareListingView(p).allowed && <small className="live-order-state">
                {p.status === 'Funding' || p.status === 'Funded' ? L('购机并开始挖矿后可挂牌', 'Listing opens after purchase and mining starts')
                  : p.status === 'Active' && p.availableShares === 0n ? L('份额已锁定', 'Shares are locked')
                    : L('当前状态不可挂牌', 'Listing unavailable in this state')}
              </small>}
              <button className="text-button" onClick={() => openDetails(p)}>{p.kind === 'portfolio' ? L('查看项目', 'View project') : L("查看矿机", "View miner")}<ArrowRight size={16}/></button>
            </div>,
          };
          return <tr key={p.pool} data-project-kind={p.kind === 'portfolio' ? 'portfolio' : 'single'} data-project-address={p.pool}>
            {columns.map(column => <td key={column} className={["unit", "hash", "capacity"].includes(column) ? "num" : undefined}
              title={!holdings && column === "daily" && !config?.displayOnly && quote?.cached
                ? L('此前核验的展示数据，仍在有效期内', 'Previously verified display data, still within its validity window')
                : !holdings && column === "capacity" ? !config?.displayOnly && quote?.cached
                  ? L('此前核验的本机价格 ÷ 本机预计日产出；单位：BNB / (BEM/天)', 'Previously verified miner price / its estimated daily output; unit: BNB / (BEM/day)')
                  : L('本机挂牌价（挖矿中按实际购机成本）÷ 本机预计日产出；不含募集预留金。单位：BNB / (BEM/天)', 'This miner asking price (actual acquisition cost while mining) / its estimated daily output, excluding funding reserves. Unit: BNB / (BEM/day)')
                  : undefined}>{cells[column]}</td>)}
          </tr>;
        })}</tbody>
      </table>
      {rows.length === 0 && directory && <Empty title={directory.loading
        ? L('正在读取项目…', 'Loading projects…')
        : directory.failed || !directory.ready ? L('部分项目暂不可用，请刷新重试', 'Some projects are unavailable. Please refresh.')
          : directory.total === 0 ? holdings ? L('暂无持仓和待领取权益', 'No positions or outstanding entitlements') : L('尚未创建拼矿项目', 'No projects have been created yet')
            : L('暂无匹配项目', 'No matching projects')}>
        {!directory.loading && directory.ready && !directory.failed && directory.total === 0 && <>
          {holdings ? <Button secondary onClick={()=>go('pools')}>{L('浏览拼矿项目','Browse projects')}</Button> : <>
            {L('运营方创建项目后，将在这里开放认购。', 'Subscriptions will appear here once the operator creates a project.')}
            {hasOperatorAccess && <Button secondary disabled={busy} onClick={()=>go('operator')}>{L('创建首个项目','Create the first project')}</Button>}
          </>}
        </>}
      </Empty>}
      {rows.length === 0 && !directory && (
        <Empty
          title={
            (holdings ? positionsReadLoading : loading || boot.status === 'loading')
              ? L("正在读取项目，请稍候…", "Loading projects…")
              : holdings && positionsReadError
                ? L("份额读取失败，请刷新重试", "Could not read shares. Please refresh.")
              : !(holdings ? positionsReadSource : source) ? L("项目数据暂不可用", "Project data is unavailable")
                : !holdings && pools.length === 0 ? L("尚未创建拼矿项目", "No pools have been created yet")
                  : holdings ? L("暂无持仓和待领取权益", "No positions or outstanding entitlements")
                    : route.route === 'market' && marketTab === 'whole'
                      ? L('暂无整机在售；募集中和挖矿中的项目不在此列', 'No whole miners for sale; funding and operating pools are not listed here')
                      : L("暂无匹配项目", "No matching pools")
          }
        >
          {!loading && source && !holdings && pools.length === 0 && <>
            {L("运营方创建项目后，将在这里开放认购。", "Subscriptions will appear here once the operator creates a pool.")}
            {hasOperatorAccess && <Button secondary disabled={busy} onClick={() => go('operator')}>{L('创建首个项目', 'Create the first pool')}</Button>}
          </>}
        </Empty>
      )}
    </div>;
  };
  const renderProjectDirectory = page => {
    const directory = projectDirectory(mergePublishedProjects(pools, publishedProjects.current),
      mergePublishedProjects(page.rows, publishedPortfolios.current), { filter, query, sort,
      capacityFor: row => currentPoolCapacityPrice(row) });
    const updating = loading || busy || page.loading || boot.status === 'loading' || page.enabled && !page.loaded && !page.failed;
    const failed = readFailed || page.failed || !page.enabled && boot.status !== 'loading';
    const ready = !!source && page.loaded && !!page.source;
    const canLoadMore = poolCursor != null || page.cursor != null;
    return <>
      {heading(L('参与拼矿', 'Join a pool'), L('从一份开始，共持 BEM 矿机。', 'Start with one share. Own BEM miners together.'), refreshButton)}
      <div className="live-project-summary">
        {['Funding', 'Active', 'Listed'].map(status => <button key={status}
          className={filter === status ? 'selected' : ''} onClick={()=>setFilter(status)}>
          <span>{L(...statuses[status])}</span>
          <strong>{ready && !updating && !failed && directory.all.every(row=>row.status!=='Unknown') ? directory.counts[status] : '—'}</strong>
          <small>{L('已加载项目', 'loaded projects')}</small>
        </button>)}
      </div>
      <section className="panel live-pool-directory" data-project-directory="unified" aria-busy={!!updating}>
        <div className="live-toolbar">
          <div className="tabs">{[['Funding','募集中','Funding'],['Active','挖矿中','Operating'],['Listed','整机出售中','For sale'],['all','项目总览','Overview']].map(([id,zh,en])=>
            <button key={id} className={filter===id?'selected':''} onClick={()=>setFilter(id)}>{L(zh,en)}</button>)}</div>
          <div className="live-search"><Search size={17}/><input aria-label={L('搜索矿机或地址','Search miner or address')}
            placeholder={L('矿机编号 / 项目地址','Miner ID / project address')} value={query} onChange={event=>setQuery(event.target.value)}/></div>
          <PoolSortMenu value={sort} onChange={setSort} locale={locale}/>
        </div>
        {page.error && <div className="portfolio-error" role="alert">
          <p>{L('部分项目读取失败，已读取的项目仍可查看。', 'Some projects could not be loaded; available projects remain visible.')}</p>
          <button className="btn secondary" disabled={page.loading || page.busy || busy || !!pending} onClick={()=>void page.load()}>{L('重新读取','Retry')}</button>
        </div>}
        {updating && directory.all.length>0 && <p className="subtle-note" role="status">{L('正在更新项目…','Updating projects…')}</p>}
        {!config?.displayOnly && !updating && (source?.stale || page.source?.stale) && <p className="subtle-note">{L('项目资料待更新，参与前会重新核对。','Project information is being refreshed and is rechecked before participation.')}</p>}
        {filter === 'all' ? <div className="live-directory-groups">
          {[['Funding','募集中','Funding'],['Active','挖矿中','Operating'],['Listed','整机出售中','For sale']].map(([id,zh,en]) => {
            const rows = directory.rows.filter(row => projectMatchesStatus(row,id));
            return <section key={id} className="live-directory-group" data-project-category={id}>
              <h2>{L(zh,en)} <small>{rows.length}</small></h2>
              {poolTable(rows, false, false, {loading:updating, failed, ready, total:directory.all.length},id)}
            </section>;
          })}
          {directory.rows.some(row => !['Funding','Funded','Active','Listed'].includes(row.status)) && <section className="live-directory-group" data-project-category="other">
            <h2>{L('其他项目','Other projects')}</h2>
            {poolTable(directory.rows.filter(row => !['Funding','Funded','Active','Listed'].includes(row.status)),false,false,null,'other')}
          </section>}
        </div> : poolTable(directory.rows, false, filter === 'Funding', {loading:updating, failed, ready, total:directory.all.length})}
        {canLoadMore && <div className="live-more"><Button secondary disabled={updating || failed || busy || !!pending}
          onClick={()=>void Promise.allSettled([poolCursor!=null?more('pools'):Promise.resolve(),page.cursor!=null?page.load(page.cursor):Promise.resolve()])}>
          {L('加载更多','Load more')}</Button></div>}
      </section>
    </>;
  };
  const renderAssetOverview = page => {
    if (!account) return null;
    const view = assetOverview({singlePositions:positions,portfolioRows:page.rows,
      singleLoaded:positionsLoaded && same(positionsAccount,account),portfolioLoaded:page.loaded,
      singleCursor:positionCursor,portfolioCursor:page.cursor,singleError:!!positionsReadError,portfolioError:page.failed || !page.enabled});
    const totals = view.complete ? view.totals : view.loadedTotals;
    const partial = view.partial;
    const historical = !config?.displayOnly && (positionsReadSource?.stale || page.source?.stale || boot.rechecking || walletChecking);
    const updating = positionsReadLoading || page.loading;
    const more = positionCursor != null || page.cursor != null;
    return <>
      {heading(L('资产总览','My portfolio'),L('查看单矿机与多矿机项目的持仓、已入账收益和待领取款项。','Single-miner and multi-miner positions, booked rewards and claimable proceeds.'),refreshButton)}
      <div className="metrics" data-asset-summary="unified">
        <Metric primary title={historical?L('上次核验可领取','Previously verified BEM'):partial?L('已加载可领取','Loaded claimable BEM'):L('当前可领取','Claimable BEM')}
          value={amount(totals.claimableBem,8)} unit="BEM"/>
        <Metric title={historical?L('我的历史待领取 BNB','My previous claimable BNB'):partial?L('我的已加载待领取 BNB','My loaded claimable BNB'):L('我的待领取 BNB','My claimable BNB')}
          value={amount(totals.bnbOwed)} unit="BNB"/>
        <Metric title={partial?L('已加载持有项目','Loaded projects held'):L('持有项目','Projects held')}
          value={totals.projectsHeld?.toString()??'—'} unit={L('个','projects')}/>
        <Metric title={partial?L('已加载持有份额','Loaded shares held'):L('持有份额','Shares held')}
          value={totals.shares?.toString()??'—'} unit={L('份','shares')}/>
      </div>
      <section className="panel holdings" data-asset-directory="unified" aria-busy={updating}>
        <div className="section-head"><div><h2>{L('我的矿机与项目权益','My miners and project entitlements')}</h2>
          <p>{L('单矿机和多矿机项目统一显示；包含清仓后仍待领取的权益。','Single and multi-miner projects together, including former positions with claimable balances.')}</p></div></div>
        {page.error&&<div className="portfolio-error" role="alert"><p>{L('部分项目读取失败，已读取持仓仍可查看。','Some projects could not be loaded; available positions remain visible.')}</p>
          <button className="btn secondary" disabled={updating||busy||!!pending} onClick={()=>void page.load()}>{L('重新读取','Retry')}</button></div>}
        {updating&&view.rows.length>0&&<p className="subtle-note" role="status">{L('正在更新持仓…','Updating positions…')}</p>}
        {partial&&view.loaded&&<p className="subtle-note">{L('当前汇总仅包含已加载持仓。','The summary includes only loaded positions.')}</p>}
        {poolTable(view.rows,true,false,{loading:updating,failed:!!positionsReadError||page.failed,ready:view.loaded,total:view.rows.length})}
        {more&&<div className="live-more"><Button secondary disabled={updating||busy||!!pending||page.failed||!!positionsReadError}
          onClick={()=>void Promise.allSettled([positionCursor!=null?thisMorePositions():Promise.resolve(),page.cursor!=null?page.load(page.cursor):Promise.resolve()])}>{L('加载更多','Load more')}</Button></div>}
      </section>
      <section className="panel live-section"><div className="section-head"><h2>{L('最近链上记录','Recent on-chain activity')}</h2></div>{activityTable()}</section>
    </>;
  };
  const thisMorePositions = () => more('positions');
  const activityPageView = activityPage(activity, { route: route.route, page: recordsPage, pageSize: recordsPageSize,
    ...activityTotals, hasMore: !!activityCursor });
  const recordsPageIndex = activityPageView.pageIndex;
  const hasLoadedRecordsPage = activityPageView.hasLoadedNextPage;
  async function jumpRecordsPage(page) {
    if (!Number.isSafeInteger(page) || page < 0 || busy || activityReadLoading || activityPageRequest.current) return;
    const targetPage = activityPageView.totalPages === null ? page : Math.min(page, activityPageView.totalPages - 1);
    const target = activityPage(activity, { route: route.route, page: targetPage, pageSize: recordsPageSize,
      ...activityTotals, hasMore: !!activityCursor });
    const needed = Math.min((targetPage + 1) * recordsPageSize, target.totalCount ?? Number.MAX_SAFE_INTEGER);
    if (target.loadedCount >= needed || !activityCursor) { setRecordsPage(targetPage); return; }
    if (!client || activityReadError) return;
    const ticket = {}, revision = epoch.current, readRevision = activityReadEpoch.current;
    const pageRoute = route.route, pool = pageRoute === 'detail' ? route.pool : undefined,
      owner = ['overview', 'rewards'].includes(pageRoute) ? account : undefined;
    activityPageRequest.current = ticket; setActivityReadLoading(true); setActivityReadError('');
    const current = () => activityPageRequest.current === ticket && revision === epoch.current
      && readRevision === activityReadEpoch.current;
    try {
      const result = await loadActivityPage({ items: activity, nextCursor: activityCursor, source: activityReadSource, ...activityTotals },
        { route: pageRoute, page: targetPage, pageSize: recordsPageSize, isCurrent: current,
          readPage: ({ cursor, limit, source: previous }) => client.readActivity({ pool, account: owner, cursor, limit,
            source: pageRoute === 'records' ? undefined : previous }) });
      if (!result || !current()) return;
      setActivity(result.items); setActivityCursor(result.nextCursor); setActivityReadSource(result.source);
      setActivityTotals({ totalCount: result.totalCount, overviewTotalCount: result.overviewTotalCount });
      setRecordsPage(result.pageIndex);
      if (pageRoute === 'records') setSource(result.source);
      const cacheKey = pool ? `pool-activity:${pool.toLowerCase()}` : `activity:${owner?.toLowerCase() || 'public'}`;
      let entries = readCache.current.get(client);
      if (!entries) { entries = new Map(); readCache.current.set(client, entries); }
      entries.set(cacheKey, { savedAt: Date.now(), refresh: displayRefreshKey, result });
      writeDisplaySnapshot(displayStorage(), client.manifest, cacheKey, result);
    } catch (problem) {
      if (current()) { invalidateDisplayOnReorg(client, problem); setActivityReadError(textError(problem)); }
    } finally {
      if (activityPageRequest.current === ticket) activityPageRequest.current = null;
      if (revision === epoch.current && readRevision === activityReadEpoch.current) setActivityReadLoading(false);
    }
  }
  const visibleActivity = activityPageView.visibleRows;
  const activityTable = () => (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{L("区块", "Block")}</th>
              <th>{L("操作 / 说明", "Operation / description")}</th>
              <th>{L("金额 / 费用", "Amount / fee")}</th>
              <th>{L("合约", "Contract")}</th>
              <th>{L("链上记录", "Transaction")}</th>
            </tr>
          </thead>
          <tbody>
            {visibleActivity.map((row, i) => {
              const hash = row.transactionHash ?? row.txHash;
              const contract = row.contract ?? row.address ?? row.pool;
              const contractUrl = isAddress(contract) ? explorerAddress(contract) : null;
              const entries = activityAmounts(row);
              return (
                <tr key={`${hash}-${row.logIndex ?? i}`}>
                  <td>{row.blockNumber}</td>
                  <td><ActivityOperation row={row} locale={locale} /></td>
                  <td>{entries.length ? entries.map((item, index) => {
                    const labels = { amount: ["金额", "Amount"], gross: ["成交基价", "Base price"],
                      sellerFee: ["卖方费用", "Seller fee"], buyerFee: ["买方费用", "Buyer fee"] };
                    return <span key={item.kind}>{index > 0 ? " · " : ""}{L(...labels[item.kind])}{" "}
                      {displayPreciseAmount(item.amount, item.decimals)} {item.symbol}</span>;
                  }) : "—"}</td>
                  <td>
                    {contractUrl ? <a
                      className="text-button" href={contractUrl}
                      title={contract} target="_blank" rel="noopener noreferrer">
                      {shortAddress(contract)}<ArrowUpRight size={14} />
                    </a> : "—"}
                  </td>
                  <td>
                    {explorerTransaction(hash) ? (
                      <a
                        className="text-button"
                        href={explorerTransaction(hash)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {hash.slice(0, 10)}…<ArrowUpRight size={14} />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visibleActivity.length && <Empty title={activityReadLoading
          ? L('正在读取记录…', 'Loading records…')
          : activityReadError
            ? L('记录读取失败，请刷新重试', 'Could not read records. Please refresh.')
            : L("暂无已确认记录", "No confirmed records")} />}
      </div>
      {activityReadError && <p className="live-dialog-error" role="alert">{activityReadError}</p>}
      {activityPageView.paginated ? <nav className="live-actions live-record-pagination" aria-label={L('记录分页', 'Records pagination')}>
        <Button secondary disabled={recordsPageIndex === 0 || busy || activityReadLoading}
          onClick={() => void jumpRecordsPage(recordsPageIndex - 1)}>{L('上一页', 'Previous')}</Button>
        <span aria-live="polite">{activityPageView.totalPages === null
          ? L(`第 ${recordsPageIndex + 1} 页 · 总页数读取中`, `Page ${recordsPageIndex + 1} · Total pages loading`)
          : L(`第 ${recordsPageIndex + 1} / ${activityPageView.totalPages} 页 · 共 ${activityPageView.totalCount} 条`,
            `Page ${recordsPageIndex + 1} / ${activityPageView.totalPages} · ${activityPageView.totalCount} records`)}</span>
        <Button secondary disabled={busy || activityReadLoading
          || activityPageView.totalPages !== null && recordsPageIndex + 1 >= activityPageView.totalPages
          || (!hasLoadedRecordsPage && (!client || !activityCursor || !!activityReadError))}
          onClick={() => void jumpRecordsPage(recordsPageIndex + 1)}>{L('下一页', 'Next')}</Button>
        {activityPageView.totalPages > 1 && <form className="live-record-page-jump" key={recordsPageIndex} onSubmit={event => {
          event.preventDefault(); void jumpRecordsPage(Number(event.currentTarget.elements.namedItem('page').value) - 1);
        }}>
          <label>{L('跳至', 'Go to')} <input name="page" type="number" min="1" max={activityPageView.totalPages}
            step="1" defaultValue={recordsPageIndex + 1} required disabled={busy || activityReadLoading}
            aria-label={L('页码', 'Page number')}/></label>
          <Button secondary disabled={busy || activityReadLoading}>{L('确定', 'Go')}</Button>
        </form>}
      </nav>
        : moreButton(activityCursor, "activity")}
    </>
  );
  function renderGovernance() {
    return <section className="panel"><LiveGovernance
      key={`${detail?.pool || ''}:${account || ''}`}
      selectedPool={detail?.pool} poolParams={detail?.params} capacityQuote={currentPoolQuote(detail)} config={config} account={account} wallet={wallet} refreshToken={refresh}
      readProvider={client?.provider} disabled={busy || !!pending}
      onConnect={connect} onError={problem => setError(textError(problem))}
      onSnapshot={snapshot => {
        // Reuse the child reader's successful display result for the price card.
        // It is display data, never a replacement for transaction preparation.
        if (!client || config?.displayOnly !== true || snapshot?.displayOnly !== true
          || route.route !== 'detail' || !same(snapshot.pool, route.pool)
          || !same(snapshot.account, account || ZeroAddress)
          || !same(snapshot.factory, config.factory)
          || !same(snapshot.shareMarket, config.shareMarket)
          || snapshot.stage !== config.stage
          || (snapshot.testProfile === true) !== (config.testProfile === true)) return;
        setGovernance(snapshot);
        setGovernanceProof({ pool: snapshot.pool, account: snapshot.account, source: null, displayOnly: true });
        setDetail(previous => same(previous?.pool, snapshot.pool) && previous.shares !== snapshot.shares
          ? { ...previous, shares: snapshot.shares } : previous);
        let cache = readCache.current.get(client);
        if (!cache) { cache = new Map(); readCache.current.set(client, cache); }
        cache.set(`pool-governance:${snapshot.pool.toLowerCase()}:${snapshot.account.toLowerCase()}`,
          { savedAt: Date.now(), refresh, result: { data: snapshot, source: null, displayOnly: true } });
      }}
      onAction={sendGovernanceAction} /></section>;
  }

  const pageSource = route.route === 'market' && marketTab !== 'whole' ? marketOrderSource : source;
  const pageSourceLabel = route.route === 'market' && marketTab !== 'whole'
    ? L('挂单数据更新至区块', 'Orders updated through block')
    : route.route === 'records' ? L('记录数据更新至区块', 'Records updated through block')
    : ['overview', 'rewards'].includes(route.route) || route.route === 'governance' && account
      ? L('持仓数据更新至区块', 'Holdings updated through block')
    : ['home', 'pools', 'market', 'governance'].includes(route.route) ? L('项目列表更新至区块', 'Projects updated through block')
    : L('项目数据更新至区块', 'Project updated through block');
  const detailActionReadyFor = action => currentDetailActionReady({ client, config, source, action,
    cachedPage, loading, busy, loadedRoute, routePool: route.pool, detailPool: detail?.pool,
    loadedAccount, account });
  const detailActionsReady = detailActionReadyFor();
  const positionsActionReadyFor = action => currentPositionsActionReady({ client, config,
    action:action==='marketWithdraw'?'withdrawBnb':action,targetType:action==='marketWithdraw'?'market':'pool',
    source: positionsReadSource, positionsAccount, account, wallet, positionsLoaded,
    loading: positionsReadLoading, error: positionsReadError });
  const positionsActionsReady = positionsActionReadyFor();
  const marketOrderActionReady = (order, action='fill') => currentMarketOrderActionReady({ client, config, action, targetType:'market',
    source: marketOrderSource, route: route.route, marketTab, readIdentity: marketOrderIdentity,
    account, wallet, loading: marketOrdersLoading, error: marketOrdersError, order });
  const marketOrderNeedsConnection = !wallet || !account;
  const marketOrderConnectReady = marketTab === 'shares' && !!client && config?.status === 'ready';

  return (
    <div
      className="app-shell live-platform"
      data-theme="heritage"
      data-appearance={appearance}
    >
      {menu && <div className="mobile-scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <button className="brand" onClick={() => go("home")}>
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span>
            {L("拼矿", "BEMine")}
            <small>{L("BEMine", "MINING TOGETHER")}</small>
          </span>
        </button>
        <div className="nav-caption">{L("资产工作台", "YOUR WORKSPACE")}</div>
        <nav>
          {navigation.map(([id, zh, en, Icon]) => (
            <button
              key={id}
              className={`nav-item ${route.route === id || (id === "pools" && ["detail", "portfolio"].includes(route.route)) ? "active" : ""}`}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              {L(zh, en)}
            </button>
          ))}
          {hasOperatorAccess && <button className={`nav-item ${route.route === 'operator' ? 'active' : ''}`} onClick={() => go('operator')}><ShieldCheck size={19}/>{L('运营工作台', 'Pool operations')}</button>}
        </nav>
        <div className="nav-divider" />
        <div className="nav-caption">{L("更多服务", "MORE SERVICES")}</div>
        <MoreServicesNotice label={L("敬请期待", "Coming soon")} />
        <div className="side-bottom">
          <button
            className="rules-link"
            onClick={() => setModal({ type: "rules" })}
          >
            <BookOpen size={17} />
            {L("平台规则", "Platform rules")}
            <ArrowUpRight size={14} />
          </button>
          {hasDeploymentAccess && deploymentConsoleUrl && (
            <a
              className="rules-link deployment-console-link"
              href={deploymentConsoleUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ShieldCheck size={17} />
              {L("管理员 · 合约部署", "Admin · Contract deployment")}
              <ArrowUpRight size={14} />
            </a>
          )}
          <div className="network-panel">
            <span className="network-glyph">⠿</span>
            <div>
              <strong>BNB Smart Chain</strong>
              <small>
                {boot.status === "ready"
                  ? L("链上项目", "On-chain pools")
                  : L("即将开放", "Coming soon")}
              </small>
            </div>
          </div>
          <div className="sidebar-foot">
            {L(
              "共同持有，透明参与。",
              "Shared ownership. Clear participation.",
            )}
            <span>© 2026 BEMine</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMenu(true)}
              aria-label={L("打开导航", "Open menu")}
            >
              <Menu size={22} />
            </button>
            <span>{L("工作台", "Workspace")}</span>
            <ChevronRight size={13} />
            <strong>
              {route.route === "portfolio" ? L("预算项目详情", "Budget project") : route.route === "notifications" ? L("通知中心", "Notifications") : route.route === "detail"
                ? L("矿机详情", "Miner details")
                : L(
                    ...(navigation
                      .find((x) => x[0] === route.route)
                      ?.slice(1, 3) || ["拼矿", "BEMine"]),
                  )}
            </strong>
          </div>
          <div className="top-actions">
            <a className="live-community-link" href="https://t.me/BEMineCommunity"
              target="_blank" rel="noopener noreferrer"
              aria-label={L("加入官方 Telegram 群（新窗口打开）", "Join official Telegram group (opens in a new window)")}
              title={L("加入官方 Telegram 群", "Join official Telegram group")}>
              <Send size={18} aria-hidden="true" />
              <span>{L("加入官方 Telegram 群", "Join official Telegram group")}</span>
              <ExternalLink className="live-community-external" size={14} aria-hidden="true" />
            </a>
            <button className="appearance-toggle" aria-label={L("通知中心", "Notifications")} title={L("通知中心", "Notifications")} disabled={busy} onClick={() => go("notifications")}><Bell size={17}/></button>
            <button
              className="appearance-toggle"
              aria-label={L("切换外观", "Change appearance")}
              aria-pressed={appearance === "dark"}
              onClick={() =>
                setAppearance((v) => (v === "dark" ? "light" : "dark"))
              }
            >
              {appearance === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <div className="live-language-control"><select
              className="language-switch"
              aria-label="Language"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select><ChevronDown size={14} aria-hidden="true"/></div>
            <Button
              disabled={!walletUiReady || (busy && !connectingId)}
              onClick={() =>
                connectingId ? connect() : account ? setModal({ type: "wallet" }) : connect()
              }
            >
              {account && walletInfo ? <WalletIcon wallet={walletInfo} size={19} /> : <Wallet size={17} />}
              <span className="live-wallet-label">{account
                ? shortAddress(account)
                : L("连接钱包", "Connect wallet")}</span>
              <ChevronDown size={14} />
            </Button>
          </div>
        </header>
        <main aria-busy={loading} data-ready-route={loadedRoute}>
          <Notifications key={`${config?.factory || ''}:${account || ''}:${walletRevision}`}
            account={account} wallet={wallet} config={config} locale={locale} route={route.route}
            positions={same(positionsAccount, account) ? positions : []} detail={same(loadedAccount, account) ? detail : null} claim={notificationClaim}
            blocked={busy || !!modal} onConnect={connect} onOpen={() => go('notifications')}
            isCurrent={() => connectedWallet.current === wallet && walletEpoch.current === walletRevision}/>
          {boot.status !== "ready" && boot.status !== "loading" && (
            <div className="live-notice" role="status">
              <span>{boot.status === "unconfigured"
                ? L("项目尚未开放", "Project not yet open")
                : L("数据暂不可用，请稍后重试。", "Data is unavailable. Please try again later.")}</span>
              <Button secondary disabled={busy || !!modal || !!pending} onClick={() => setBootAttempt(v => v + 1)}>
                <RefreshCw size={16}/>{L("重新加载", "Retry loading")}
              </Button>
            </div>
          )}
          {config?.stage === "fresh-active" && !config.displayOnly && !operatorServiceReady &&
            <p className="subtle-note" role="status" data-service-readiness="waiting">
              {config.stale === true
                ? L('资料更新中，操作暂不可用。', 'Updating data; actions are temporarily unavailable.')
                : L('交易服务恢复中；领取、退款和撤单仍需当前核验，由你的钱包支付 Gas。', 'Transaction services are recovering. Verified claims, refunds and cancellations use your wallet Gas.')}
              {bootRecoveryExhausted && <><span>{L(' 自动复查已暂停。', ' Automatic checks have paused.')}</span>
                <Button secondary disabled={busy || !!modal || !!pending || !!connectionLock.current}
                  onClick={() => setBootAttempt(value => value + 1)}>{L('重新核对服务', 'Recheck services')}</Button></>}
            </p>}
          {error && (
            <div className="live-notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              {readFailed && <Button secondary disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>
                {L('重新读取项目', 'Retry project data')}
              </Button>}
              <button
                aria-label={L("关闭提示", "Dismiss")}
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {positionsReadError && account && ['overview', 'rewards', 'governance', 'market'].includes(route.route) &&
            <div className="live-notice error" role="alert"><AlertCircle size={18}/><span>{positionsReadError}</span></div>}
          {statsReadError && statsReadError !== error && route.route === 'home' &&
            <div className="live-notice error" role="alert"><AlertCircle size={18}/><span>{statsReadError}</span></div>}
          {pending && (
            <section className="panel live-pending">
              <strong>
                {L("有一笔交易等待核对", "A transaction needs verification")}
              </strong>
              <p>
                {L(
                  "请先确认原交易结果，再开始下一笔操作。可填入钱包中的原始、加速或取消交易哈希。",
                  "Verify the original outcome before continuing. You can enter the original, speed-up or cancellation hash from your wallet.",
                )}
              </p>
              <input
                aria-label={L("交易哈希", "Transaction hash")}
                value={recoveryHash}
                onChange={(e) => setRecoveryHash(e.target.value)}
                placeholder="0x…"
              />
              <Button disabled={busy} onClick={recover}>
                {L("核对最终结果", "Check final outcome")}
              </Button>
              <Button
                secondary
                disabled={busy}
                onClick={() => setModal({ type: "cancel-pending" })}
              >
                {L("取消待定交易", "Cancel pending transaction")}
              </Button>
              {pending.legacyEnvelopeRejected === true && pending.canRequestLegacyEnvelope === true
                && same(pending.account, account) && <Button secondary disabled={busy} onClick={retryLegacyPending}>
                  {L('手动使用兼容交易重试一次', 'Manually retry once with a legacy transaction')}
                </Button>}
              {pending.canAbandon === true && <Button secondary disabled={busy} onClick={clearUnsent}>
                {L('清除未签名准备记录', 'Clear unsigned preparation')}
              </Button>}
            </section>
          )}
          {route.route === "home" && (
            <SiteOverview
              pools={pools}
              live
              liveStats={stats}
              liveSource={source}
              stage={config?.stage}
              onExplore={(tab) => {
                setFilter(
                  tab === "募集中"
                    ? "Funding"
                    : tab === "挖矿中"
                      ? "Active"
                      : tab === "整机出售中"
                        ? "Listed"
                        : "all",
                );
                go("pools");
              }}
              onAccount={() => go("overview")}
              onRules={() => setModal({ type: "rules" })}
              onRecords={() => go("records")}
            />
          )}
          {accountNeeded && !account && (
            <section className="account-entry">
              <Wallet size={34} />
              <h1>
                {L(
                  "你的矿机资产，从这里看清。",
                  "Your miner assets, all in one place.",
                )}
              </h1>
              <p>
                {L(
                  "连接钱包，查看你的份额与可领取权益。",
                  "Connect your wallet to view shares and claimable balances.",
                )}
              </p>
              <Button disabled={busy || !client} onClick={connect}>
                {L("连接钱包", "Connect wallet")}
              </Button>
            </section>
          )}
          {route.route === "pools" && <LivePortfolios
            config={config} provider={client?.provider} client={client} locale={locale} account={account} wallet={wallet} mode="pools"
            disabled={busy || !!pending} onConnect={connect} onSend={sendPortfolio} marketTransactions={memberTransactions}
            onSourceReorg={problem => invalidateDisplayOnReorg(client, problem)}
            onReadStateChange={state => { portfolioRead.current = state; }}
            renderDirectory={renderProjectDirectory} refreshKey={refresh} displayRefreshKey={displayRefreshKey}/>}
          {route.route === "detail" &&
            (route.invalid ? (
              <Empty title={L("项目链接无效", "Invalid project link")}>
                {L(
                  "请返回项目大厅重新选择矿机。",
                  "Please choose a miner from the pool directory.",
                )}
              </Empty>
            ) : !detail || !same(detail.pool, route.pool)
              || loadedRoute !== `detail/${route.pool}`
              || (loadedAccount || '').toLowerCase() !== (account || '').toLowerCase() ? (
              detailPreview && same(detailPreview.pool, route.pool) ? (
                <section className="panel detail-summary" aria-label={L('已加载的矿池资料', 'Loaded pool information')}>
                  <div className="detail-heading">
                    <Chip pool={detailPreview}/>
                    <div><h1>{detailPreview.name} <span>#{detailPreview.tokenId}</span></h1><small>{shortAddress(detailPreview.pool)}</small></div>
                    <StateBadge state={detailPreview.status} L={L}/>
                  </div>
                  <p>{L('每份金额', 'Price per share')}：
                    <strong>{displayPreciseAmount(detailPreview.unitPriceWei)} BNB</strong></p>
                  <p className="subtle-note">{loading
                    ? L('正在加载项目详情…', 'Loading project details…')
                    : L('最新资料暂不可用，请刷新后认购。', 'Current data is unavailable; refresh before subscribing.')}</p>
                </section>
              ) : <Empty
                title={loading ? L("正在读取矿机信息…", "Loading miner information…")
                  : L("暂时无法读取该项目", "This project is unavailable")}
              >
                {L("请稍后刷新项目资料。",
                  "Refresh the project information shortly.")}
              </Empty>
            ) : (
              <>
                <button className="back-link" onClick={() => go("pools")}>
                  {L("← 返回项目大厅", "← Back to pools")}
                </button>
                <div className="detail-heading">
                  <Chip pool={detail} />
                  <div>
                    <h1>
                      {detail.name} <span>#{detail.tokenId}</span>
                    </h1>
                    <small>{shortAddress(detail.pool)}</small>
                  </div>
                  <StateBadge state={detail.status} L={L} />
                  {refreshButton}
                  <button
                    className="text-button detail-record"
                    onClick={() => setModal({ type: "share", pool: detail })}
                  >
                    <Share2 size={17} />
                    {L("邀请朋友", "Invite friends")}
                  </button>
                </div>
                <div className="detail-layout">
                  <div className="detail-main">
                    <section className="panel detail-summary">
                      <div className="detail-stats">
                        <div>
                          <span>{L("购机募集金额", "Funding target")}</span>
                          <strong>
                            {amount(detail.params?.targetRaise)}{" "}
                            <small>BNB</small>
                          </strong>
                        </div>
                        <div>
                          <span>{L("已募集", "Shares funded")}</span>
                          <strong>
                            {detail.funded ?? "—"} <small>/ 100</small>
                          </strong>
                        </div>
                        <div>
                          <span>{L("共同参与地址", "Holder addresses")}</span>
                          <strong>{detail.members ?? "—"}</strong>
                        </div>
                      </div>
                      <div className="progress">
                        <span style={{ width: `${detail.funded ?? 0}%` }} />
                      </div>
                      <div className="funding-meta">
                        <span>
                          {detail.status === "Funding"
                            ? L(
                                `剩余 ${detail.remaining ?? "—"} 份`,
                                ` ${detail.remaining ?? "—"} shares remaining`,
                              )
                            : L(...statuses[detail.status])}
                        </span>
                        <span>
                          {L("预计日产", "Estimated daily output")}：{currentPoolQuote(detail)
                            ? displayPreciseAmount(currentPoolQuote(detail).estimated24hAtomic, 8)
                            : '—'} BEM
                        </span>
                      </div>
                    </section>
                    <div className="tabs detail-tabs">
                      {[
                        ["asset", "资产详情", "Asset details"],
                        ["records", "收益记录", "Activity"],
                        ["vote", "共同决策", "Governance"],
                        ["members", "参与者", "Holders"],
                      ].map(([key, zh, en]) => (
                        <button
                          key={key}
                          className={detailTab === key ? "selected" : ""}
                          onClick={() => {
                            setDetailTab(key);
                          }}
                        >
                          {L(zh, en)}
                        </button>
                      ))}
                    </div>
                    {detailTab === "asset" && (
                      <section className="panel live-details">
                        <h2>{L("矿机信息", "Miner information")}</h2>
                        <dl className="details-list">
                          {[
                            [
                              L("项目地址", "Pool"),
                              <a
                                href={explorerAddress(detail.pool)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {shortAddress(detail.pool)} ↗
                              </a>,
                            ],
                            [
                              L("矿机集合", "Collection"),
                              detail.params?.circuits ? (
                                <a
                                  href={explorerAddress(detail.params.circuits)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {shortAddress(detail.params.circuits)} ↗
                                </a>
                              ) : (
                                "—"
                              ),
                            ],
                            [
                              L("实际购机成本", "Acquisition cost"),
                              `${amount(detail.purchaseCost)} BNB`,
                            ],
                            [
                              ["Funding", "Funded"].includes(detail.status)
                                ? L("当前认购人数", "Current subscribers")
                                : L("当前份额持有人数", "Current share holders"),
                              L(
                                `${detail.members ?? "—"}人`,
                                `${detail.members ?? "—"} ${["Funding", "Funded"].includes(detail.status) ? "subscribers" : "holders"}`,
                              ),
                            ],
                            [
                              L("募集截止", "Funding deadline"),
                              date(detail.params?.fundingDeadline),
                            ],
                            [
                              L("最晚采购时间", "Purchase deadline"),
                              date(detail.params?.purchaseDeadline),
                            ],
                            [
                              L("收益分配", "Reward allocation"),
                              L(
                                "99% 持有人 · 1% 平台",
                                "99% holders · 1% platform",
                              ),
                            ],
                          ].map(([label, value]) => (
                            <div key={label}>
                              <dt>{label}</dt>
                              <dd>{value}</dd>
                            </div>
                          ))}
                        </dl>
                        <p className="subtle-note">
                          {L(
                            "实际产出随矿机和协议状态变化。已入账权益可由本人随时领取。",
                            "Actual output varies with the miner and protocol. Booked rewards remain available for personal withdrawal.",
                          )}
                        </p>
                        <div className="live-actions">
                          {account &&
                            detail.status === "Funding" &&
                            detail.shares >= 1n && (
                              <Button
                                secondary
                                onClick={() =>
                                  setModal({ type: "share", pool: detail })
                                }
                              >
                                <Share2 size={17} />
                                {L("邀请朋友一起拼矿", "Invite friends to mine together")}
                              </Button>
                            )}
                          {["Funding", "Funded"].includes(detail.status) && (
                            <Button
                              secondary
                              disabled={!detailActionReadyFor('finalizeFailure') || !account}
                              onClick={() =>
                                openAction("finalizeFailure", detail)
                              }
                            >
                              {L("核对到期退款", "Check refund eligibility")}
                            </Button>
                          )}
                          {detail.status === "Funding" &&
                            detail.shares > 0n && (
                              <Button
                                secondary
                                disabled={!detailActionReadyFor('withdrawDeposit')}
                                onClick={() =>
                                  openAction("withdrawDeposit", detail)
                                }
                              >
                                {L(
                                  "撤回本次项目认购",
                                  "Withdraw this subscription",
                                )}
                              </Button>
                            )}
                        </div>
                      </section>
                    )}
                    {detailTab === "records" && (
                      <>
                        <LiveYieldChart
                          data={yieldData}
                          locale={locale}
                          days={yieldDays}
                          onDays={setYieldDays}
                          loading={yieldLoading}
                          error={yieldError}
                        />
                        <section className="panel live-section">
                          {activityTable()}
                        </section>
                      </>
                    )}
                    {detailTab === "vote" && renderGovernance()}
                    {detailTab === "members" && (
                      <section className="panel live-details">
                        <h2>
                          {["Funding", "Funded"].includes(detail.status)
                            ? L("当前认购人数", "Current subscribers")
                            : L("当前持有人", "Current holders")}
                        </h2>
                        {membersRead.status === "loading" ? (
                          <p className="subtle-note">{L("正在核对最新链上持有人…", "Checking current on-chain holders…")}</p>
                        ) : membersRead.status === "error" ? (
                          <div role="alert">
                            <p>{L("持有人地址暂时无法读取，请重试。", "Holder addresses are temporarily unavailable. Please retry.")}</p>
                            <p className="subtle-note">{membersRead.error}</p>
                            <Button secondary onClick={() => void readMembers()}>{L("重新读取持有人", "Retry holders")}</Button>
                          </div>
                        ) : membersRead.status === "ready" && members.length ? (
                          members.map((address) => (
                            <a
                              className="live-holder"
                              key={address}
                              href={explorerAddress(address)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {address}
                              <ArrowUpRight size={15} />
                            </a>
                          ))
                        ) : membersRead.status === "ready" ? (
                          <Empty
                            title={L(
                              "暂无可显示的持有人地址",
                              "No holder addresses to show",
                            )}
                          />
                        ) : null}
                          {membersRead.status === "ready" && membersRead.blockNumber !== null && <p className="subtle-note">
                          {L(`最新链上区块 #${membersRead.blockNumber}`, `Current on-chain block #${membersRead.blockNumber}`)}
                        </p>}
                      </section>
                    )}
                  </div>
                  <aside className="purchase-panel">
                    <div className="order-eyebrow">
                      {L("我的项目权益", "My pool position")}
                    </div>
                    <h2>
                      {L(
                        "共同持有，按份分配",
                        "Own together. Share the output.",
                      )}
                    </h2>
                    <div className="unit-price">
                      {displayPreciseAmount(detail.unitPriceWei)}{" "}
                      <small>BNB / {L("份", "share")}</small>
                    </div>
                    <p className="order-rule purchase-explanation">
                      {L(
                        "每份对应本池 1% 的份额。",
                        "Each share represents 1% of this pool.",
                      )}
                    </p>
                    <p className="order-rule purchase-explanation">
                      {detail.params?.targetRaise && detail.params?.priceCap && detail.params.targetRaise * 10n === detail.params.priceCap * 11n ? L(
                        "为确保购机成功，用户会按矿机出售价格额外预付 10%；购机成功后余款按照份额等比退还",
                        "To help complete the miner purchase, subscribers prepay an extra 10% of its sale price. After a successful purchase, the remaining funds are refunded in proportion to their shares.",
                      ) : L(
                        `本池募集总额 ${displayPreciseAmount(detail.params?.targetRaise)} BNB，购机价格上限 ${displayPreciseAmount(detail.params?.priceCap)} BNB；购机后的余款按份额记入可领取余额。`,
                        `This pool raises ${displayPreciseAmount(detail.params?.targetRaise)} BNB with a ${displayPreciseAmount(detail.params?.priceCap)} BNB purchase cap. Remaining funds after purchase are credited to holders proportionally.`,
                      )}
                    </p>
                    {detail.status === "Funding" ? (
                      <>
                        <div className="ownership">
                          <span>{!config?.displayOnly && (source?.stale || cachedPage)
                            ? L("上次核验剩余", "Remaining at last verification")
                            : L("剩余可认购", "Remaining")}</span>
                          <strong>
                            {detail.remaining ?? "—"} {L("份", "shares")}
                          </strong>
                        </div>
                        <Button
                          disabled={!canOpenFundingAction({ client, config, source, cachedPage,
                            loading, busy, detail, loadedRoute, routePool: route.pool,
                            detailPool: detail.pool, loadedAccount, account })}
                          onClick={() =>
                            account ? openAction("deposit", detail) : connect()
                          }
                        >
                          {account
                            ? L("参与拼矿", "Subscribe")
                            : L("连接钱包参与", "Connect to join")}
                          <ArrowRight size={17} />
                        </Button>
                      </>
                    ) : detail.status === "Listed" ? (
                      <>
                        <div className="ownership">
                          <span>{!config?.displayOnly && (source?.stale || cachedPage || governanceProof?.source?.readMode !== 'current')
                            ? L("核验区块时整机售价", "Miner sale price at verified block")
                            : L("整机售价", "Miner sale price")}</span>
                          <strong>{displayPreciseAmount(same(governanceProof?.pool, route.pool)
                            && same(governanceProof?.account, account || ZeroAddress) ? governance?.salePrice : null)} BNB</strong>
                        </div>
                        <Button
                          disabled={!detailActionsReady || !account || governance?.salePrice == null
                            || !same(governanceProof?.pool, route.pool)
                            || !same(governanceProof?.account, account)
                            || !config?.displayOnly && (governanceProof?.source?.readMode !== 'current' || governanceProof?.source?.stale === true)}
                          onClick={() => openAction("completeFirstoSale", detail)}
                        >
                          {L("在本站购买整机", "Buy miner here")}
                        </Button>
                        <small>{L("通过 Firsto 合约完成整机过户；同一挂单只能成交一次。", "The Firsto contract transfers the miner. Each listing can settle only once.")}</small>
                      </>
                    ) : (
                      <div className="ownership">
                        <span>{!config?.displayOnly && (source?.stale || cachedPage)
                          ? L("核验区块时状态", "Status at verified block")
                          : L("当前状态", "Current status")}</span>
                        <StateBadge state={detail.status} L={L} />
                      </div>
                    )}
                    <div className="ownership">
                      <span>{!config?.displayOnly && (source?.stale || cachedPage)
                        ? L("上次核验我的持仓", "My shares at last verification")
                        : L("我的持仓", "My shares")}</span>
                      <strong>
                        {account ? (detail.shares?.toString() ?? "—") : "—"}{" "}
                        {L("份", "shares")}
                      </strong>
                    </div>
                    <div className="live-actions live-actions-stack">
                      <Button
                        secondary
                        disabled={!detailActionReadyFor('claim') || !detailBemClaim.canClaim}
                        onClick={() => openAction("claim", detail)}
                      >
                        {!config?.displayOnly && (source?.stale || cachedPage)
                          ? L("BEM 领取额待核验", "BEM claim awaiting verification")
                          : detailBemClaim.canClaim ? <>{L("领取", "Claim")} {amount(detail.claimableBEM, 8)} BEM</>
                            : L(detailBemClaim.labelZh, detailBemClaim.labelEn)}
                      </Button>
                      {detailBemClaim.state === 'claimed' && detailBemClaim.evidence?.amount != null && <small>
                        {L('上次已领取', 'Last claimed')} {amount(detailBemClaim.evidence.amount, 8)} BEM
                      </small>}
                      {detailBemClaim.updating && <small role="status">{L(detailBemClaim.hintZh, detailBemClaim.hintEn)}</small>}
                      <Button
                        secondary
                        disabled={!detailActionReadyFor('withdrawBnb') || !detailBnbClaim.canClaim}
                        onClick={() => openAction("withdrawBnb", detail)}
                      >
                        {!config?.displayOnly && (source?.stale || cachedPage)
                          ? L("BNB 领取额待核验", "BNB claim awaiting verification")
                          : detailBnbClaim.canClaim ? <>{L("领取", "Claim")} {displayPreciseAmount(detail.bnbOwed)} BNB</>
                            : L(detailBnbClaim.labelZh, detailBnbClaim.labelEn)}
                      </Button>
                      {detailBnbClaim.state === 'claimed' && detailBnbClaim.evidence?.amount != null && <small>
                        {L('上次已领取', 'Last claimed')} {displayPreciseAmount(detailBnbClaim.evidence.amount)} BNB
                      </small>}
                      {detailBnbClaim.updating && <small role="status">{L(detailBnbClaim.hintZh, detailBnbClaim.hintEn)}</small>}
                      {detail.status === "Active" && (
                        <Button
                          secondary
                          disabled={!detailActionsReady ||
                            !account ||
                            detail.shareTradingAllowed !== true ||
                            !detail.availableShares
                          }
                          onClick={() => openAction("list", detail)}
                        >
                          {L("出售我的份额", "Sell my shares")}
                        </Button>
                      )}
                      <Button
                        secondary
                        onClick={() =>
                          setModal({ type: "share", pool: detail })
                        }
                      >
                        <Share2 size={16} />
                        {L("邀请朋友一起拼矿", "Invite friends")}
                      </Button>
                    </div>
                    <div className="order-foot">
                      <ShieldCheck size={20} />
                      <span>
                        {L(
                          "购机前结清原矿主收益，按有效份额分配后续产出。",
                          "Prior miner output is settled before acquisition. Subsequent output follows valid ownership.",
                        )}
                      </span>
                    </div>
                  </aside>
                </div>
              </>
            ))}
          {route.route === "rewards" && account && (
            <>
              {heading(
                L("收益中心", "Rewards"),
                L(
                  "收益先归集入池，再由本人领取；权益永久保留。",
                  "Output is collected into the pool, then claimed personally. Booked entitlements do not expire.",
                ),
                refreshButton,
              )}
              <div className="metrics">
                <Metric
                  primary
                  title={!config?.displayOnly && positionsReadSource?.stale
                    ? L("上次核验可领取 BEM", "BEM claim at last verification")
                    : L("单矿机可领取 BEM", "Single-miner claimable BEM")}
                  value={amount(claimable, 8)}
                  unit="BEM"
                  note={L(
                    "已加载矿池 · 不含待归集",
                    "Loaded pools · excludes uncollected output",
                  )}
                />
                <Metric
                  title={L("单矿机待领取 BNB", "Single-miner claimable BNB")}
                  value={amount(poolBnb)}
                  unit="BNB"
                  note={L("按矿池分别领取", "Withdraw from each pool")}
                />
                <Metric
                  title={L("市场 BNB", "Market BNB")}
                  value={amount(marketCredit)}
                  unit="BNB"
                  note={
                    <button
                      className="text-button"
                      disabled={!positionsActionReadyFor('marketWithdraw') || !marketCredit || busy}
                      onClick={() => openAction("marketWithdraw", null)}
                    >
                      {L("领取市场款项", "Withdraw market proceeds")}
                    </button>
                  }
                />
                <BemPriceStat variant="metric"/>
              </div>
              <section className="panel">
                <div className="section-head">
                  <h2>{L("逐池领取", "Claim from each pool")}</h2>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{L("矿机", "Miner")}</th>
                        <th>BEM</th>
                        <th>BNB</th>
                        <th>{L("操作", "Actions")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positions.map((p) => (
                        <tr key={p.pool}>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => openDetails(p)}
                            >
                              {p.name} #{p.tokenId}
                            </button>
                          </td>
                          <td>{amount(p.claimableBEM, 8)}</td>
                          <td>{amount(p.bnbOwed)}</td>
                          <td>
                            <div className="live-actions">
                              <Button
                                secondary
                                disabled={!positionsActionReadyFor('claim') || busy || !claimState(p, 'BEM', positionsReadSource).canClaim}
                                onClick={() => openAction("claim", p)}
                              >
                                {L(claimState(p, 'BEM', positionsReadSource).labelZh, claimState(p, 'BEM', positionsReadSource).labelEn)}
                              </Button>
                              <Button
                                secondary
                                disabled={!positionsActionReadyFor('withdrawBnb') || busy || !claimState(p, 'BNB', positionsReadSource).canClaim}
                                onClick={() => openAction("withdrawBnb", p)}
                              >
                                {L(claimState(p, 'BNB', positionsReadSource).labelZh, claimState(p, 'BNB', positionsReadSource).labelEn)}
                              </Button>
                              <Button
                                secondary
                                disabled={!positionsActionReadyFor('harvest') || busy ||
                                  !["Active", "Listed"].includes(p.status)
                                }
                                onClick={() => openAction("harvest", p)}
                              >
                                {L("归集", "Collect")}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!positions.length && (
                    <Empty title={positionsReadLoading
                      ? L('正在读取份额…', 'Loading shares…')
                      : positionsReadError
                        ? L('份额读取失败，请刷新重试', 'Could not read shares. Please refresh.')
                        : L("暂无可领取项目", "No claimable pools")} />
                  )}
                </div>
                {moreButton(positionCursor, "positions")}
              </section>
              <section className="panel live-section">
                <div className="section-head">
                  <h2>{L("已确认账户记录", "Confirmed account activity")}</h2>
                </div>
                {activityTable()}
              </section>
            </>
          )}
          {route.route === "market" && (
            <>
              {heading(
                L("矿机转让", "Marketplace"),
                L(
                  "按链上有效订单买卖份额；下方 Firsto 行情为只读报价。",
                  "Trade verified on-chain shares; Firsto miner quotes below are read-only.",
                ),
                refreshButton,
              )}
              <div className="tabs">
                <button
                  className={marketTab === "shares" ? "selected" : ""}
                  onClick={() => setMarketTab("shares")}
                >
                  {L("份额交易", "Share orders")}
                </button>
                <button
                  className={marketTab === "whole" ? "selected" : ""}
                  onClick={() => setMarketTab("whole")}
                >
                  {L("整机出售", "Whole miners")}
                </button>
                <button
                  className={marketTab === "mine" ? "selected" : ""}
                  onClick={() => setMarketTab("mine")}
                >
                  {L("我的挂单", "My orders")}
                </button>
              </div>
              {marketTab === "whole" ? (
                <section className="panel">
                  {poolTable(pools.filter((p) => p.status === "Listed"))}
                  {moreButton(poolCursor, "pools")}
                </section>
              ) : (
                <section className="panel">
                  <p className="inline-note">{L(
                    "每份挂牌价是成交基价。买方在基价外另付 1%，卖方从基价中扣除 1%；最终钱包金额在确认前展示。",
                    "The listed price is the trade base. Buyers pay 1% on top and sellers pay a separate 1% from proceeds. Review the exact wallet payment before confirming.",
                  )}</p>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{L("项目", "Pool")}</th>
                          <th>{L("剩余份额", "Remaining")}</th>
                          <th>{L("每份挂牌价", "Listed price")}</th>
                          <th>{L("日产能价", "Daily capacity price")}<small>BNB / (BEM / {L("天", "day")})</small></th>
                          <th>{L("卖家", "Seller")}</th>
                          <th>{L("到期", "Expires")}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((o) => (
                          <tr key={o.id?.toString() ?? o.orderId?.toString()}>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => go("detail", o.pool)}
                              >
                                {shortAddress(o.pool)}
                              </button>
                            </td>
                            <td>{o.remaining?.toString() ?? "—"}</td>
                            <td>{amount(o.pricePerUnitWei)} BNB
                              {BigInt(o.pricePerUnitWei ?? 0) < minimumSharePriceWei && <small className="live-order-state">
                                {L('旧低价挂单，仅可撤销', 'Old low-price order; cancel only')}
                              </small>}
                            </td>
                            <td>{capacityCell(o)}</td>
                            <td>
                              {shortAddress(o.seller)}
                              {same(o.seller, account) && <small className="live-order-state">
                                {L("这是你的挂单；购买请切换买家钱包", "Your order; switch to a buyer wallet to purchase")}
                              </small>}
                            </td>
                            <td>
                              {date(o.expiresAt)}
                              {!config?.displayOnly && (marketOrderSource?.stale === true || marketOrderSource?.readMode === 'verified_snapshot')
                                && <small className="live-order-state">{L('历史挂单 · 待核验', 'Historical order · verification pending')}</small>}
                              {o.active !== true ? (
                                <small className="live-order-state">
                                  {L("已结束", "Closed")}
                                </small>
                              ) : o.expiresAt <=
                                BigInt(marketOrderSource?.indexedTimestamp ?? 0) ? (
                                <small className="live-order-state">
                                  {L(
                                    "已到期 · 待解锁",
                                    "Expired · unlock shares",
                                  )}
                                </small>
                              ) : null}
                            </td>
                            <td>
                              <Button
                                secondary
                                disabled={(!(marketOrderNeedsConnection
                                  ? marketOrderConnectReady
                                  : marketOrderActionReady(o, same(o.seller, account) ? 'cancel' : 'fill')) ||
                                  busy ||
                                  o.cancellationPending ||
                                  o.active !== true ||
                                  (!same(o.seller, account) && BigInt(o.pricePerUnitWei ?? 0) < minimumSharePriceWei)
                                )}
                                onClick={() => {
                                  if (marketOrderNeedsConnection) { connect(); return; }
                                  openAction(
                                    same(o.seller, account)
                                      ? o.expiresAt <=
                                        BigInt(marketOrderSource?.indexedTimestamp ?? 0)
                                        ? "expire"
                                        : "cancel"
                                      : "fill",
                                    { pool: o.pool },
                                    { orderId: (o.id ?? o.orderId).toString() },
                                  );
                                }}
                              >
                                {o.cancellationPending ? L('撤单处理中…', 'Cancelling…') : !config?.displayOnly && (marketOrderSource?.stale === true || marketOrderSource?.readMode === 'verified_snapshot')
                                  ? L('挂单待核验', 'Order awaiting verification')
                                  : same(o.seller, account)
                                  ? o.expiresAt <=
                                    BigInt(marketOrderSource?.indexedTimestamp ?? 0)
                                    ? L("解锁份额", "Unlock shares")
                                    : L("撤单", "Cancel")
                                  : BigInt(o.pricePerUnitWei ?? 0) < minimumSharePriceWei
                                    ? L('不可成交', 'Cannot buy')
                                    : L("买入份额", "Buy shares")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!orders.length && (
                      <Empty
                        title={
                          marketOrdersLoading
                            ? L("正在读取订单…", "Loading orders…")
                            : marketOrdersError
                              ? L("订单读取失败，请刷新重试", "Could not read orders. Please refresh.")
                            : marketTab === "mine" && !account
                              ? L(
                                  "连接钱包查看本人挂单",
                                  "Connect your wallet to view your orders",
                                )
                              : L("暂无挂单", "No orders")
                        }
                      />
                    )}
                  </div>
                  {marketOrdersError && <p className="live-dialog-error" role="alert">{marketOrdersError}</p>}
                  {moreButton(orderCursor, "orders")}
                  {!!orders.length && <p className="subtle-note">{L("日产能价按该挂单每份价格 × 100 ÷ 当前矿机预计日产出计算，属于毛产能估算；实际收益另按合约费率结算。产能来源过期或未核验时不显示价格，不影响链上买卖。", "Capacity price is each share order's price × 100 ÷ estimated daily miner output. This gross estimate is not a return guarantee; unavailable estimates do not affect on-chain trading.")}</p>}
                </section>
              )}
              <section className="panel live-section">
                <div className="section-head">
                  <div>
                    <h2>{L("出售我的份额", "Sell my shares")}</h2>
                    <p>
                      {L(
                        "可出售份额以当前持仓扣除已锁定份额为准。",
                        "Available shares exclude shares already locked in orders.",
                      )}
                    </p>
                  </div>
                </div>
                {account ? (
                  poolTable(positions, true)
                ) : (
                  <Empty
                    title={L(
                      "连接钱包查看可售份额",
                      "Connect your wallet to see shares available to sell",
                    )}
                  />
                )}
                {account && moreButton(positionCursor, 'positions')}
              </section>
            </>
          )}
          {route.route === "market" && <FirstoMarketBoard refreshKey={refresh} />}
          {route.route === 'portfolio' && <button className="back-link" onClick={()=>go(portfolioReturnRoute.current)}>{portfolioReturnRoute.current === 'overview' ? L('← 返回资产总览','← Back to my portfolio') : portfolioReturnRoute.current === 'rewards' ? L('← 返回收益中心','← Back to rewards') : L('← 返回参与拼矿','← Back to projects')}</button>}
          {['overview','rewards','governance','market','portfolio'].includes(route.route) && <LivePortfolios
            config={config} provider={client?.provider} client={client} locale={locale} account={account} wallet={wallet} mode={route.route} initialPool={route.route === 'portfolio' ? route.pool : null}
            disabled={busy || !!pending} onConnect={connect} onSend={sendPortfolio} marketTransactions={memberTransactions}
            onSourceReorg={problem => invalidateDisplayOnReorg(client, problem)}
            onShare={pool => setModal({ type: 'portfolio-share', pool })}
            onReadStateChange={state => { portfolioRead.current = state; }}
            renderDirectory={route.route === 'overview' ? renderAssetOverview : undefined}
            onBuyChild={pool => openAction('completeFirstoSale', { pool })} refreshKey={refresh} displayRefreshKey={displayRefreshKey}/>}

          {route.route === "governance" && (
            <>
              {heading(
                L("共同决策", "Governance"),
                L(
                  "选择矿机，查看当前提案、票权和执行条件。",
                  "Choose a miner to view proposals, voting power and execution eligibility.",
                ),
                refreshButton,
              )}
              <section className="panel">
                <div className="live-governance-list">
                  {(account ? positions : pools)
                    .filter((p) => ["Active", "Listed"].includes(p.status))
                    .map((p) => (
                      <button
                        className="task-item"
                        key={p.pool}
                        onClick={() => {
                          go("detail", p.pool);
                          setDetailTab("vote");
                        }}
                      >
                        <Chip pool={p} />
                        <span>
                          <strong>
                            {p.name} #{p.tokenId}
                          </strong>
                          <small>
                            {L("查看共同决策", "View governance")} ·{" "}
                            {shortAddress(p.pool)}
                          </small>
                        </span>
                        <ChevronRight size={18} />
                      </button>
                    ))}
                </div>
                {!(account ? positions : pools).some((p) =>
                  ["Active", "Listed"].includes(p.status),
                ) && (
                  <Empty
                    title={account && positionsReadLoading
                      ? L('正在读取份额与决策…', 'Loading shares and decisions…')
                      : account && positionsReadError
                        ? L('份额读取失败，请刷新重试', 'Could not read shares. Please refresh.')
                        : L('暂无可显示的矿机决策', 'No miner decisions to show')}
                  />
                )}
              </section>
              {moreButton(
                account ? positionCursor : poolCursor,
                account ? "positions" : "pools",
              )}
            </>
          )}
          {route.route === 'operator' && !['disconnected', 'denied'].includes(operatorAccess) && (hasOperatorAccess ? <>
            {heading(L('运营工作台', 'Pool operations'), L('创建矿池、购机与管理矿机。', 'Create pools, purchase and manage miners.'))}
            <div className="operator-tabs operator-workspace-tabs" role="tablist" aria-label={L('运营板块', 'Operations sections')}>
              {[["publish", L('发布项目', 'Publish projects')], ["review", L('审核', 'Review requests')], ["fees", L('领取手续费', 'Collect fees')]].map(([value, label]) =>
                <button key={value} id={`operator-tab-${value}`} role="tab" aria-selected={operatorTab === value}
                  aria-controls={`operator-panel-${value}`} className={`btn${operatorTab === value ? '' : ' secondary'}`}
                  disabled={busy} onClick={() => setOperatorTab(value)}>{label}</button>)}
            </div>
            <div role="tabpanel" id={`operator-panel-${operatorTab}`} aria-labelledby={`operator-tab-${operatorTab}`}>
            {operatorTab === 'publish' && <>
            {isOperator && <LiveOperator key={`${config?.factory}:${account}:${walletRevision}`} config={config} wallet={wallet} readProvider={client?.provider} account={account} refreshKey={refresh}
              operator={operator} disabled={busy || !!pending || !operatorServiceReady} onSend={sendAdminAction}
              disabledReason={!operatorServiceReady ? L('交易服务恢复中，暂不能预览或签名；恢复后会自动启用。', 'Transaction services are recovering; previews and signatures will resume after verification.')
                : pending ? L('请先核对上一笔交易结果。', 'Verify the previous transaction first.') : undefined}
              gasFeeWei={transactionGasWei}
              onRefresh={() => { setOperatorRefresh(value => value + 1); setRefresh(value => value + 1); }}/>}
            <LivePortfolios config={config} provider={client?.provider} account={account} wallet={wallet} mode="operator" locale={locale} operatorVerified={isPortfolioOperator}
              disabled={busy || !!pending || !operatorServiceReady} onConnect={connect} onSend={sendPortfolio} marketTransactions={memberTransactions}
              onSourceReorg={problem => invalidateDisplayOnReorg(client, problem)}
              onSendQueue={budgetPurchaseQueueSupported(config) ? sendBudgetQueueStep : undefined} onAuthenticateQueue={connectBudgetQueue} onShare={pool => setModal({ type: 'portfolio-share', pool })}
              onBuyChild={pool => openAction('completeFirstoSale', { pool })} refreshKey={refresh}/>
            </>}
            {operatorTab !== 'publish' && (isOperator && config?.stage === 'fresh-active'
              ? <FreshAuthorityConsole key={`${config?.factory}:${account}:${walletRevision}:${operatorTab}`}
                  mode={operatorTab} config={config} account={account} provider={client?.provider} refreshKey={refresh}
                  wallet={wallet} disabled={busy || !!pending || !operatorServiceReady} onAction={sendFreshAuthority}/>
              : <section className="panel"><Empty title={L('当前钱包没有此板块的管理员权限', 'This wallet does not have administrator access to this section')}/></section>)}
            </div>
          </> : <section className="panel" data-operator-access={operatorAccess}>
            <Empty title={operatorAccess === 'checking'
              ? L('正在核对访问权限', 'Checking access')
              : L('此页面仅限授权运营人员', 'Restricted access')}>
              {operatorAccess === 'checking'
                ? L('请稍候，核验完成后会显示可用页面。', 'Please wait while access is verified.')
                : operatorAccess === 'unavailable'
                  ? L('暂时无法验证访问权限，请稍后重试。', 'Access could not be verified. Please try again later.')
                  : L('你可以返回首页查看并参与公开项目。', 'Return to the home page to view and join public pools.')}
            </Empty>
            <div className="live-actions">
              <Button secondary onClick={() => go('home')}>{L('返回拼矿首页', 'Back to home')}</Button>
              {wallet && account && operatorAccess !== 'checking' && <Button secondary disabled={busy}
              onClick={() => config.productFamily === 'fresh-v4' && !config.displayOnly && !freshIdentityReadable(config)
                ? setBootAttempt(value => value + 1) : setOperatorRefresh(value => value + 1)}>{L('重新核对权限', 'Check access again')}</Button>}
            </div>
          </section>)}
          {route.route === "records" && (
            <>
              {heading(
                L("公开记录", "Public records"),
                L(
                  "每条记录均可核对链上区块与交易。",
                  "Verify each record against its block and transaction.",
                ),
                <Button
                  secondary
                  disabled={!activity.length}
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([exportActivityCsv(activity)], {
                        type: "text/csv;charset=utf-8",
                      }),
                    );
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = "BEMine-onchain-records.csv";
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  <Download size={16} />
                  {L("导出已加载记录", "Export loaded records")}
                </Button>,
              )}
              <section className="panel">{activityTable()}</section>
            </>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} />
              {L(
                "公开规则 · 明确权益 · 可核对的记录",
                "Public rules · Clear ownership · Verifiable records",
              )}
            </span>
            {route.route !== 'notifications' && <span>
              {pageSource
                ? pageSourceLabel +
                  ` ${pageSource.indexedBlock ?? pageSource.indexedThrough ?? pageSource.blockNumber ?? "—"}`
                : route.route === 'portfolio'
                  ? config?.displayOnly ? L('预算项目数据', 'Portfolio data') : L('预算项目独立核对', 'Portfolio data verified separately')
                : boot.status === 'loading' || loading
                  ? L("更新中…", "Updating…")
                  : L("数据暂不可用", "Data temporarily unavailable")}
            </span>}
          </footer>
        </main>
      </div>
      {transactionResult && <TransactionResultDialog result={transactionResult} locale={locale}
        onProject={() => { setTransactionResults(previous => previous.slice(1)); go(transactionResult.projectKind === 'portfolio' ? 'portfolio' : 'detail', transactionResult.projectAddress); }}
        onDirectory={() => { setTransactionResults(previous => previous.slice(1)); setFilter('Funding'); go('pools'); }}
        onClose={() => setTransactionResults(previous => previous.slice(1))}/>}
      {modal && !transactionResult && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) {
              setModal(null);
              setPrepared(null);
            }
          }}
        >
          <section
            className={`modal live-modal${['share','portfolio-share'].includes(modal.type) ? " live-share-modal" : ""}${modal.type === 'action' && modal.kind === 'list' ? ' live-sale-modal' : ''}`}
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-dialog-title"
          >
            {!['share','portfolio-share'].includes(modal.type) && (
              <button
                className="modal-close icon-button"
                disabled={modal.type === "connect-wallet" ? false : busy}
                aria-label={L("关闭弹窗", "Close dialog")}
                onClick={() => {
                  setModal(null);
                  setPrepared(null);
                }}
              >
                <X size={21} />
              </button>
            )}
            {modal.type === "connect-wallet" ? (
              <WalletConnectModal wallets={wallets} onSelect={selectWallet}
                reselectAccount={modal.reselectAccount === true}
                onRefresh={() => discovery.current?.refresh()} pendingId={connectingId}
                error={connectionError} locale={locale}
                qrEnabled={walletConnectEnabled} qrImage={walletQr}
                onScan={() => selectWallet({ id: 'walletconnect', name: 'WalletConnect' }, true)}
                onCancelScan={cancelWalletScan}
                dappUrl={typeof window === 'undefined' ? publicBaseUrl : window.location.href} />
            ) : modal.type === 'portfolio-share' ? (
              <><h2 id="live-dialog-title" className="sr-only">{L('分享多矿机项目', 'Share a multi-miner portfolio')}</h2>
                <PortfolioProjectShare locale={locale} publicBaseUrl={publicBaseUrl} project={modal.pool}
                  confirmation={modal.confirmation} onDismiss={() => setModal(null)} /></>
            ) : modal.type === "share" ? (
              <>
                <h2 id="live-dialog-title" className="sr-only">
                  {L("邀请朋友一起拼矿", "Invite friends to BEMine")}
                </h2>
                <ProjectShare
                  locale={locale}
                  publicBaseUrl={publicBaseUrl}
                  project={shareProject(modal.pool)}
                  confirmation={modal.confirmation}
                  onDismiss={() => setModal(null)}
                />
              </>
            ) : modal.type === "wallet" ? (
              <>
                <h2 id="live-dialog-title">{L("我的钱包", "My wallet")}</h2>
                {walletInfo && <p className="wallet-connected-brand"><WalletIcon wallet={walletInfo} size={28} /> {walletInfo.name}</p>}
                <p className="live-wrap">{account}</p>
                <div className="live-actions">
                  <Button disabled={busy} onClick={inspectPending}>
                    {L("核对待处理交易", "Check pending transactions")}
                  </Button>
                  <Button secondary disabled={busy} onClick={connect}>{L("切换钱包", "Switch wallet")}</Button>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      if (walletInfo?.id === 'walletconnect') void qrConnector.current?.disconnect();
                      epoch.current++;
                      walletEpoch.current++;
                      setOperator(null);
                      setAccount(null);
                      setWallet(null);
                      setWalletChecking(false);
                      setWalletInfo(null);
                      connectedWallet.current = null;
                      setPending(null);
                      clearWalletDisplay();
                      setModal(null);
                    }}
                  >
                    {L("断开本页连接", "Disconnect this page")}
                  </Button>
                </div>
                <p>
                  {L(
                    "交易记录由服务器保存；断开页面不会撤销链上交易。",
                    "Transaction records stay on the server. Disconnecting does not cancel an on-chain transaction.",
                  )}
                </p>
              </>
            ) : modal.type === "cancel-pending" ? (
              <>
                <h2 id="live-dialog-title">
                  {L("取消待定交易", "Cancel pending transaction")}
                </h2>
                <p>
                  {L(
                    "这会请求钱包发送一笔同序号、0 BNB 的自转交易，用于取消尚未上链的原操作。取消也需要支付 Gas；如果原交易已经确认，请先核对最终结果。",
                    "This asks your wallet to send a zero-BNB self-transfer with the same nonce to replace an unconfirmed operation. Cancellation costs gas. If the original transaction is already confirmed, check its final outcome first.",
                  )}
                </p>
                <p>
                  {L(
                    "原交易可能先于取消交易确认，最终以链上结果为准。",
                    "The original transaction may confirm first. The final on-chain result determines the outcome.",
                  )}
                </p>
                <Button disabled={busy || !pending} onClick={cancelPending}>
                  {L("了解费用，前往钱包确认", "Review cancellation in wallet")}
                </Button>
              </>
            ) : modal.type === "future" ? (
              <>
                <h2 id="live-dialog-title">{L("服务筹备中", "Coming soon")}</h2>
                <p>
                  {L(
                    "更多服务，敬请期待。",
                    "More services are coming soon.",
                  )}
                </p>
              </>
            ) : modal.type === "rules" ? (
              <>
                <h2 id="live-dialog-title">
                  {L("参与规则", "Participation rules")}
                </h2>
                <div className="rule-items">
                  {[
                    [
                      "共同出资",
                      "Subscribe together",
                      "每池 100 个整数份额，单钱包可认购全部份额，以 BNB 支付。",
                      "Each pool has 100 whole shares. One wallet may subscribe for all shares using BNB.",
                    ],
                    [
                      "按份分配",
                      "Share actual output",
                      "矿机产出先归集，99% 记入持有人权益，1% 为平台费用。",
                      "Collected output is allocated 99% to holders and 1% to the platform.",
                    ],
                    [
                      "本人领取",
                      "Claim personally",
                      "本人领取已入账 BEM，无领取间隔，权益永久保留。",
                      "Claim your booked BEM without a cooldown. Entitlements remain available.",
                    ],
                    [
                      "共同决定",
                      "Decide together",
                      config?.stage === "genesis"
                        ? "旧矿池整机出售须地址多数；低于购机成本需至少 60 份赞成，其余超过 50 份。"
                        : "新矿池整机出售须份额与快照地址均严格过半；低于市场参考价须平台审核。",
                      config?.stage === "genesis"
                        ? "Legacy miner sales require a wallet majority and at least 60 shares below acquisition cost, otherwise more than 50."
                        : "New miner sales require majorities of both shares and snapshot wallets. Sales below the market reference require platform review.",
                    ],
                    [
                      "灵活转让",
                      "Trade shares",
                      "份额交易按成交基价向买方另收 1%，并从卖方收入扣除 1%；整机交易仍只扣 1%。份额挂单 7 天到期，表决期间暂停新挂单与成交。",
                      "Share trades charge buyers 1% above the base price and deduct a separate 1% from sellers. Whole-miner sales still deduct 1%. Share orders expire after 7 days; voting pauses new orders and fills.",
                    ],
                  ].map(([zh, en, desc, eng]) => (
                    <p key={zh}>
                      <b>{L(zh, en)}</b>
                      {L(desc, eng)}
                    </p>
                  ))}
                </div>
              </>
            ) : modal.type === 'action' && modal.kind === 'list' ? (
              <ShareSaleDialogContent pool={modal.pool} account={account} quantity={quantity} price={price}
                prepared={prepared} busy={busy} blocked={!!pending && !config.displayOnly} error={error}
                progress={transactionStage ? L(...(transactionLabels[transactionStage] || transactionLabels.rechecking)) : null}
                locale={locale} onQuantity={setQuantity} onPrice={setPrice} onPrepare={prepare}
                onSubmit={submit} onEdit={() => setPrepared(null)} onConnect={connect}/>
            ) : (
              modal.type === "action" && (
                <>
                  <h2 id="live-dialog-title">{actionLabel(modal.kind)}</h2>
                  {modal.kind !== 'fill' && <p>
                    {modal.pool?.name
                      ? `${modal.pool.name} #${modal.pool.tokenId}`
                      : shortAddress(modal.pool?.pool ?? config?.shareMarket)}
                  </p>}
                  {!account ? (
                    <Button disabled={busy} onClick={connect}>
                      {L("连接钱包", "Connect wallet")}
                    </Button>
                  ) : (
                    <>
                      {modal.kind === 'list' && <div className="confirm-lines">
                        <div><span>{L('我的持有份额', 'My shares')}</span><strong>{modal.pool.shares.toString()}</strong></div>
                        <div><span>{L('已挂单锁定', 'Locked in orders')}</span><strong>{modal.pool.lockedShares.toString()}</strong></div>
                        <div><span>{L('本次最多可售', 'Available to list')}</span><strong>{modal.pool.availableShares.toString()}</strong></div>
                        <p>{L('已自动选择你的持仓项目，无需填写合约地址。', 'Your holding is selected automatically. No contract address is required.')}</p>
                      </div>}
                      {["deposit", "fill", "list"].includes(modal.kind) && (
                        <label className="field-label">
                          {L("份额数量", "Number of shares")}
                          <input
                            inputMode="numeric"
                            value={quantity}
                            disabled={busy || !!prepared}
                            onChange={(e) => setQuantity(e.target.value)}
                            placeholder="1–100"
                          />
                        </label>
                      )}
                      {modal.kind === 'list' && <button className="text-button" disabled={busy || !!prepared}
                        onClick={() => setQuantity(modal.pool.availableShares.toString())}>{L('填入全部可售份额', 'Use all available shares')}</button>}
                      {["list", "propose"].includes(modal.kind) && (
                        <label className="field-label">
                          {modal.kind === "list"
                            ? L("每份价格 · BNB", "Price per share · BNB")
                            : L(
                                "整机拟售价格 · BNB",
                                "Proposed miner price · BNB",
                              )}
                          <input
                            inputMode="decimal"
                            value={price}
                            disabled={busy || !!prepared}
                            onChange={(e) => setPrice(e.target.value)}
                            placeholder="0.005"
                          />
                        </label>
                      )}
                      {modal.kind === 'list' && <p className="subtle-note">{L('每份最低 0.00001 BNB；低于此价格的旧挂单只能撤销或到期解锁。', 'Minimum 0.00001 BNB per share. Older cheaper orders may only be cancelled or expired.')}</p>}
                      {['claim','withdrawBnb','marketWithdraw','withdrawDeposit','finalizeFailure','harvest','cancel','expire','cancelExpired'].includes(modal.kind) && <p className="subtle-note">{L('这笔领取、退款或撤单由你的钱包直接发送，并由你的钱包支付网络 Gas。','Your wallet sends this claim, refund or cancellation and pays the network Gas.')}</p>}
                      {modal.kind === "vote" && (
                        <p>
                          {modal.support
                            ? L(
                                "你的选择：赞成出售",
                                "Your choice: approve sale",
                              )
                            : L(
                                "你的选择：反对出售",
                                "Your choice: oppose sale",
                              )}
                        </p>
                      )}
                      {prepared ? (
                        <>
                          <div className="confirm-lines">
                            {modal.kind === 'list' && <>
                              <div><span>{L('挂牌份数', 'Listed shares')}</span><strong>{quantity}</strong></div>
                              <div><span>{L('每份挂牌价', 'Ask per share')}</span><strong title={`${price} BNB`}>{displayDecimal(price)} BNB</strong></div>
                              <div><span>{L('全部成交基价', 'Total asking price')}</span><strong>{amount(prepared.listingGrossWei)} BNB</strong></div>
                            </>}
                            {modal.kind === 'fill' && prepared.marketTrade && <>
                              <div><span>{L('买方 1% 手续费', 'Buyer fee · 1%')}</span><strong>{amount(prepared.marketTrade.buyerFeeWei)} BNB</strong></div>
                            </>}
                            {modal.kind === 'completeFirstoSale' && prepared.quote && <>
                              <div><span>{L('整机挂牌价', 'Approved miner price')}</span><strong>{amount(prepared.quote.priceWei)} BNB</strong></div>
                              <div><span>{L('Firsto 买方手续费', 'Firsto buyer fee')}</span><strong>{amount(prepared.quote.sourceFeeWei)} BNB</strong></div>
                              <div><span>{L('平台费（挂牌价的 1%）', 'Platform fee (1% of sale price)')}</span><strong>{amount(prepared.quote.feeWei)} BNB</strong></div>
                              <div><span>{L('持有人可分配卖款', 'Holder sale proceeds')}</span><strong>{amount(prepared.quote.holderNetWei)} BNB</strong></div>
                              <p>{L('同笔完成收益结清与整机过户。如果该挂单已被其他买家成交，本次购买会整体回退。', 'Rewards and miner ownership settle together. If another buyer has already filled the listing, this purchase reverts in full.')}</p>
                            </>}
                            <div>
                              <span>{modal.kind === 'fill' ? L('总支付（含手续费）', 'Total payment (including fee)') : modal.kind === 'list' ? L("本次钱包支付（另付 Gas）", "Wallet payment (plus Gas)") : L("支付金额", "Payment")}</span>
                              <strong>
                                {amount(BigInt(prepared.transaction.value))}{" "}
                                BNB
                              </strong>
                            </div>
                            {modal.kind !== 'fill' && <><div>
                              <span>{L("接收合约", "Target contract")}</span>
                              <a
                                href={explorerAddress(prepared.transaction.to)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {shortAddress(prepared.transaction.to)} ↗
                              </a>
                            </div>
                            <div>
                              <span>{L("支付钱包", "Your wallet")}</span>
                              <strong>{shortAddress(account)}</strong>
                            </div></>}
                          </div>
                          {modal.kind === 'fill' ? <p className="subtle-note">{L('网络 Gas 另计，以钱包显示为准。', 'Network Gas is additional. Review it in your wallet.')}</p> : <p className="inline-note">
                            {L(
                              "金额显示至五位小数；不足 0.00001 的正金额会标为小于该值。交易仍使用原始精确值，请在钱包核对金额与 Gas；以链上确认为准。",
                              "Amounts are displayed to five decimals; positive amounts below 0.00001 are marked as less than that value. Transactions retain their exact values. Review the amount and Gas in your wallet; completion requires on-chain confirmation.",
                            )}
                          </p>}
                          {busy && transactionStage && <p className="wallet-connect-status" role="status" aria-live="polite">
                            {L(...(transactionLabels[transactionStage] || transactionLabels.rechecking))}
                          </p>}
                          <div className="live-actions">
                            <Button
                              disabled={busy || (!!pending && !config.displayOnly)}
                              onClick={submit}
                            >
                              {busy
                                ? L("等待确认…", "Awaiting confirmation…")
                                : L("确认并前往钱包", "Confirm in wallet")}
                            </Button>
                            <Button
                              secondary
                              disabled={busy}
                              onClick={() => setPrepared(null)}
                            >
                              {L("返回修改", "Edit")}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <Button disabled={busy || (!!pending && !config.displayOnly)} onClick={prepare}>
                          {busy
                            ? L("正在核对…", "Checking…")
                            : L("核对交易金额", "Review transaction")}
                        </Button>
                      )}
                      {modal.kind !== 'fill' && !config.displayOnly && <p className="subtle-note">
                        {L(
                          "首次操作会请你签署钱包登录消息，用于保存和恢复本人的交易记录。",
                          "Your first action asks you to sign a wallet login message to save and recover your transaction records.",
                        )}
                      </p>}
                    </>
                  )}
                </>
              )
            )}
            {error && !(modal.type === 'action' && modal.kind === 'list') && (
              <p className="live-dialog-error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function compare(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
