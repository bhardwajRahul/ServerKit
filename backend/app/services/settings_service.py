"""Service for system settings operations."""
from app import db
from app.models import SystemSettings, User


class SettingsService:
    """Service for managing system settings."""

    # Default settings with their types and descriptions
    DEFAULT_SETTINGS = {
        'setup_completed': {
            'value': False,
            'type': 'boolean',
            'description': 'Whether initial setup has been completed'
        },
        'registration_enabled': {
            'value': False,
            'type': 'boolean',
            'description': 'Allow public user registration'
        },
        'instance_name': {
            'value': 'ServerKit',
            'type': 'string',
            'description': 'Name of this ServerKit instance'
        },
        'audit_log_retention_days': {
            'value': 90,
            'type': 'integer',
            'description': 'Number of days to retain audit logs'
        },
        'onboarding_use_cases': {
            'value': [],
            'type': 'json',
            'description': 'Use cases selected during onboarding wizard'
        },
        'dev_mode': {
            'value': False,
            'type': 'boolean',
            'description': 'Enable developer mode for debugging tools and icon reference'
        },
        'managed_app_base_port': {
            'value': 0,
            'type': 'integer',
            'description': 'Starting host port when auto-assigning ports to managed apps/sites (0 = use each template\'s own default). The scanner still skips ports already in use.'
        },
        # Managed-site routing & HTTPS (Phases 1/3/5). Base domain + server IP
        # drive subdomain publishing and auto-DNS; sites_https_enabled is set by
        # the wildcard-HTTPS setup, after which managed subdomains serve TLS.
        'sites_base_domain': {
            'value': '',
            'type': 'string',
            'description': 'Base domain for managed sites — each is published at <slug>.<base_domain>. Point a wildcard DNS record (*.<base_domain>) at this server.'
        },
        'server_public_ip': {
            'value': '',
            'type': 'string',
            'description': 'Public IP of this server, used to auto-create DNS A records for managed domains.'
        },
        'sites_https_enabled': {
            'value': False,
            'type': 'boolean',
            'description': 'Whether the wildcard certificate for the sites base domain is set up; managed subdomains serve HTTPS when true.'
        },
        # SSO / OAuth settings
        'sso_google_enabled': {'value': False, 'type': 'boolean', 'description': 'Enable Google OAuth login'},
        'sso_google_client_id': {'value': '', 'type': 'string', 'description': 'Google OAuth client ID'},
        'sso_google_client_secret': {'value': '', 'type': 'string', 'description': 'Google OAuth client secret'},
        'sso_github_enabled': {'value': False, 'type': 'boolean', 'description': 'Enable GitHub OAuth login'},
        'sso_github_client_id': {'value': '', 'type': 'string', 'description': 'GitHub OAuth client ID'},
        'sso_github_client_secret': {'value': '', 'type': 'string', 'description': 'GitHub OAuth client secret'},
        'sso_oidc_enabled': {'value': False, 'type': 'boolean', 'description': 'Enable generic OIDC login'},
        'sso_oidc_provider_name': {'value': '', 'type': 'string', 'description': 'OIDC provider display name'},
        'sso_oidc_client_id': {'value': '', 'type': 'string', 'description': 'OIDC client ID'},
        'sso_oidc_client_secret': {'value': '', 'type': 'string', 'description': 'OIDC client secret'},
        'sso_oidc_discovery_url': {'value': '', 'type': 'string', 'description': 'OIDC discovery URL'},
        'sso_saml_enabled': {'value': False, 'type': 'boolean', 'description': 'Enable SAML 2.0 login'},
        'sso_saml_entity_id': {'value': '', 'type': 'string', 'description': 'SAML SP entity ID'},
        'sso_saml_idp_metadata_url': {'value': '', 'type': 'string', 'description': 'SAML IdP metadata URL'},
        'sso_saml_idp_sso_url': {'value': '', 'type': 'string', 'description': 'SAML IdP SSO URL'},
        'sso_saml_idp_cert': {'value': '', 'type': 'string', 'description': 'SAML IdP certificate (PEM)'},
        'sso_auto_provision': {'value': True, 'type': 'boolean', 'description': 'Auto-create users on first SSO login'},
        'sso_default_role': {'value': 'developer', 'type': 'string', 'description': 'Default role for SSO-provisioned users'},
        'sso_force_sso': {'value': False, 'type': 'boolean', 'description': 'Disable password login (SSO only)'},
        'sso_allowed_domains': {'value': [], 'type': 'json', 'description': 'Restrict SSO to these email domains'},
        # Source provider connections
        'source_github_client_id': {
            'value': '',
            'type': 'string',
            'description': 'GitHub OAuth client ID for repository connections'
        },
        'source_github_client_secret': {
            'value': '',
            'type': 'string',
            'description': 'GitHub OAuth client secret for repository connections'
        },
        # Rate limiting settings
        'rate_limit_standard': {'value': '100 per minute', 'type': 'string', 'description': 'Rate limit for standard API keys'},
        'rate_limit_elevated': {'value': '500 per minute', 'type': 'string', 'description': 'Rate limit for elevated API keys'},
        'rate_limit_unlimited': {'value': '5000 per minute', 'type': 'string', 'description': 'Rate limit for unlimited API keys'},
        'rate_limit_unauthenticated': {'value': '30 per minute', 'type': 'string', 'description': 'Rate limit for unauthenticated requests'},
        # AI assistant (core primitive — powered by Prompture). The API key is
        # stored encrypted and is NEVER returned by the settings API (see SECRET_AI_KEYS).
        'ai_enabled': {'value': False, 'type': 'boolean', 'description': 'Enable the AI assistant'},
        'ai_provider': {'value': '', 'type': 'string', 'description': 'Prompture provider (openai/claude/google/groq/openrouter/ollama/lmstudio)'},
        'ai_model': {'value': '', 'type': 'string', 'description': 'Model id for the selected provider'},
        'ai_api_key_encrypted': {'value': '', 'type': 'string', 'description': 'Encrypted provider API key (never returned by the API)'},
        'ai_endpoint': {'value': '', 'type': 'string', 'description': 'Custom endpoint (ollama/lmstudio; reserved for OpenAI-compatible gateways)'},
        'ai_max_cost_usd': {'value': 0.5, 'type': 'string', 'description': 'Per-conversation cost ceiling in USD (budget_policy=degrade)'},
        'ai_fallback_models': {'value': [], 'type': 'json', 'description': 'Ordered fallback model ids when the primary is over budget/unavailable'},
        'ai_pii_redaction': {'value': True, 'type': 'boolean', 'description': 'Redact PII from AI input and tool output'},
        'ai_injection_detection': {'value': True, 'type': 'boolean', 'description': 'Refuse prompts flagged as prompt-injection'},
        'ai_pending_action_ttl_s': {'value': 300, 'type': 'integer', 'description': 'Seconds a write-tool confirmation stays valid'},
    }

    # Settings that must never be returned through the API (only "is it set?").
    SECRET_AI_KEYS = {'ai_api_key_encrypted'}

    @staticmethod
    def get(key, default=None):
        """Get a setting value by key."""
        return SystemSettings.get(key, default)

    @staticmethod
    def set(key, value, user_id=None):
        """Set a setting value by key."""
        # Get the expected type from defaults
        default_config = SettingsService.DEFAULT_SETTINGS.get(key, {})
        value_type = default_config.get('type', 'string')
        description = default_config.get('description')

        setting = SystemSettings.set(
            key=key,
            value=value,
            value_type=value_type,
            description=description,
            user_id=user_id
        )
        db.session.commit()
        return setting

    @staticmethod
    def get_all():
        """Get all settings as a dictionary."""
        settings = SystemSettings.query.all()
        result = {}
        for setting in settings:
            result[setting.key] = setting.get_typed_value()
        return result

    @staticmethod
    def get_all_with_metadata():
        """Get all settings with full metadata."""
        settings = SystemSettings.query.all()
        return [setting.to_dict() for setting in settings]

    @staticmethod
    def initialize_defaults():
        """Initialize default settings if they don't exist."""
        for key, config in SettingsService.DEFAULT_SETTINGS.items():
            existing = SystemSettings.query.filter_by(key=key).first()
            if not existing:
                SystemSettings.set(
                    key=key,
                    value=config['value'],
                    value_type=config['type'],
                    description=config['description']
                )
        db.session.commit()

    @staticmethod
    def needs_setup():
        """Check if initial setup is needed."""
        from app.models.user import User
        user_count = User.query.count()
        if user_count == 0:
            return True
        setup_completed = SettingsService.get('setup_completed', False)
        if setup_completed:
            return False  # Once completed, never re-enable without admin action
        return True

    @staticmethod
    def complete_setup(user_id=None):
        """Mark the initial setup as completed."""
        SettingsService.set('setup_completed', True, user_id=user_id)

    @staticmethod
    def is_registration_enabled():
        """Check if public registration is enabled."""
        # If no users exist, always allow registration (for first user)
        user_count = User.query.count()
        if user_count == 0:
            return True
        return SettingsService.get('registration_enabled', False)

    @staticmethod
    def set_registration_enabled(enabled, user_id=None):
        """Enable or disable public registration."""
        SettingsService.set('registration_enabled', enabled, user_id=user_id)

    @staticmethod
    def migrate_legacy_roles():
        """Migrate users with 'user' role to 'developer' role."""
        try:
            users_to_migrate = User.query.filter_by(role='user').all()
            count = 0
            for user in users_to_migrate:
                user.role = User.ROLE_DEVELOPER
                count += 1
            if count > 0:
                db.session.commit()
            return count
        except Exception:
            db.session.rollback()
            return 0

    @staticmethod
    def ensure_admin_exists():
        """
        Check if at least one admin exists.
        If users exist but no admins, something is wrong.
        """
        admin_count = User.query.filter_by(role=User.ROLE_ADMIN).count()
        user_count = User.query.count()
        return admin_count > 0 or user_count == 0
