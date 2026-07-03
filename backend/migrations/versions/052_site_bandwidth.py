"""Per-domain bandwidth accounting.

Adds the site_bandwidth_daily table: one row per (domain, day) rolled up
from the nginx access logs by the daily bandwidth.aggregate job.

Idempotent: MigrationService runs _fix_missing_columns() + db.create_all() on
boot before Alembic, so guard on the live schema.

Revision ID: 052_site_bandwidth
Revises: 051_site_imports
Create Date: 2026-07-03
"""
from alembic import op
import sqlalchemy as sa

revision = '052_site_bandwidth'
down_revision = '051_site_imports'
branch_labels = None
depends_on = None

TABLE = 'site_bandwidth_daily'


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if TABLE in set(inspector.get_table_names()):
        return
    op.create_table(
        TABLE,
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('app_id', sa.Integer(),
                  sa.ForeignKey('applications.id', ondelete='CASCADE'),
                  nullable=True),
        sa.Column('domain', sa.String(255), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('bytes_sent', sa.BigInteger(), nullable=False,
                  server_default='0'),
        sa.Column('requests', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('created_at', sa.DateTime(), nullable=True),
        sa.UniqueConstraint('domain', 'day',
                            name='uq_site_bandwidth_domain_day'),
    )
    op.create_index('ix_site_bandwidth_daily_domain', TABLE, ['domain'])
    op.create_index('ix_site_bandwidth_daily_day', TABLE, ['day'])


def downgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if TABLE not in set(inspector.get_table_names()):
        return
    op.drop_table(TABLE)
