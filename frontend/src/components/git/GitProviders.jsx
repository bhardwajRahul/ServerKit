// Brand-authentic Git provider identities — the single source of truth for how a
// repository host is recognized and presented across ServerKit's "connect a
// repository" surfaces (New Service page, the service connect modal, and the
// WordPress Git tab). Mirrors components/icons/DatabaseBrands.jsx: we wrap Simple
// Icons (via react-icons) so GitHub / GitLab / Bitbucket / Gitea are instantly
// recognizable instead of sharing one generic git glyph.
//
// Simple Icons render with `fill="currentColor"`, so the surrounding SCSS controls
// the color with no inline styles.
import { GIT_PROVIDERS } from './gitProviderData';
import { useTranslation } from 'react-i18next';
import { Button as SharedButton } from '@/components/ui/button';

// The provider strip: every supported host as a chip with its brand mark, label,
// and one-liner. Static by default (just "explains the others"); pass `onSelect`
// to make the chips REAL radio buttons that pick the connection method.
export function RepoProviderStrip({ detected, selected, onSelect, giteaStatus }) {
    const { t } = useTranslation();
    const interactive = typeof onSelect === 'function';
    const activeKey = selected ?? detected;
    const giteaRunning = giteaStatus?.installed && giteaStatus?.running;
    return (
        <div
            className="git-connect__providers"
            role={interactive ? 'radiogroup' : 'list'}
            aria-label={t('app.gitProviders.gitProviders', 'Git providers')}
        >
            {GIT_PROVIDERS.map(({ key, label, Icon, hint, local }) => {
                const active = activeKey === key;
                const className = `git-connect__provider${active ? ' git-connect__provider--active' : ''}${interactive ? ' git-connect__provider--btn' : ''}${local && giteaRunning ? ' git-connect__provider--live' : ''}`;
                const displayHint = key === 'gitea' && giteaRunning
                    ? 'Local server running'
                    : hint;
                const inner = (
                    <>
                        <span className="git-connect__provider-icon">
                            <Icon size={18} aria-hidden="true" />
                        </span>
                        <span className="git-connect__provider-label">{label}</span>
                        <span className="git-connect__provider-hint">{displayHint}</span>
                    </>
                );
                return interactive ? (
                    <SharedButton variant="unstyled"
                        type="button"
                        key={key}
                        className={className}
                        role="radio"
                        aria-checked={active}
                        onClick={() => onSelect(key)}
                    >
                        {inner}
                    </SharedButton>
                ) : (
                    <div key={key} role="listitem" className={className}>
                        {inner}
                    </div>
                );
            })}
        </div>
    );
}

// Inline brand mark + name — the live "detected provider" indicator beside a URL
// field. Renders nothing until a provider is resolved.
export function ProviderBadge({ provider }) {
    const { t } = useTranslation();
    if (!provider) return null;
    const { Icon, label } = provider;
    return (
        <span className="git-connect__detected">
            <Icon size={13} aria-hidden="true" />
            {t('app.gitProviders.detected', 'Detected:')} {label}
        </span>
    );
}
