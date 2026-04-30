export default function Logs() {
    return (
        <div className="page">
            <header className="page__header">
                <h1 className="page__title">Logs</h1>
                <p className="page__sub">
                    <span className="muted">Coming next milestone — tail of agent.log with level filter and clear.</span>
                </p>
            </header>
            <div className="card empty-state">
                The raw JSON-line agent log will be tailed here, with INFO/WARN/ERROR filtering, search, and a Clear button.
            </div>
        </div>
    );
}
