"use client";
import { useEffect, useRef, useState } from "react";
import { ZeroAddress, getAddress } from "ethers";
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
  LockKeyhole,
  Share2,
  CheckCircle2,
  AlertCircle,
  Search,
  SlidersHorizontal,
  Download,
  ExternalLink,
} from "lucide-react";
import { useI18n } from "../lib/i18n";
import BrandMark from "./BrandMark";
import SiteOverview from "./SiteOverview";
import LiveYieldChart from "./LiveYieldChart";
import ProjectShare from "./ProjectShare";
import { resolveDeployConsoleUrl } from "../lib/deploy-console-url.mjs";
import { loadLiveConfig } from "../lib/live-config.mjs";
import { createLiveDataClient } from "../lib/live-data.mjs";
import {
  connectWallet,
  authenticate,
  readPending,
  sendProductTransaction,
  recoverPending,
  cancelPendingNonce,
} from "../lib/live-transactions.mjs";
import { prepareProductAction } from "../lib/live-actions.mjs";
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
} from "../lib/live-view.mjs";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
const deploymentConsoleUrl = resolveDeployConsoleUrl(
  process.env.NEXT_PUBLIC_DEPLOY_CONSOLE_URL,
);
const publicBaseUrl =
  process.env.NEXT_PUBLIC_BEMINE_PUBLIC_URL || "https://tapeout.cc.cd/bemine/";
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
  completeSale: ["购买整台矿机", "Buy whole miner"],
  cancelExpired: ["解除到期挂牌", "Clear expired listing"],
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
  return (
    <span className={`chip ${pool?.color || "blue"}`}>
      <Layers3 size={24} />
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
      <div className="metric-note">{note}</div>
    </div>
  );
}

