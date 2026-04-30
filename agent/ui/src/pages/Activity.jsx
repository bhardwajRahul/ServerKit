export default function Activity() {
    return (
        <div className="page">
            <header className="page__header">
                <h1 className="page__title">Activity</h1>
                <p className="page__sub">
                    <span className="muted">Coming next milestone — human-readable event timeline.</span>
                </p>
            </header>
            <div className="card empty-state">
                Pairing events, connection drops, restart actions, and panel-issued commands will land here.
            </div>
        </div>
    );
}
