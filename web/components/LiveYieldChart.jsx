import { amount } from "../lib/live-view.mjs";

export default function LiveYieldChart({ data, locale, days, onDays }) {
  const L = (zh, en) => (locale === "en" ? en : zh);
  const rows = data?.buckets ?? [],
    maximum = rows.reduce(
      (n, r) => (r.poolHarvestNetAtomic > n ? r.poolHarvestNetAtomic : n),
      1n,
    );
  const total = data
    ? rows.reduce((n, r) => n + r.poolHarvestNetAtomic, 0n)
    : null;
  const claimed = data?.account
    ? rows.reduce((n, r) => n + (r.accountClaimedAtomic ?? 0n), 0n)
    : null;
  return (
    <section className="panel live-yield">
      <div className="section-head">
        <div>
          <h2>{L("矿池收益归集", "Output collected into the pool")}</h2>
          <p>
            {L(
              "已归集、扣除平台费用的 BEM；按实际交易日期统计。",
              "BEM collected after platform fees, grouped by transaction date.",
            )}
          </p>
        </div>
        <div className="segmented">
          {[7, 30].map((n) => (
            <button
              className={days === n ? "active" : ""}
              key={n}
              onClick={() => onDays(n)}
            >
              {n}D
            </button>
          ))}
        </div>
      </div>
      <div className="chart-summary">
        <div>
          <span>{L("本期归集", "Collected in this period")}</span>
          <strong>
            {amount(total, 8, 8)} <small>BEM</small>
          </strong>
        </div>
        {data?.account && (
          <div>
            <span>{L("本人实际领取", "Personally claimed")}</span>
            <strong>
              {amount(claimed, 8, 8)} <small>BEM</small>
            </strong>
          </div>
        )}
      </div>
      {data ? (
        <div
          className="live-yield-bars"
          role="img"
          aria-label={L(
            `本期矿池归集 ${amount(total, 8, 8)} BEM，${days} 天`,
            `Pool collected ${amount(total, 8, 8)} BEM over ${days} days`,
          )}
        >
          {rows.map((row) => (
            <div
              className="live-yield-column"
              key={row.date}
              title={`${row.date}: ${amount(row.poolHarvestNetAtomic, 8, 8)} BEM`}
            >
              <span
                style={{
                  height: `${Number((row.poolHarvestNetAtomic * 10000n) / maximum) / 100}%`,
                  minHeight: row.poolHarvestNetAtomic > 0n ? "3px" : "0",
                }}
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="live-yield-empty">
          {L("暂无可核对的收益趋势", "Verified yield history is unavailable")}
        </p>
      )}
      <div className="live-yield-axis">
        <span>{rows[0]?.date ?? "—"}</span>
        <span>UTC+8</span>
        <span>{rows.at(-1)?.date ?? "—"}</span>
      </div>
      <p className="chart-foot">
        {L(
          "归集金额不等于当日产能。个人未领取权益以矿池当前记录为准。",
          "Collected amounts are not daily mining estimates. Your unclaimed entitlement is the current pool balance.",
        )}
      </p>
    </section>
  );
}
