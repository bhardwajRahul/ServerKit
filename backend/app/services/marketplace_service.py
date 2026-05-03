import logging
from app import db
from app.models.marketplace import Extension, ExtensionInstall

logger = logging.getLogger(__name__)


class MarketplaceService:
    """Service for the extension marketplace."""

    CATEGORIES = ['monitoring', 'security', 'deployment', 'integration', 'ui', 'utility']

    @staticmethod
    def list_extensions(category=None, search=None, status='published'):
        query = Extension.query
        if status:
            query = query.filter_by(status=status)
        if category:
            query = query.filter_by(category=category)
        if search:
            query = query.filter(
                db.or_(
                    Extension.display_name.ilike(f'%{search}%'),
                    Extension.description.ilike(f'%{search}%'),
                )
            )
        return query.order_by(Extension.download_count.desc()).all()

    @staticmethod
    def get_extension(ext_id):
        return Extension.query.get(ext_id)

    @staticmethod
    def get_extension_by_slug(slug):
        return Extension.query.filter_by(slug=slug).first()

    @staticmethod
    def get_install(install_id):
        return ExtensionInstall.query.get(install_id)

    @staticmethod
    def create_extension(data, user_id=None):
        slug = data.get('slug', data['name'].lower().replace(' ', '-'))
        if Extension.query.filter_by(slug=slug).first():
            raise ValueError(f"Extension '{slug}' already exists")

        ext = Extension(
            name=data['name'],
            display_name=data.get('display_name', data['name']),
            slug=slug,
            description=data.get('description', ''),
            long_description=data.get('long_description', ''),
            version=data.get('version', '1.0.0'),
            author=data.get('author', ''),
            homepage=data.get('homepage', ''),
            repository=data.get('repository', ''),
            license=data.get('license', 'MIT'),
            category=data.get('category', 'utility'),
            extension_type=data.get('extension_type', 'integration'),
            entry_point=data.get('entry_point', ''),
            submitted_by=user_id,
        )
        ext.tags = data.get('tags', [])
        if data.get('config_schema'):
            ext.config_schema = data['config_schema']

        db.session.add(ext)
        db.session.commit()
        return ext

    @staticmethod
    def update_extension(ext_id, data):
        ext = Extension.query.get(ext_id)
        if not ext:
            return None
        for field in ['display_name', 'description', 'long_description', 'version',
                      'author', 'homepage', 'repository', 'license', 'category',
                      'extension_type', 'entry_point', 'status']:
            if field in data:
                setattr(ext, field, data[field])
        if 'tags' in data:
            ext.tags = data['tags']
        if 'config_schema' in data:
            ext.config_schema = data['config_schema']
        db.session.commit()
        return ext

    @staticmethod
    def publish_extension(ext_id):
        ext = Extension.query.get(ext_id)
        if not ext:
            return None
        ext.status = Extension.STATUS_PUBLISHED
        db.session.commit()
        return ext

    @staticmethod
    def delete_extension(ext_id):
        ext = Extension.query.get(ext_id)
        if not ext:
            return False
        ExtensionInstall.query.filter_by(extension_id=ext_id).delete()
        db.session.delete(ext)
        db.session.commit()
        return True

    # --- Installations ---

    @staticmethod
    def install_extension(ext_id, user_id, config=None):
        ext = Extension.query.get(ext_id)
        if not ext:
            raise ValueError('Extension not found')

        existing = ExtensionInstall.query.filter_by(
            extension_id=ext_id, user_id=user_id
        ).first()
        if existing and existing.is_active:
            raise ValueError('Extension already installed')

        if existing:
            existing.is_active = True
            existing.installed_version = ext.version
            if config:
                existing.config = config
            install = existing
        else:
            install = ExtensionInstall(
                extension_id=ext_id,
                user_id=user_id,
                installed_version=ext.version,
            )
            if config:
                install.config = config
            db.session.add(install)

        ext.download_count += 1
        db.session.commit()

        # Hand off to the plugin installer if we have a source we can fetch.
        # Marketplace rows historically only stored metadata; if a source
        # URL is set we now actually install the plugin so it contributes
        # its routes/sidebar/api like any other plugin.
        # `entry_point` doubles as a source URL for marketplace-hosted
        # plugins (the field is reused — admins paste a github/zip URL).
        source_url = (ext.entry_point or ext.repository or '').strip()
        if source_url:
            try:
                from app.services import plugin_service
                plugin_service.install_from_url(source_url, user_id=user_id)
            except Exception as e:
                # Roll back the marketplace install row so the user can
                # retry cleanly. The download counter increment also gets
                # undone via the rollback.
                db.session.rollback()
                logger.warning(
                    f'Marketplace ext {ext.slug}: plugin install from '
                    f'{source_url} failed: {e}'
                )
                raise ValueError(f'Plugin install failed: {e}')

        return install

    @staticmethod
    def uninstall_extension(install_id):
        install = ExtensionInstall.query.get(install_id)
        if not install:
            return False
        install.is_active = False
        db.session.commit()
        return True

    @staticmethod
    def get_user_extensions(user_id):
        return ExtensionInstall.query.filter_by(user_id=user_id, is_active=True).all()

    @staticmethod
    def update_extension_config(install_id, config):
        install = ExtensionInstall.query.get(install_id)
        if not install:
            return None
        install.config = config
        db.session.commit()
        return install

    @staticmethod
    def rate_extension(ext_id, rating):
        ext = Extension.query.get(ext_id)
        if not ext:
            return None
        total = ext.rating * ext.rating_count + rating
        ext.rating_count += 1
        ext.rating = round(total / ext.rating_count, 2)
        db.session.commit()
        return ext

    @staticmethod
    def get_categories():
        return MarketplaceService.CATEGORIES
