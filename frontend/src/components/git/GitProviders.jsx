// Brand-authentic Git provider identities — the single source of truth for how a
// repository host is recognized and presented across ServerKit's "connect a
// repository" surfaces (New Service page, the service connect modal, and the
// WordPress Git tab). Mirrors components/icons/DatabaseBrands.jsx: we wrap Simple
// Icons (via react-icons) so GitHub / GitLab / Bitbucket / Gitea are instantly
// recognizable instead of sharing one generic git glyph.
//
// Simple Icons render with `fill="currentColor"`, so the surrounding SCSS controls
// the color with no inline styles.
import { SiGithub, SiGitlab, SiBitbucket, SiGitea } from 'react-icons/si';
import { GitBranch } from 'lucide-react';

// Ordered list rendered in the provider strip. `match` recognizes a clone URL's
// host; the trailing "other" entry is the catch-all (self-hosted, SSH, anything
// unrecognized).
export const GIT_PROVIDERS = [
    { key: 'github', label: 'GitHub', Icon: SiGithub, hint: 'HTTPS or SSH', match: /github\.com/i },
    { key: 'gitlab', label: 'GitLab', Icon: SiGitlab, hint: 'Cloud or self-managed', match: /gitlab\./i },
    { key: 'bitbucket', label: 'Bitbucket', Icon: SiBitbucket, hint: 'bitbucket.org', match: /bitbucket\.org/i },
    { key: 'gitea', label: 'Gitea', Icon: SiGitea, hint: 'Self-hosted', match: /gitea/i },
    { key: 'other', label: 'SSH / Other', Icon: GitBranch, hint: 'Any Git remote', match: null },
];

const OTHER_PROVIDER = GIT_PROVIDERS[GIT_PROVIDERS.length - 1];

// Resolve a clone URL to a provider. Returns null for an empty field (so callers
// can render a neutral, nothing-detected state) and the "other" catch-all when a
// non-empty URL matches no known host.
export function detectProvider(url) {
    const trimmed = (url || '').trim();
    if (!trimmed) return null;
    return GIT_PROVIDERS.find((p) => p.match && p.match.test(trimmed)) || OTHER_PROVIDER;
}

// The "explains the others" strip: every supported host as a chip with its brand
// mark, label, and a one-liner. The detected provider gets the accent highlight.
export function RepoProviderStrip({ detected }) {
    return (
        <div className="git-connect__providers" role="list" aria-label="Supported Git providers">
            {GIT_PROVIDERS.map(({ key, label, Icon, hint }) => (
                <div
                    key={key}
                    role="listitem"
                    className={`git-connect__provider${detected === key ? ' git-connect__provider--active' : ''}`}
                >
                    <span className="git-connect__provider-icon">
                        <Icon size={18} aria-hidden="true" />
                    </span>
                    <span className="git-connect__provider-label">{label}</span>
                    <span className="git-connect__provider-hint">{hint}</span>
                </div>
            ))}
        </div>
    );
}

// Inline brand mark + name — the live "detected provider" indicator beside a URL
// field. Renders nothing until a provider is resolved.
export function ProviderBadge({ provider }) {
    if (!provider) return null;
    const { Icon, label } = provider;
    return (
        <span className="git-connect__detected">
            <Icon size={13} aria-hidden="true" />
            Detected: {label}
        </span>
    );
}
