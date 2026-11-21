"use client";

import type { ReactNode } from "react";
import {
  Ban,
  BarChart3,
  Clock3,
  Package,
  RotateCcw,
  TrendingDown,
  TrendingUp,
  Truck,
  Wallet,
} from "lucide-react";
import { money, type AdvancedAnalytics, type AnalyticsProductRow } from "@/lib/types";

function Panel({ title, subtitle, icon, children }: { title: string; subtitle: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="panel bi-panel">
      <div className="section-heading">
        <div><h3>{title}</h3><p>{subtitle}</p></div>
        <span className="settings-icon">{icon}</span>
      </div>
      {children}
    </section>
  );
}

function MiniStat({ label, value, detail, icon, tone = "blue" }: { label: string; value: string; detail: string; icon: ReactNode; tone?: string }) {
  return (
    <div className="bi-mini-stat">
      <span className={`metric-icon ${tone}`}>{icon}</span>
      <span className="bi-mini-label">{label}</span>
      <strong className="bi-mini-value">{value}</strong>
      <span className="bi-mini-detail">{detail}</span>
    </div>
  );
}

function ProductList({ title, rows, empty }: { title: string; rows: AnalyticsProductRow[]; empty: string }) {
  return (
    <div className="bi-product-list">
      <div className="bi-list-title">{title}</div>
      {rows.length ? rows.map((row) => (
        <div className="bi-product-row" key={`${title}-${row.name}`}>
          <span className="bi-product-name" title={row.name}>{row.name}</span>
          <span className="bi-product-units">{row.unitsSold} sold</span>
          <strong>{money(row.grossSales)}</strong>
        </div>
      )) : <p className="bi-empty-line">{empty}</p>}
    </div>
  );
}

