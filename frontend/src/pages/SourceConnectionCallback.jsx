import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Github, Loader2 } from 'lucide-react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';

const SourceConnectionCallback = () => {
    const { provider } = useParams();
    const [searchParams] = useSearchParams();
    const navigate = useNavigate();
    const toast = useToast();
    const [error, setError] = useState('');
    const didComplete = useRef(false);

    useEffect(() => {
        if (didComplete.current) return;
        didComplete.current = true;

        async function completeConnection() {
            const code = searchParams.get('code');
            const state = searchParams.get('state');
            const redirectUri = `${window.location.origin}/connections/callback/${provider}`;
            const returnTo = sessionStorage.getItem('sourceConnectionReturnTo') || '/settings/connections';

            if (!code || !state) {
                setError('GitHub did not return a valid authorization response.');
                return;
            }

            try {
                await api.completeSourceConnection(provider, code, state, redirectUri);
                sessionStorage.removeItem('sourceConnectionReturnTo');
                toast.success('GitHub connected');
                navigate(returnTo, { replace: true });
            } catch (err) {
                setError(err.message || 'Failed to connect GitHub');
            }
        }

        completeConnection();
    }, [navigate, provider, searchParams, toast]);

    return (
        <div className="auth-page">
            <div className="auth-card">
                <div className="auth-logo">
                    <Github size={32} />
                </div>
                <h1>Connecting GitHub</h1>
                {error ? (
                    <>
                        <p className="auth-error">{error}</p>
                        <button className="btn btn-primary" onClick={() => navigate('/settings/connections')}>
                            Back to Connections
                        </button>
                    </>
                ) : (
                    <div className="sso-loading">
                        <Loader2 size={24} className="spinning" />
                        <p>Finishing provider authorization...</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SourceConnectionCallback;
