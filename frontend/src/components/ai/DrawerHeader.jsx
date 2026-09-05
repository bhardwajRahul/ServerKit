import { useNavigate } from 'react-router-dom';
import { Settings } from 'lucide-react';
import { useAuth } from '../../contexts/useAuth.js';
import { useServerkitAI } from '../../contexts/useServerkitAI.js';
import ModeToggle from './ModeToggle';
import ConversationMenu from './ConversationMenu';
import { useTranslation } from 'react-i18next';
import { Button as SharedButton } from '@/components/ui/button';

// Slim toolbar under the shared console tabs. Close lives in the tab strip
// above, so this row carries only the assistant-specific controls.
const DrawerHeader = () => {
    const { t } = useTranslation();
    const { close } = useServerkitAI();
    const { isAdmin } = useAuth();
    const navigate = useNavigate();

    return (
        <header className="sk-ai-header">
            <div className="sk-ai-header__title">
                <span className="sk-ai-header__name">{t('app.drawerHeader.serverkitAi', 'ServerKit AI')}</span>
            </div>
            <div className="sk-ai-header__actions">
                <ModeToggle />
                <ConversationMenu />
                {isAdmin ? (
                    <SharedButton variant="unstyled"
                        type="button"
                        className="sk-ai-iconbtn"
                        aria-label={t('app.drawerHeader.aiSettings', 'AI settings')}
                        onClick={() => { close(); navigate('/settings/ai'); }}
                    >
                        <Settings size={16} />
                    </SharedButton>
                ) : null}
            </div>
        </header>
    );
};

export default DrawerHeader;
