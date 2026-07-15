// Default auth layout: a single centered card. Identical to the original
// login chrome, so `login_layout: centered` is a no-visual-change baseline.
export default function CenteredLayout({ children }) {
    return (
        <div className="auth-container">
            <div className="auth-card">{children}</div>
        </div>
    );
}