export function BiDashboard({ report }: { report: AdvancedAnalytics }) {
  const maxHour = Math.max(1, ...report.hourly.map((row) => row.grossSales));
  const bestSellers = report.products.slice(0, 5);
  const slowMovers = report.slowMovers;
  const prepRows = report.products
    .filter((row) => row.avgPrepMinutes !== null && row.avgPrepMinutes > 0)
    .sort((a, b) => (b.avgPrepMinutes ?? 0) - (a.avgPrepMinutes ?? 0))
    .slice(0, 6);
  const maxPrep = Math.max(1, ...prepRows.map((row) => row.avgPrepMinutes ?? 0));
  const comparison = report.comparison;

  return (
    <div className="bi-dashboard">
      <div className="bi-today">
        <div className="bi-today-head">
          <div><div className="eyebrow">TODAY AT A GLANCE</div><h2>Today&apos;s performance</h2></div>
          <span className="bi-date-chip">{report.today.date}</span>
        </div>
        <div className="bi-today-grid">
          <MiniStat icon={<Wallet size={19} />} tone="red" label="Today's revenue" value={money(report.today.revenue)} detail="Completed orders placed today" />
          <MiniStat icon={<Package size={19} />} tone="green" label="Completed orders" value={String(report.today.completedOrders)} detail={`${report.today.ordersPlaced} orders placed today`} />
          <MiniStat icon={<BarChart3 size={19} />} tone="blue" label="Average order value" value={money(report.today.averageOrderValue)} detail="Today's completed orders" />
          <MiniStat icon={<TrendingUp size={19} />} tone="amber" label="Completion rate" value={`${report.today.completionRate}%`} detail="Completed ÷ placed today" />
        </div>
      </div>

      <div className="bi-grid">
        <Panel title="Hourly sales" subtitle="Order value by placement hour · India Standard Time" icon={<BarChart3 size={20} />}>
          {report.hourly.length ? (
            <>
              <div className="bi-bar-chart" role="img" aria-label="Order value by hour of day">
                {report.hourly.map((row) => (
                  <div className="bi-bar-slot" key={row.hour} title={`${row.label} · ${money(row.grossSales)} · ${row.orders} orders`}>
                    <div className="bi-bar-track">
                      <div className="bi-bar-fill" style={{ height: `${Math.max(row.grossSales ? 4 : 0, (row.grossSales / maxHour) * 100)}%` }} />
                    </div>
                    <span>{row.hour % 3 === 0 ? row.label.slice(0, 2) : ""}</span>
                  </div>
                ))}
              </div>
              <p className="bi-caption">Peak hour: {money(Math.max(0, ...report.hourly.map((row) => row.grossSales)))} · hover a bar for details</p>
            </>
          ) : <p className="bi-empty-line">No hourly data in this range.</p>}
        </Panel>

        <Panel title="Product movement" subtitle="Best sellers by sales value ┬À slow movers by units sold" icon={<Package size={20} />}>
          {report.products.length || report.slowMovers.length ? (
            <div className="bi-product-columns">
              <ProductList title="Best sellers" rows={bestSellers} empty="" />
              <ProductList title="Slow movers" rows={slowMovers} empty="No active menu items to compare." />
            </div>
          ) : <p className="bi-empty-line">Completed order items will appear here.</p>}
        </Panel>

        <Panel title="Preparation time by item" subtitle="Average selected prep time for orders containing the item" icon={<Clock3 size={20} />}>
          {prepRows.length ? prepRows.map((row) => (
            <div className="bi-prep-row" key={`prep-${row.name}`}>
              <span title={row.name}>{row.name}</span>
              <div className="bi-prep-track"><div style={{ width: `${((row.avgPrepMinutes ?? 0) / maxPrep) * 100}%` }} /></div>
              <strong>{row.avgPrepMinutes} min</strong>
            </div>
          )) : <p className="bi-empty-line">Preparation times are recorded when an order is accepted.</p>}
        </Panel>

        <Panel title="Cancellation reasons" subtitle="Why orders were rejected or cancelled" icon={<Ban size={20} />}>
          {report.cancellations.length ? report.cancellations.slice(0, 8).map((row) => (
            <div className="bi-reason-row" key={row.reason}>
              <span title={row.reason}>{row.reason}</span>
              <strong>{row.orders}</strong>
              <small>{money(row.lostValue)} value</small>
            </div>
          )) : <p className="bi-empty-line">No cancellations in this range.</p>}
        </Panel>

        <Panel title="Customers & delivery" subtitle="Repeat behaviour and fulfilment performance" icon={<RotateCcw size={20} />}>
          <div className="bi-split">
            <div>
              <div className="bi-metric-label">Repeat customer rate</div>
              <strong className="bi-metric-number">{report.repeat.repeatRate}%</strong>
              <p className="bi-caption">{report.repeat.repeatCustomers} of {report.repeat.customers} named customers ordered more than once. {report.repeat.basis}.</p>
            </div>
            <div>
              <div className="bi-metric-label">Fulfilment</div>
              {report.delivery.length ? report.delivery.map((row) => (
                <div className="bi-delivery-row" key={row.label}>
                  <span>{row.label === "Delivery" ? <Truck size={14} /> : <Package size={14} />} {row.label}</span>
                  <strong>{row.completionRate}%</strong>
                  <small>{row.completed}/{row.orders} done · {row.cancelled} cancelled</small>
                </div>
              )) : <p className="bi-caption">No fulfilment data in this range.</p>}
            </div>
          </div>
        </Panel>

        <Panel title="Net proceeds after platform fees" subtitle="After discounts, commissions and refunds" icon={<Wallet size={20} />}>
          <div className="bi-profit-hero">
            <span>Net proceeds</span>
            <strong>{money(report.profitability.netAfterFees)}</strong>
          </div>
          <div className="bi-profit-grid">
            <div><span>Gross sales</span><strong>{money(report.profitability.grossSales)}</strong></div>
            <div><span>Discounts given</span><strong>−{money(report.profitability.discounts)}</strong></div>
            <div><span>Commissions</span><strong>−{money(report.profitability.commission)}</strong></div>
            <div><span>Refunds</span><strong>−{money(report.profitability.refunds)}</strong></div>
            <div><span>Adjustments</span><strong>{money(report.profitability.adjustments)}</strong></div>
            <div><span>Authoritative net paid</span><strong>{money(report.profitability.netPaid)}</strong></div>
          </div>
          <p className="bi-caption">
            Discounts are already reflected in gross sales; commissions and refunds come from {report.profitability.source === "settlements" ? "settled payments" : report.profitability.source === "revenue" ? "Marketplace revenue" : "the selected range"}. This is not restaurant profit: food costs, staff wages, rent and other operating expenses are excluded.
          </p>
        </Panel>
      </div>

      <Panel
        title="Period comparison"
        subtitle={report.comparisonLabel ? `${report.comparisonLabel} versus the selected range` : "Choose a fixed weekly or monthly range"}
        icon={<TrendingUp size={20} />}
      >
        {comparison.length ? (
          <div className="bi-comparison-table">
            <div className="bi-comparison-head"><span>Metric</span><span>Current</span><span>Previous</span><span>Change</span></div>
            {comparison.map((row) => {
              const positive = (row.changePct ?? 0) >= 0;
              return (
                <div className="bi-comparison-row" key={row.label}>
                  <span>{row.label}</span>
                  <span>{row.money ? money(row.current) : `${row.current}%`}</span>
                  <span>{row.money ? money(row.previous) : `${row.previous}%`}</span>
                  <strong className={positive ? "up" : "down"}>
                    {row.changePct === null ? "—" : <>{positive ? <TrendingUp size={13} /> : <TrendingDown size={13} />}{positive ? "+" : ""}{row.changePct}%</>}
                  </strong>
                </div>
              );
            })}
          </div>
        ) : <p className="bi-empty-line">Pick a 1-week or 1-month preset (or a custom fixed range) to compare periods.</p>}
      </Panel>

      {report.ordersTruncated && <p className="bi-caption bi-truncated">This report is capped at the latest 1,000 orders in the range. Narrow the dates for a complete view.</p>}
      {report.source === "marketplace" && report.notice && <p className="bi-caption">{report.notice}</p>}
    </div>
  );
}