export default function LivePlatform() {
  const { locale, setLocale, t } = useI18n();
  const L = (zh, en) => (locale === "en" ? en : zh);
  const [appearance, setAppearance] = useState("light"),
    [menu, setMenu] = useState(false),
    [route, setRoute] = useState({ route: "home", pool: null });
  const [boot, setBoot] = useState({ status: "loading" }),
    [client, setClient] = useState(null),
    [account, setAccount] = useState(null),
    [wallet, setWallet] = useState(null);
  const [pools, setPools] = useState([]),
    [positions, setPositions] = useState([]),
    [stats, setStats] = useState(null),
    [detail, setDetail] = useState(null),
    [governance, setGovernance] = useState(null),
    [members, setMembers] = useState([]),
    [orders, setOrders] = useState([]),
    [activity, setActivity] = useState([]),
    [source, setSource] = useState(null);
  const [poolCursor, setPoolCursor] = useState(null),
    [positionCursor, setPositionCursor] = useState(null),
    [orderCursor, setOrderCursor] = useState(null),
    [activityCursor, setActivityCursor] = useState(null),
    [marketCredit, setMarketCredit] = useState(null);
  const [yieldData, setYieldData] = useState(null),
    [yieldDays, setYieldDays] = useState(30);
  const [loadedRoute, setLoadedRoute] = useState("");
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState(null),
    [quantity, setQuantity] = useState("1"),
    [price, setPrice] = useState(""),
    [prepared, setPrepared] = useState(null),
    [pending, setPending] = useState(null),
    [recoveryHash, setRecoveryHash] = useState("");
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [sort, setSort] = useState("funded"),
    [filtersOpen, setFiltersOpen] = useState(false),
    [detailTab, setDetailTab] = useState("asset"),
    [marketTab, setMarketTab] = useState("shares");
  const epoch = useRef(0),
    modalRef = useRef(null),
    restoreFocus = useRef(null),
    connectedWallet = useRef(null),
    lastConfirmed = useRef(null),
    walletEpoch = useRef(0),
    activeModal = useRef(null);
  activeModal.current = modal;
  const config =
    boot.status === "ready"
      ? { ...boot, ...boot.manifest, journalBase: "/api/journal" }
      : null;

  useEffect(() => {
    try {
      const stored = localStorage.getItem("bemine-appearance");
      if (["light", "dark"].includes(stored)) setAppearance(stored);
    } catch {}
    const sync = () => {
      setRoute(parseProductRoute(location.hash));
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
    let cancelled = false;
    loadLiveConfig({ basePath })
      .then(async (result) => {
        if (cancelled) return;
        if (result.status !== "ready") {
          setBoot(result);
          return;
        }
        const service = createLiveDataClient(result);
        await service.verifyDeployment();
        if (!cancelled) {
          setBoot(result);
          setClient(service);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setBoot({ status: "error" });
          setError(textError(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!wallet?.on) return;
    const changed = () => {
      epoch.current++;
      walletEpoch.current++;
      setAccount(null);
      setWallet(null);
      connectedWallet.current = null;
      setPending(null);
      setPrepared(null);
      setModal(null);
      setPositions([]);
      setMarketCredit(null);
      setMessage(
        L(
          "钱包账户或网络已改变，请重新连接。",
          "Wallet or network changed. Please reconnect.",
        ),
      );
      setRefresh((v) => v + 1);
    };
    wallet.on("accountsChanged", changed);
    wallet.on("chainChanged", changed);
    return () => {
      wallet.removeListener?.("accountsChanged", changed);
      wallet.removeListener?.("chainChanged", changed);
    };
  }, [wallet, locale]);
  useEffect(() => {
    if (!modal) return;
    restoreFocus.current = document.activeElement;
    const before = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modalRef.current?.querySelector("button,input")?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !busy) setModal(null);
      if (e.key === "Tab") {
        const elements = modalRef.current?.querySelectorAll(
          "button:not(:disabled),input:not(:disabled),a[href]",
        );
        if (!elements?.length) return;
        const first = elements[0],
          last = elements[elements.length - 1];
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
      document.body.style.overflow = before;
      document.removeEventListener("keydown", key);
      restoreFocus.current?.focus();
    };
  }, [modal, busy]);

  const go = (next, pool) => {
    if (busy) return;
    location.hash = pool ? `${next}/${pool}` : next;
    setDetailTab("asset");
    window.scrollTo({ top: 0, behavior: "instant" });
  };
  const openAction = (kind, pool, extra = {}) => {
    setError("");
    if (
      kind === "list" &&
      (pool?.status !== "Active" ||
        pool.shareTradingAllowed !== true ||
        !pool.availableShares)
    ) {
      setError(
        L("这台矿机暂不支持份额转让", "Shares in this miner cannot be transferred at this stage"),
      );
      return;
    }
    setPrepared(null);
    setQuantity("1");
    setPrice("");
    setModal({ type: "action", kind, pool, ...extra });
  };
  const openDetails = (pool) => go("detail", pool.pool);
  const date = (value) =>
    value == null
      ? "—"
      : new Date(Number(value) * 1000).toLocaleString(
          locale === "en" ? "en-GB" : "zh-CN",
          { timeZone: "Asia/Shanghai", hour12: false },
        );
  const actionLabel = (kind) => L(...(actionNames[kind] || [kind, kind]));
  const accountNeeded = ["overview", "rewards"].includes(route.route);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const revision = ++epoch.current;
    const current = () => !cancelled && revision === epoch.current;
    setLoadedRoute("");
    setPositionsLoaded(false);
    setPositions([]);
    setMarketCredit(null);
    setLoading(true);
    setError("");
    setDetail(null);
    setGovernance(null);
    setMembers([]);
    setOrders([]);
    setActivity([]);
    setStats(null);
    setSource(null);
    setPoolCursor(null);
    setPositionCursor(null);
    setOrderCursor(null);
    setActivityCursor(null);
    async function load() {
      const catalog = await client.readPools({
        account: account || ZeroAddress,
      });
      if (cancelled || revision !== epoch.current) return;
      setPools(catalog.items.map(viewPool));
      setPoolCursor(catalog.nextCursor);
      setSource(catalog.source);
      const tasks = [];
      if (route.route === "home")
        tasks.push(
          client.readStats({ source: catalog.source }).then((result) => {
            if (current()) setStats(result.data);
          }),
        );
      if (
        account &&
        ["overview", "rewards", "market", "governance"].includes(route.route)
      )
        tasks.push(
          client
            .readPositions({ account, source: catalog.source })
            .then((result) => {
              if (current()) {
                setPositions(result.items.map(viewPool));
                setPositionCursor(result.nextCursor);
                setPositionsLoaded(true);
                setMarketCredit(result.marketBnbOwed);
              }
            }),
        );
      else setPositions([]);
      if (route.route === "detail" && route.pool) {
        const result = await client.readPool({
          pool: route.pool,
          account: account || ZeroAddress,
          source: catalog.source,
        });
        if (cancelled || revision !== epoch.current) return;
        setDetail(viewPool(result.item));
        tasks.push(
          client
            .readGovernance({
              pool: route.pool,
              account: account || ZeroAddress,
              source: catalog.source,
            })
            .then((result) => {
              if (current()) setGovernance(result.data);
            }),
        );
        tasks.push(
          client
            .readActivity({ pool: route.pool, source: catalog.source })
            .then((result) => {
              if (current()) {
                setActivity(result.items);
                setActivityCursor(result.nextCursor);
              }
            }),
        );
      }
      if (route.route === "market" && (marketTab !== "mine" || account))
        tasks.push(
          client
            .readOrders({
              source: catalog.source,
              ...(marketTab === "mine"
                ? { seller: account }
                : { active: true }),
            })
            .then((result) => {
              if (current()) {
                setOrders(result.items);
                setOrderCursor(result.nextCursor);
              }
            }),
        );
      if (["records", "overview", "rewards"].includes(route.route))
        tasks.push(
          client
            .readActivity({
              account:
                route.route === "records" ? undefined : account || undefined,
              source: catalog.source,
            })
            .then((result) => {
              if (current()) {
                setActivity(result.items);
                setActivityCursor(result.nextCursor);
              }
            }),
        );
      const results = await Promise.allSettled(tasks);
      if (cancelled || revision !== epoch.current) return;
      const failed = results.find((r) => r.status === "rejected");
      if (failed) setError(textError(failed.reason));
    }
    load()
      .catch((e) => {
        if (!cancelled && revision === epoch.current) {
          setError(textError(e));
          setPools([]);
          setPositions([]);
        }
      })
      .finally(() => {
        if (!cancelled && revision === epoch.current) {
          setLoading(false);
          setLoadedRoute(route.route + (route.pool ? `/${route.pool}` : ""));
        }
      });
    return () => {
      cancelled = true;
      epoch.current++;
    };
  }, [client, account, route.route, route.pool, refresh, marketTab]);

  useEffect(() => {
    let cancelled = false;
    setYieldData(null);
    if (client && route.route === "detail" && route.pool && source)
      client
        .readYield({
          pool: route.pool,
          account: account || undefined,
          days: yieldDays,
          source,
        })
        .then((result) => {
          if (!cancelled) setYieldData(result.data);
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, route.route, route.pool, account, source, yieldDays]);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const provider = window.ethereum;
      if (!provider)
        throw new Error(
          L(
            "请在支持钱包的浏览器中打开，或安装钱包扩展。",
            "Open this site in your wallet browser or install a wallet extension.",
          ),
        );
      const owner = await connectWallet(provider);
      walletEpoch.current++;
      connectedWallet.current = provider;
      setWallet(provider);
      setAccount(getAddress(owner));
      setModal(null);
      setPending(null);
      setMessage(
        L(
          "钱包已连接。发送交易前会请你确认。",
          "Wallet connected. Each transaction requires your confirmation.",
        ),
      );
    } catch (e) {
      setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function connectJournal() {
    const context = walletEpoch.current;
    if (!wallet || !account || !config)
      throw new Error(L("请先连接钱包。", "Connect your wallet first."));
    await authenticate({ provider: wallet, account, config });
    const result = await readPending({ account, config });
    if (context !== walletEpoch.current)
      throw new Error(
        L("钱包已改变，请重新核对。", "Wallet changed. Please check again."),
      );
    setPending(result.record);
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
    const target = modal,
      context = walletEpoch.current,
      revision = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (!wallet || !account || !config)
        throw new Error(L("请先连接钱包。", "Connect your wallet first."));
      const result = await prepareProductAction({
        provider: wallet,
        config,
        account,
        pool: modal.pool?.pool,
        kind: modal.kind,
        quantity,
        price,
        proposalId: modal.proposalId,
        support: modal.support,
        orderId: modal.orderId,
      });
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
    if (result.status === "idle") {
      setPending(null);
      setMessage(L("没有待核对的交易。", "No pending transaction."));
      return;
    }
    if (result.status === "pending") {
      let saved = result.record;
      try {
        saved = (await readPending({ account, config })).record ?? saved;
      } catch {}
      if (context !== walletEpoch.current) return;
      setPending(saved);
      setRecoveryHash(
        result.hash || saved?.recoveryHashes?.at(-1) || saved?.hash || "",
      );
      const fallback = result.hash
        ? L(
            "交易已提交，等待最终确认。请稍后核对结果。",
            "Transaction submitted. Check its final outcome shortly.",
          )
        : L(
            "发送结果待核对。请检查钱包记录，不要重复发送。",
            "The submission outcome needs checking. Review your wallet history; do not send again.",
          );
      setMessage(locale === "zh" && result.message ? result.message : fallback);
      setModal(null);
      return;
    }
    setPending(null);
    setRecoveryHash("");
    setPrepared(null);
    setModal(null);
    setRefresh((v) => v + 1);
    setMessage(
      result.status === "confirmed"
        ? L("交易已在链上确认。", "Transaction confirmed on chain.")
        : L(
            "交易未完成原操作，已核对最终结果。",
            "The original action did not complete. Its final outcome has been checked.",
          ),
    );
    const deposit = result.action === "deposit" ? result : null;
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
        const snapshot = await readPoolSnapshot(wallet, {
          factory: config.factory,
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
  async function submit() {
    if (!prepared || prepared.forModal !== modal) return;
    setBusy(true);
    setError("");
    const requestEpoch = walletEpoch.current,
      owner = account;
    try {
      await connectJournal();
      const result = await sendProductTransaction({
        provider: wallet,
        config,
        transaction: prepared.transaction,
        action: { kind: prepared.kind },
        onState: (state) =>
          requestEpoch === walletEpoch.current &&
          setMessage(
            typeof state === "string"
              ? state
              : L("正在核对交易…", "Checking transaction…"),
          ),
      });
      if (requestEpoch === walletEpoch.current)
        await handleResult(result, requestEpoch);
    } catch (e) {
      if (requestEpoch === walletEpoch.current) setError(textError(e));
      try {
        const state = await readPending({ account: owner, config });
        if (requestEpoch === walletEpoch.current) setPending(state.record);
      } catch {}
    } finally {
      setBusy(false);
    }
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
  async function more(kind) {
    const revision = epoch.current;
    setBusy(true);
    setError("");
    try {
      if (kind === "pools") {
        const result = await client.readPools({
          account: account || ZeroAddress,
          cursor: poolCursor,
          source,
        });
        if (revision !== epoch.current) return;
        setPools((old) => [...old, ...result.items.map(viewPool)]);
        setPoolCursor(result.nextCursor);
      } else if (kind === "positions") {
        const result = await client.readPositions({
          account,
          cursor: positionCursor,
          source,
        });
        if (revision !== epoch.current) return;
        setPositions((old) => [...old, ...result.items.map(viewPool)]);
        setPositionCursor(result.nextCursor);
      } else if (kind === "orders") {
        const result = await client.readOrders({
          ...(marketTab === "mine" ? { seller: account } : { active: true }),
          cursor: orderCursor,
          source,
        });
        if (revision !== epoch.current) return;
        setOrders((old) => [...old, ...result.items]);
        setOrderCursor(result.nextCursor);
      } else {
        const result = await client.readActivity({
          pool: route.route === "detail" ? route.pool : undefined,
          account: ["overview", "rewards"].includes(route.route)
            ? account
            : undefined,
          cursor: activityCursor,
          source,
        });
        if (revision !== epoch.current) return;
        setActivity((old) => [...old, ...result.items]);
        setActivityCursor(result.nextCursor);
      }
    } catch (e) {
      setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
  async function readMembers() {
    if (!client || !detail || !source) return;
    const revision = epoch.current;
    setBusy(true);
    try {
      const block = `0x${BigInt(source.indexedThrough).toString(16)}`;
      const result = await client.provider.request({
        method: "eth_call",
        params: [
          {
            to: detail.pool,
            data: abi.PoolVault.encodeFunctionData("activeMembers"),
          },
          block,
        ],
      });
      const addresses = abi.PoolVault.decodeFunctionResult(
        "activeMembers",
        result,
      )[0];
      if (addresses.length > 100) throw new Error("Unexpected holder count");
      if (revision === epoch.current) setMembers(addresses);
    } catch (e) {
      if (revision === epoch.current) setError(textError(e));
    } finally {
      setBusy(false);
    }
  }
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
    <Button
      secondary
      onClick={() => setRefresh((v) => v + 1)}
      disabled={loading || busy}
    >
      <RefreshCw size={16} />
      {L("刷新", "Refresh")}
    </Button>
  );
  const claimable = positionsLoaded
      ? sumKnown(positions, "claimableBEM")
      : null,
    poolBnb = positionsLoaded ? sumKnown(positions, "bnbOwed") : null;
  const filtered = pools
    .filter(
      (p) =>
        (filter === "all" ||
          p.status === filter ||
          (filter === "Funding" && p.status === "Funded")) &&
        `${p.name} ${p.tokenId} ${p.pool}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "price"
        ? compare(a.unitPriceWei, b.unitPriceWei)
        : sort === "id"
          ? compareToken(a.tokenId, b.tokenId)
          : (b.funded ?? -1) - (a.funded ?? -1),
    );
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
        <Button secondary disabled={busy} onClick={() => more(kind)}>
          {L("加载更多", "Load more")}
        </Button>
      </div>
    ) : null;
  const poolTable = (rows, holdings = false) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{L("矿机 / 项目", "Miner / pool")}</th>
            <th>{L("状态", "Status")}</th>
            <th>
              {holdings ? L("我的份额", "My shares") : L("已募集", "Funded")}
            </th>
            <th>{L("每份金额", "Price per share")}</th>
            <th>{L("预计日产 BEM", "Estimated BEM / day")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.pool}>
              <td>
                <button className="asset-cell" onClick={() => openDetails(p)}>
                  <Chip pool={p} />
                  <span>
                    <strong>
                      {p.name} #{p.tokenId}
                    </strong>
                    <small>{shortAddress(p.pool)}</small>
                  </span>
                </button>
              </td>
              <td>
                <StateBadge state={p.status} L={L} />
              </td>
              <td>
                {holdings ? (p.shares?.toString() ?? "—") : (p.funded ?? "—")} /
                100
              </td>
              <td className="num">{amount(p.unitPriceWei)} BNB</td>
              <td>—</td>
              <td>
                <button className="text-button" onClick={() => openDetails(p)}>
                  {L("查看矿机", "View miner")}
                  <ArrowRight size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <Empty
          title={
            loading
              ? L("正在读取项目…", "Loading projects…")
              : L("暂无匹配项目", "No matching pools")
          }
        />
      )}
    </div>
  );
  const activityTable = () => (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{L("区块", "Block")}</th>
              <th>{L("类型", "Event")}</th>
              <th>{L("合约", "Contract")}</th>
              <th>{L("链上记录", "Transaction")}</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((row, i) => {
              const hash = row.transactionHash ?? row.txHash;
              return (
                <tr key={`${hash}-${row.logIndex ?? i}`}>
                  <td>{row.blockNumber}</td>
                  <td>{eventName(row.event ?? row.name, L)}</td>
                  <td>
                    {shortAddress(row.contract ?? row.address ?? row.pool)}
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
        {!activity.length && (
          <Empty title={L("暂无已确认记录", "No confirmed records")} />
        )}
      </div>
      {moreButton(activityCursor, "activity")}
    </>
  );
  function renderGovernance() {
    const g = governance;
    if (!g)
      return (
        <Empty
          title={L("治理信息暂不可用", "Governance information unavailable")}
        />
      );
    return (
      <section className="panel live-governance">
        <div className="section-head">
          <h2>{L("共同决定整机出售", "Decide the miner’s sale together")}</h2>
        </div>
        {g.activeProposalId != null && g.activeProposalId > 0n && g.proposal ? (
          <>
            <h3>
              {L("提案", "Proposal")} #{g.activeProposalId.toString()}
            </h3>
            <div className="proposal-prices">
              <div>
                <span>{L("拟售价格", "Proposed price")}</span>
                <strong>
                  {amount(g.proposal.price)} <small>BNB</small>
                </strong>
              </div>
              <div>
                <span>{L("份额赞成 / 门槛", "Share votes / threshold")}</span>
                <strong>
                  {g.proposal.yesShares?.toString() ?? "—"} /{" "}
                  {g.requiredYesShares?.toString() ?? "—"}
                </strong>
              </div>
              <div>
                <span>{L("地址赞成 / 门槛", "Wallet votes / threshold")}</span>
                <strong>
                  {g.proposal.yesCount?.toString() ?? "—"} /{" "}
                  {g.requiredYesCount?.toString() ?? "—"}
                </strong>
              </div>
            </div>
            <p>
              {L("投票及执行截止", "Voting and execution deadline")}：
              {date(g.proposal.endsAt)}
            </p>
            <div className="live-actions">
              <Button
                disabled={!account || g.canVote !== true || busy}
                onClick={() =>
                  openAction("vote", detail, {
                    proposalId: g.activeProposalId.toString(),
                    support: true,
                  })
                }
              >
                {L("赞成出售", "Vote yes")}
              </Button>
              <Button
                secondary
                disabled={!account || g.canVote !== true || busy}
                onClick={() =>
                  openAction("vote", detail, {
                    proposalId: g.activeProposalId.toString(),
                    support: false,
                  })
                }
              >
                {L("反对出售", "Vote no")}
              </Button>
              <Button
                secondary
                disabled={!account || g.canExecute !== true || busy}
                onClick={() =>
                  openAction("executeSale", detail, {
                    proposalId: g.activeProposalId.toString(),
                  })
                }
              >
                {L("执行挂牌", "Execute listing")}
              </Button>
            </div>
          </>
        ) : (
          <p>
            {g.activeProposalId === 0n
              ? L("目前没有出售提案。", "No sale proposal yet.")
              : L(
                  "提案状态待核对，请刷新后查看。",
                  "Proposal status is unavailable. Refresh to check again.",
                )}
          </p>
        )}
        <div className="live-actions">
          <Button
            secondary
            disabled={
              !account || !detail?.shares || detail.status !== "Active" || busy
            }
            onClick={() => openAction("propose", detail)}
          >
            {L("发起出售提案", "Propose a sale")}
          </Button>
          {g.canCancelExpired === true && (
            <Button
              secondary
              disabled={!account || busy}
              onClick={() => openAction("cancelExpired", detail)}
            >
              {L("解除到期挂牌", "Clear expired listing")}
            </Button>
          )}
        </div>
        <p className="subtle-note">
          {L(
            "购机满 7 天后可提案。价格低于购机成本时须至少 60 份赞成，其他价格须超过 50 份；均须赞成地址数过半。",
            "Proposals open 7 days after purchase. Below-cost sales need at least 60 shares; other sales need more than 50. Both require a majority of holder addresses.",
          )}
        </p>
      </section>
    );
  }

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
              className={`nav-item ${route.route === id || (id === "pools" && route.route === "detail") ? "active" : ""}`}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              {L(zh, en)}
            </button>
          ))}
        </nav>
        <div className="nav-divider" />
        <div className="nav-caption">{L("更多服务", "MORE SERVICES")}</div>
        <button
          className="nav-item muted-nav"
          onClick={() => setModal({ type: "future" })}
        >
          <LockKeyhole size={19} />
          {L("矿机质押", "Miner collateral")}
          <em>{L("筹备中", "Coming soon")}</em>
        </button>
        <button
          className="nav-item muted-nav"
          onClick={() => setModal({ type: "future" })}
        >
          <ShieldCheck size={19} />
          {L("最优质保", "Quality assurance")}
          <em>{L("筹备中", "Coming soon")}</em>
        </button>
        <div className="side-bottom">
          <button
            className="rules-link"
            onClick={() => setModal({ type: "rules" })}
          >
            <BookOpen size={17} />
            {L("平台规则", "Platform rules")}
            <ArrowUpRight size={14} />
          </button>
          {deploymentConsoleUrl && (
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
              {route.route === "detail"
                ? L("矿机详情", "Miner details")
                : L(
                    ...(navigation
                      .find((x) => x[0] === route.route)
                      ?.slice(1, 3) || ["拼矿", "BEMine"]),
                  )}
            </strong>
          </div>
          <div className="top-actions">
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
            <select
              className="language-switch"
              aria-label="Language"
              value={locale}
              onChange={(e) => setLocale(e.target.value)}
            >
              <option value="zh">简体中文</option>
              <option value="en">English</option>
            </select>
            <Button
              disabled={busy || boot.status !== "ready"}
              onClick={() =>
                account ? setModal({ type: "wallet" }) : connect()
              }
            >
              <Wallet size={17} />
              {account
                ? shortAddress(account)
                : L("连接钱包", "Connect wallet")}
              <ChevronDown size={14} />
            </Button>
          </div>
        </header>
        <main aria-busy={loading} data-ready-route={loadedRoute}>
          {boot.status !== "ready" && (
            <div className="live-service-note" role="status">
              <ShieldCheck size={20} />
              <div>
                <strong>
                  {boot.status === "loading"
                    ? L("正在连接拼矿…", "Connecting to BEMine…")
                    : L("拼矿即将开放", "BEMine is coming soon")}
                </strong>
                <p>
                  {L(
                    "项目开放后，你可以在这里查看矿机、共同出资并分享邀请。",
                    "When pools open, explore miners, subscribe and invite friends here.",
                  )}
                </p>
              </div>
              <a
                className="text-button"
                href={`${basePath}/preview${process.env.NODE_ENV === "production" ? ".html" : ""}`}
              >
                {L("浏览页面预览", "Explore the preview")}
                <ArrowUpRight size={16} />
              </a>
            </div>
          )}
          {error && (
            <div className="live-notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                aria-label={L("关闭提示", "Dismiss")}
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {message && (
            <div className="live-notice" role="status">
              <CheckCircle2 size={18} />
              <span>{message}</span>
              <button
                aria-label={L("关闭提示", "Dismiss")}
                onClick={() => setMessage("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
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
            </section>
          )}
          {route.route === "home" && (
            <SiteOverview
              pools={pools}
              live
              liveStats={stats}
              liveSource={source}
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
          {route.route === "overview" && account && (
            <>
              {heading(
                L("资产总览", "My portfolio"),
                L(
                  "查看持仓、已入账收益与待领取款项。",
                  "Your positions, booked rewards and available proceeds.",
                ),
                refreshButton,
              )}
              <div className="metrics">
                <Metric
                  primary
                  title={L("当前可领取", "Claimable BEM")}
                  value={amount(claimable, 8)}
                  unit="BEM"
                  note={L("本页矿池 · 已入账", "Loaded pools · booked rewards")}
                />
                <Metric
                  title={L("矿池待领取", "Pool proceeds")}
                  value={amount(poolBnb)}
                  unit="BNB"
                  note={L(
                    "包含余款与售款，不重复计数",
                    "Includes surplus and sale proceeds once",
                  )}
                />
                <Metric
                  title={L("持有矿机", "Miners held")}
                  value={
                    positionsLoaded && positions.every((p) => p.shares != null)
                      ? positions.filter((p) => p.shares > 0n).length
                      : "—"
                  }
                  unit={L("台", "miners")}
                  note={L("本页持仓", "Loaded positions")}
                />
                <Metric
                  title={L("持有份额", "Shares held")}
                  value={
                    positionsLoaded
                      ? (sumKnown(positions, "shares")?.toString() ?? "—")
                      : "—"
                  }
                  unit={L("份", "shares")}
                  note={L(
                    "已售完份额的历史权益仍可领取",
                    "Former holders can still claim owed rewards",
                  )}
                />
              </div>
              <section className="panel holdings">
                <div className="section-head">
                  <div>
                    <h2>{L("我的矿机与权益", "My miners and entitlements")}</h2>
                    <p>
                      {L(
                        "包含清仓后仍有待领取款项的项目。",
                        "Includes former positions with outstanding balances.",
                      )}
                    </p>
                  </div>
                </div>
                {poolTable(positions, true)}
                {moreButton(positionCursor, "positions")}
              </section>
              <section className="panel live-section">
                <div className="section-head">
                  <h2>{L("最近链上记录", "Recent on-chain activity")}</h2>
                </div>
                {activityTable()}
              </section>
            </>
          )}
          {route.route === "pools" && (
            <>
              {heading(
                L("参与拼矿", "Join a pool"),
                L(
                  "从一份开始，共持 BEM 矿机。",
                  "Start with one share. Own BEM miners together.",
                ),
                refreshButton,
              )}
              <div className="live-project-summary">
                {["Funding", "Active", "Listed"].map((status) => (
                  <button
                    key={status}
                    className={filter === status ? "selected" : ""}
                    onClick={() => setFilter(status)}
                  >
                    <span>{L(...statuses[status])}</span>
                    <strong>
                      {source &&
                      !loading &&
                      pools.every((p) => p.status !== "Unknown")
                        ? pools.filter((p) => p.status === status).length
                        : "—"}
                    </strong>
                    <small>{L("已加载项目", "loaded pools")}</small>
                  </button>
                ))}
              </div>
              <section className="panel">
                <div className="live-toolbar">
                  <div className="tabs">
                    {[
                      ["all", "项目总览", "Overview"],
                      ["Funding", "募集中", "Funding"],
                      ["Active", "挖矿中", "Operating"],
                      ["Listed", "整机出售中", "For sale"],
                    ].map(([id, zh, en]) => (
                      <button
                        key={id}
                        className={filter === id ? "selected" : ""}
                        onClick={() => setFilter(id)}
                      >
                        {L(zh, en)}
                      </button>
                    ))}
                  </div>
                  <div className="live-search">
                    <Search size={17} />
                    <input
                      aria-label={L(
                        "搜索矿机或地址",
                        "Search miner or address",
                      )}
                      placeholder={L(
                        "矿机编号 / 项目地址",
                        "Miner ID / pool address",
                      )}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <Button
                    secondary
                    onClick={() => setFiltersOpen((v) => !v)}
                    aria-expanded={filtersOpen}
                  >
                    <SlidersHorizontal size={16} />
                    {L("筛选排序", "Sort & filter")}
                  </Button>
                </div>
                {filtersOpen && (
                  <div className="live-filters">
                    <label>
                      {L("排序", "Sort")}
                      <select
                        value={sort}
                        onChange={(e) => setSort(e.target.value)}
                      >
                        <option value="funded">
                          {L("募集份额最多", "Most shares funded")}
                        </option>
                        <option value="price">
                          {L("每份金额从低到高", "Lowest price per share")}
                        </option>
                        <option value="id">
                          {L("矿机编号从低到高", "Lowest miner ID")}
                        </option>
                      </select>
                    </label>
                    <small>
                      {L(
                        "搜索与排序作用于已加载项目。",
                        "Search and sort apply to loaded pools.",
                      )}
                    </small>
                  </div>
                )}
                {poolTable(filtered)}
                {moreButton(poolCursor, "pools")}
              </section>
            </>
          )}
          {route.route === "detail" &&
            (route.invalid ? (
              <Empty title={L("项目链接无效", "Invalid project link")}>
                {L(
                  "请返回项目大厅重新选择矿机。",
                  "Please choose a miner from the pool directory.",
                )}
              </Empty>
            ) : !detail ? (
              <Empty
                title={
                  loading
                    ? L("正在核对矿机信息…", "Checking miner information…")
                    : L("暂时无法读取该项目", "This project is unavailable")
                }
              >
                {L(
                  "项目开放并完成链上核对后，才能参与认购。",
                  "Subscription is available once the project is open and verified.",
                )}
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
                          {L("预计日产", "Estimated daily output")}：— BEM
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
                            if (key === "members") void readMembers();
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
                              disabled={!account || busy}
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
                                disabled={busy}
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
                        {members.length ? (
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
                        ) : (
                          <Empty
                            title={L(
                              "暂无可显示的持有人地址",
                              "No holder addresses to show",
                            )}
                          />
                        )}
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
                      {amount(detail.unitPriceWei)}{" "}
                      <small>BNB / {L("份", "share")}</small>
                    </div>
                    <p className="order-rule purchase-explanation">
                      {L(
                        "每份对应本池 1% 的份额。",
                        "Each share represents 1% of this pool.",
                      )}
                    </p>
                    <p className="order-rule purchase-explanation">
                      {L(
                        "为确保购机成功，用户会按矿机出售价格额外预付 10%；购机成功后余款按照份额等比退还",
                        "To help complete the miner purchase, subscribers prepay an extra 10% of its sale price. After a successful purchase, the remaining funds are refunded in proportion to their shares.",
                      )}
                    </p>
                    {detail.status === "Funding" ? (
                      <>
                        <div className="ownership">
                          <span>{L("剩余可认购", "Remaining")}</span>
                          <strong>
                            {detail.remaining ?? "—"} {L("份", "shares")}
                          </strong>
                        </div>
                        <Button
                          disabled={
                            busy ||
                            !detail.trusted ||
                            detail.depositPaused !== false ||
                            detail.remaining === null ||
                            detail.remaining <= 0
                          }
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
                          <span>{L("整机售价", "Miner sale price")}</span>
                          <strong>{amount(governance?.salePrice)} BNB</strong>
                        </div>
                        <Button
                          disabled={
                            busy || !account || governance?.salePrice == null
                          }
                          onClick={() => openAction("completeSale", detail)}
                        >
                          {L("购买整台矿机", "Buy this miner")}
                        </Button>
                      </>
                    ) : (
                      <div className="ownership">
                        <span>{L("当前状态", "Current status")}</span>
                        <StateBadge state={detail.status} L={L} />
                      </div>
                    )}
                    <div className="ownership">
                      <span>{L("我的持仓", "My shares")}</span>
                      <strong>
                        {account ? (detail.shares?.toString() ?? "—") : "—"}{" "}
                        {L("份", "shares")}
                      </strong>
                    </div>
                    <div className="live-actions live-actions-stack">
                      <Button
                        secondary
                        disabled={!account || busy || !detail.claimableBEM}
                        onClick={() => openAction("claim", detail)}
                      >
                        {L("领取", "Claim")}{" "}
                        {amount(account ? detail.claimableBEM : null, 8)} BEM
                      </Button>
                      <Button
                        secondary
                        disabled={!account || busy || !detail.bnbOwed}
                        onClick={() => openAction("withdrawBnb", detail)}
                      >
                        {L("领取", "Claim")}{" "}
                        {amount(account ? detail.bnbOwed : null)} BNB
                      </Button>
                      {detail.status === "Active" && (
                        <Button
                          secondary
                          disabled={
                            !account ||
                            busy ||
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
                  title={L("可领取 BEM", "Claimable BEM")}
                  value={amount(claimable, 8)}
                  unit="BEM"
                  note={L(
                    "已加载矿池 · 不含待归集",
                    "Loaded pools · excludes uncollected output",
                  )}
                />
                <Metric
                  title={L("矿池 BNB", "Pool BNB")}
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
                      disabled={!marketCredit || busy}
                      onClick={() => openAction("marketWithdraw", null)}
                    >
                      {L("领取市场款项", "Withdraw market proceeds")}
                    </button>
                  }
                />
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
                                disabled={busy || !p.claimableBEM}
                                onClick={() => openAction("claim", p)}
                              >
                                {L("领 BEM", "Claim BEM")}
                              </Button>
                              <Button
                                secondary
                                disabled={busy || !p.bnbOwed}
                                onClick={() => openAction("withdrawBnb", p)}
                              >
                                {L("领 BNB", "Claim BNB")}
                              </Button>
                              <Button
                                secondary
                                disabled={
                                  busy ||
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
                    <Empty title={L("暂无可领取项目", "No claimable pools")} />
                  )}
                </div>
                {moreButton(positionCursor, "positions")}
              </section>
              <section className="panel live-section">
                <div className="section-head">
                  <h2>{L("已确认收益记录", "Confirmed reward activity")}</h2>
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
                  "按链上有效订单买卖份额，也可购买挂牌整机。",
                  "Trade valid share orders or purchase a listed miner.",
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
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{L("项目", "Pool")}</th>
                          <th>{L("剩余份额", "Remaining")}</th>
                          <th>{L("每份单价", "Per share")}</th>
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
                            <td>{amount(o.pricePerUnitWei)} BNB</td>
                            <td>{shortAddress(o.seller)}</td>
                            <td>
                              {date(o.expiresAt)}
                              {o.active !== true ? (
                                <small className="live-order-state">
                                  {L("已结束", "Closed")}
                                </small>
                              ) : o.expiresAt <=
                                BigInt(source?.indexedTimestamp ?? 0) ? (
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
                                disabled={
                                  !account ||
                                  busy ||
                                  o.active !== true ||
                                  (!same(o.seller, account) &&
                                    o.shareTradingAllowed !== true)
                                }
                                onClick={() =>
                                  openAction(
                                    same(o.seller, account)
                                      ? o.expiresAt <=
                                        BigInt(source?.indexedTimestamp ?? 0)
                                        ? "expire"
                                        : "cancel"
                                      : "fill",
                                    { pool: o.pool },
                                    { orderId: (o.id ?? o.orderId).toString() },
                                  )
                                }
                              >
                                {same(o.seller, account)
                                  ? o.expiresAt <=
                                    BigInt(source?.indexedTimestamp ?? 0)
                                    ? L("解锁份额", "Unlock shares")
                                    : L("撤单", "Cancel")
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
                          loading
                            ? L("正在读取订单…", "Loading orders…")
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
                  {moreButton(orderCursor, "orders")}
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
                  poolTable(positions.filter((p) => p.status === "Active"), true)
                ) : (
                  <Empty
                    title={L(
                      "连接钱包查看可售份额",
                      "Connect your wallet to see shares available to sell",
                    )}
                  />
                )}
              </section>
            </>
          )}
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
                    title={L(
                      "暂无可显示的矿机决策",
                      "No miner decisions to show",
                    )}
                  />
                )}
              </section>
              {moreButton(
                account ? positionCursor : poolCursor,
                account ? "positions" : "pools",
              )}
            </>
          )}
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
            <span>
              {source
                ? L("数据区块", "Data block") +
                  ` ${source.indexedBlock ?? source.indexedThrough ?? source.blockNumber ?? "—"}`
                : L("等待项目开放", "Awaiting launch")}
            </span>
          </footer>
        </main>
      </div>
      {modal && (
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
            className={`modal live-modal${modal.type === "share" ? " live-share-modal" : ""}`}
            ref={modalRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="live-dialog-title"
          >
            {modal.type !== "share" && (
              <button
                className="modal-close icon-button"
                disabled={busy}
                aria-label={L("关闭弹窗", "Close dialog")}
                onClick={() => {
                  setModal(null);
                  setPrepared(null);
                }}
              >
                <X size={21} />
              </button>
            )}
            {modal.type === "share" ? (
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
                <p className="live-wrap">{account}</p>
                <div className="live-actions">
                  <Button disabled={busy} onClick={inspectPending}>
                    {L("核对待处理交易", "Check pending transactions")}
                  </Button>
                  <Button
                    secondary
                    disabled={busy}
                    onClick={() => {
                      epoch.current++;
                      walletEpoch.current++;
                      setAccount(null);
                      setWallet(null);
                      setPending(null);
                      setPositions([]);
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
                    "矿机质押与最优质保暂未开放。开放后将在这里公布适用范围和参与规则。",
                    "Miner collateral and quality assurance are not open yet. Eligibility and terms will be published here.",
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
                      "整机出售须地址多数，低于购机成本需至少 60 份赞成，其余超过 50 份。",
                      "Miner sales require a wallet majority and at least 60 shares below acquisition cost, otherwise more than 50.",
                    ],
                    [
                      "灵活转让",
                      "Trade shares",
                      "份额与整机交易各收取 1% 平台费。份额挂单 7 天到期，表决期间暂停新挂单与成交。",
                      "Share and miner sales have a 1% platform fee. Share orders expire after 7 days; new orders and fills pause during voting.",
                    ],
                  ].map(([zh, en, desc, eng]) => (
                    <p key={zh}>
                      <b>{L(zh, en)}</b>
                      {L(desc, eng)}
                    </p>
                  ))}
                </div>
              </>
            ) : (
              modal.type === "action" && (
                <>
                  <h2 id="live-dialog-title">{actionLabel(modal.kind)}</h2>
                  <p>
                    {modal.pool?.name
                      ? `${modal.pool.name} #${modal.pool.tokenId}`
                      : shortAddress(modal.pool?.pool ?? config?.shareMarket)}
                  </p>
                  {!account ? (
                    <Button disabled={busy} onClick={connect}>
                      {L("连接钱包", "Connect wallet")}
                    </Button>
                  ) : (
                    <>
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
                            placeholder="0.00"
                          />
                        </label>
                      )}
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
                            <div>
                              <span>{L("支付金额", "Payment")}</span>
                              <strong>
                                {amount(
                                  BigInt(prepared.transaction.value),
                                  18,
                                  18,
                                )}{" "}
                                BNB
                              </strong>
                            </div>
                            <div>
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
                            </div>
                          </div>
                          <p className="inline-note">
                            {L(
                              "Gas 以钱包显示为准。请核对金额后在钱包确认；交易确认前不会显示认购成功。",
                              "Gas is shown by your wallet. Check the amount before confirming. A subscription is only successful after on-chain confirmation.",
                            )}
                          </p>
                          <div className="live-actions">
                            <Button
                              disabled={busy || !!pending}
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
                        <Button disabled={busy || !!pending} onClick={prepare}>
                          {busy
                            ? L("正在核对…", "Checking…")
                            : L("核对交易金额", "Review transaction")}
                        </Button>
                      )}
                      <p className="subtle-note">
                        {L(
                          "首次操作会请你签署钱包登录消息，用于保存和恢复本人的交易记录。",
                          "Your first action asks you to sign a wallet login message to save and recover your transaction records.",
                        )}
                      </p>
                    </>
                  )}
                </>
              )
            )}
            {error && (
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
  if (a == null) return 1;
  if (b == null) return -1;
  return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
}
function compareToken(a, b) {
  return /^\d+$/.test(a) && /^\d+$/.test(b)
    ? compare(BigInt(a), BigInt(b))
    : String(a).localeCompare(String(b));
}
function eventName(value, L) {
  const map = {
    Deposited: ["份额认购", "Subscription"],
    Harvested: ["收益归集", "Output collected"],
    BemClaimed: ["BEM 领取", "BEM claimed"],
    BnbWithdrawn: ["BNB 领取", "BNB withdrawn"],
    Purchased: ["矿机购入", "Miner purchased"],
    OrderListed: ["份额挂单", "Shares listed"],
    OrderFilled: ["份额成交", "Shares traded"],
    SaleProposed: ["出售提案", "Sale proposed"],
    Voted: ["表决", "Vote"],
    SaleCompleted: ["整机成交", "Miner sold"],
    Transfer: ["份额变更", "Share transfer"],
  };
  return map[value] ? L(...map[value]) : (value ?? "—");
}
