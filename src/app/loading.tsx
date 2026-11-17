export default function Loading() {
  return (
    <main className="content-wrap" role="status" aria-live="polite">
      <div className="page-intro">
        <div>
          <div className="eyebrow">SAVOUR PARTNER</div>
          <h1>Loading your workspace…</h1>
        </div>
      </div>
      <div className="metrics-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <div className="panel metric-card" key={index}>
            <div style={{ width: 70, height: 10, borderRadius: 5, background: "#eef1ed" }} />
            <div style={{ width: 100, height: 24, borderRadius: 6, background: "#f2f4f1", marginTop: 16 }} />
            <div style={{ width: 130, height: 9, borderRadius: 5, background: "#f2f4f1", marginTop: 12 }} />
          </div>
        ))}
      </div>
    </main>
  );
}
