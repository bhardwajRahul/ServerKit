"""Test Sandbox run history (``sandbox_runs``).

Idempotent: MigrationService runs _fix_missing_columns() + db.create_all() on
boot before Alembic, so guard on the live schema (the table may already exist).

Revision ID: 075_sandbox_runs
Revises: 074_cf_ops_changes
Create Date: 2026-07-20
"""
from alembic import op
import sqlalchemy as sa

revision = '075_sandbox_runs'
down_revision = '074_cf_ops_changes'
branch_labels = None
depends_on = None


def upgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    tables = set(inspector.get_table_names())

    if 'sandbox_runs' not in tables:
        op.create_table(
            'sandbox_runs',
            sa.Column('id', sa.Integer(), nullable=False),
            sa.Column('mode', sa.String(length=16), nullable=False,
                      server_default='quick'),
            sa.Column('distros', sa.JSON(), nullable=True),
            sa.Column('status', sa.String(length=16), nullable=False,
                      server_default='running'),
            sa.Column('results', sa.JSON(), nullable=True),
            sa.Column('error', sa.Text(), nullable=True),
            sa.Column('user_id', sa.Integer(), nullable=True),
            sa.Column('created_at', sa.DateTime(), nullable=True),
            sa.Column('finished_at', sa.DateTime(), nullable=True),
            sa.ForeignKeyConstraint(['user_id'], ['users.id']),
            sa.PrimaryKeyConstraint('id'),
        )
        op.create_index('ix_sandbox_runs_status', 'sandbox_runs', ['status'])
        op.create_index('ix_sandbox_runs_created_at', 'sandbox_runs', ['created_at'])


def downgrade():
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if 'sandbox_runs' in set(inspector.get_table_names()):
        op.drop_table('sandbox_runs')
