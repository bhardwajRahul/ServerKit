// Minimal auth layout: a bare centered form with no card chrome.
export default function MinimalLayout({ children }) {
    return (
        <div className="auth-container auth-minimal">
            <div className="auth-minimal__inner">{children}</div>
        </div>
    );
}
