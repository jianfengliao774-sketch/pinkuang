import { amount } from "../lib/live-view.mjs";
import { yieldChartModel } from "../lib/yield-history.mjs";

export default function LiveYieldChart({ data, locale, days = 7, onDays, loading = false, error = '', stale = false }) {
  const L = (zh, en) => (locale === "en" ? en : zh);
  const portfolio = data?.scope === 'portfolio';
  const model = yieldChartModel(data), rows = model?.rows ?? [],
    maximum = model?.maximum ?? 1n, total = model?.total ?? null, claimed = model?.claimed ?? null;
  const shownDays = model?.days ?? days, switching = !!model && shownDays !== days;
  return (
    <section className="panel live-yield" aria-busy={loading}>
      <div className="section-head">
        <div>
          <h2>{portfolio ? L("项目收益归集", "Output collected into the portfolio") : L("矿池收益归集", "Output collected into the pool")}</h2>
          <p>
            {portfolio ? L(
              "仅统计实际进入本项目的 BEM，不重复累加子矿池归集；按实际交易日期统计。",
              "BEM actually received by this portfolio, grouped by transaction date; child-pool collections are not added again.",
            ) : L(
              "已归集、扣除平台费用的 BEM；按实际交易日期统计。",
              "BEM collected after platform fees, grouped by transaction date.",
            )}
          </p>
        </div>
        <div className="segmented" role="group" aria-label={L("收益时间范围", "Yield period")}>
          {[7, 30].map((n) => (
            <button
              type="button"
              className={Number(days) === n ? "selected" : ""}
              aria-pressed={Number(days) === n}
              key={n}
              onClick={() => onDays?.(n)}
            >
              {n}D
            </button>
          ))}
        </div>
      </div>
      {error && <p className="live-yield-status error" role="alert">
        {model ? L("收益更新失败，已保留上次读取的数据。", "Yield refresh failed; previously loaded data is retained.")
          : L("收益暂时读取失败，请重试。", "Yield could not be loaded. Please retry.")} {error}
      </p>}
      {!error && (loading || switching || stale) && <p className="live-yield-status" role="status">
        {loading || switching ? (model
          ? L(`正在读取近 ${days} 天收益；暂显示已加载的 ${shownDays} 天数据。`, `Loading ${days} days; showing the loaded ${shownDays}-day history.`)
          : L("正在读取收益…", "Loading yield…"))
          : L("当前显示上次读取的收益数据。", "Showing previously loaded yield data.")}
      </p>}
      <div className="chart-summary">
        <div>
          <span>{L("本期归集", "Collected in this period")}</span>
          <strong>
            {amount(total, 8)} <small>BEM</small>
          </strong>
        </div>
        {data?.account && (
          <div>
            <span>{L("本人实际领取", "Personally claimed")}</span>
            <strong>
              {amount(claimed, 8)} <small>BEM</small>
            </strong>
          </div>
        )}
      </div>
      {model ? (
        <div className="live-yield-plot">
        <div
          className="live-yield-bars"
          role="img"
          aria-label={portfolio ? L(
            `本期项目归集 ${amount(total, 8)} BEM，${shownDays} 天`,
            `Portfolio collected ${amount(total, 8)} BEM over ${shownDays} days`,
          ) : L(
            `本期矿池归集 ${amount(total, 8)} BEM，${shownDays} 天`,
            `Pool collected ${amount(total, 8)} BEM over ${shownDays} days`,
          )}
        >
          {rows.map((row) => (
            <div
              className="live-yield-column"
              key={row.date}
              title={`${row.date}: ${amount(row.poolHarvestNetAtomic, 8)} BEM`}
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
        {model.empty && <p className="live-yield-zero">
          {L(`近 ${shownDays} 天暂无收益归集`, `No yield collected in these ${shownDays} days`)}
        </p>}
        </div>
      ) : (
        <p className="live-yield-empty">
          {loading ? L("正在读取收益…", "Loading yield…")
            : L("收益数据暂未加载", "Yield history has not loaded")}
        </p>
      )}
      <div className="live-yield-axis">
        <span>{rows[0]?.date ?? "—"}</span>
        <span>UTC+8</span>
        <span>{rows.at(-1)?.date ?? "—"}</span>
      </div>
      <p className="chart-foot">
        {portfolio ? L(
          "归集金额不等于当日产能。个人未领取权益以项目当前记录为准。",
          "Collected amounts are not daily mining estimates. Your unclaimed entitlement follows current portfolio records.",
        ) : L(
          "归集金额不等于当日产能。个人未领取权益以矿池当前记录为准。",
          "Collected amounts are not daily mining estimates. Your unclaimed entitlement is the current pool balance.",
        )}
      </p>
    </section>
  );
}
