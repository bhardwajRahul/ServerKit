"""Canonical theme token whitelist + alias table + validators (server side).

A ServerKit theme is DATA, not code (plan 60): a map of canonical CSS
custom-property names to values. This module is the backend source of truth for
the same three things the panel enforces client-side in
``frontend/src/data/themeTokens.js`` — KEEP THE TWO IN SYNC:

  - which token names a theme may set (the whitelist),
  - how canonical names expand to the legacy ``--bg-*/--text-*/--border-*``
    aliases the stylesheet still reads, and
  - what a token's value may look like (the validators).

The backend runs this on ``POST /import`` and on registry install so a malicious
or malformed theme never reaches the DB — the client validation is a
convenience, this is the gate.
"""
import re

# Canonical writable tokens, grouped. Authors write these ~37 names; the alias
# table fans each out to the legacy names. Accent tokens are intentionally
# excluded — they are derived at runtime from a theme's single ``accent`` field.
TOKEN_GROUPS = {
    'surfaces': ['--bg-body', '--bg-sidebar', '--surface', '--surface-2', '--surface-3', '--surface-hover'],
    'borders': ['--border', '--border-soft', '--border-strong'],
    'text': ['--text', '--text-dim', '--text-faint', '--text-ghost'],
    'semantic': ['--green', '--green-bg', '--amber', '--amber-bg', '--red', '--red-bg', '--cyan', '--cyan-bg', '--violet', '--violet-bg'],
    'radius': ['--radius', '--radius-sm', '--radius-lg'],
    'fonts': ['--sans', '--mono'],
    'shadows': ['--shadow-sm', '--shadow-md', '--shadow-lg'],
    'scrollbar': ['--scrollbar-track', '--scrollbar-thumb', '--scrollbar-thumb-hover'],
    'code': ['--bg-code', '--text-code'],
    'chrome': ['--grid-color'],
}

_GROUP_TYPE = {
    'surfaces': 'color',
    'borders': 'color',
    'text': 'color',
    'semantic': 'color',
    'radius': 'length',
    'fonts': 'font',
    'shadows': 'shadow',
    'scrollbar': 'color',
    'code': 'color',
    'chrome': 'color',
}

CANONICAL_TOKENS = [t for group in TOKEN_GROUPS.values() for t in group]

TOKEN_TYPE = {t: _GROUP_TYPE[g] for g, tokens in TOKEN_GROUPS.items() for t in tokens}

# Canonical name -> legacy names that must receive the same value.
ALIAS_MAP = {
    '--surface': ['--bg-card'],
    '--surface-2': ['--bg-elevated', '--bg-secondary'],
    '--surface-3': ['--bg-tertiary'],
    '--surface-hover': ['--bg-hover'],
    '--border': ['--border-default'],
    '--border-soft': ['--border-subtle'],
    '--border-strong': ['--border-active', '--border-hover'],
    '--text': ['--text-primary'],
    '--text-dim': ['--text-secondary'],
    '--text-faint': ['--text-tertiary'],
}

VALID_BASES = ('dark', 'light')
VALID_SOURCES = ('registry', 'import', 'studio', 'bundled')

# --------------------------------------------
# Value validation
# --------------------------------------------
_FORBIDDEN = re.compile(r'url\(|expression\(|javascript:|@import|[@;{}<>]|/\*', re.IGNORECASE)
_HEX = re.compile(r'^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')
_FUNC_COLOR = re.compile(r'^(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$', re.IGNORECASE)
_NAMED_COLOR = re.compile(r'^[a-zA-Z]{3,24}$')
_LENGTH = re.compile(r'^-?(?:0|\d*\.?\d+)(px|rem|em|%|vh|vw)?$')
_FONT_STACK = re.compile(r'^[a-zA-Z0-9 ,"\'-]{1,200}$')
_SHADOW = re.compile(r'^[0-9a-zA-Z.,%()#\s/-]{1,200}$')


def _is_color(v):
    return bool(_HEX.match(v) or _FUNC_COLOR.match(v) or _NAMED_COLOR.match(v))


_VALIDATORS = {
    'color': _is_color,
    'length': lambda v: bool(_LENGTH.match(v)),
    'font': lambda v: bool(_FONT_STACK.match(v)),
    'shadow': lambda v: v == 'none' or bool(_SHADOW.match(v)),
}


def validate_token_value(token, value):
    """Return the trimmed value if ``token`` is whitelisted and ``value`` passes
    its type check (and has no forbidden substring), else ``None``."""
    ttype = TOKEN_TYPE.get(token)
    if not ttype:
        return None
    if not isinstance(value, str):
        return None
    v = value.strip()
    if not v or len(v) > 200:
        return None
    if _FORBIDDEN.search(v):
        return None
    return v if _VALIDATORS[ttype](v) else None


def sanitize_tokens(raw):
    """Drop unknown / invalid entries, returning only whitelisted, validated
    canonical tokens. Unknown keys degrade gracefully (forward-compat)."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for token, value in raw.items():
        clean = validate_token_value(token, value)
        if clean is not None:
            out[token] = clean
    return out


def expand_aliases(clean_tokens):
    """Expand a validated canonical map to include legacy aliases."""
    out = dict(clean_tokens)
    for token, value in clean_tokens.items():
        for alias in ALIAS_MAP.get(token, []):
            if alias not in clean_tokens:
                out[alias] = value
    return out


_SLUG_RE = re.compile(r'^[a-z0-9]+(?:-[a-z0-9]+)*$')


def validate_theme(raw):
    """Validate and normalise a raw theme dict (from import / registry / studio).

    Returns ``(theme, error)``: on success ``theme`` is a cleaned dict with a
    sanitised ``tokens`` map (invalid/unknown tokens dropped) and ``error`` is
    ``None``; on failure ``theme`` is ``None`` and ``error`` is a message.
    """
    if not isinstance(raw, dict):
        return None, 'Theme must be a JSON object'
    if raw.get('schema_version') not in (1, '1', None):
        return None, 'Unsupported schema_version (expected 1)'

    slug = raw.get('slug')
    if not isinstance(slug, str) or not _SLUG_RE.match(slug):
        return None, 'Invalid or missing slug (kebab-case, lowercase alphanumerics)'

    name = raw.get('name')
    if not isinstance(name, str) or not name.strip():
        return None, 'Missing theme name'

    base = raw.get('base', 'dark')
    if base not in VALID_BASES:
        return None, "base must be 'dark' or 'light'"

    raw_tokens = raw.get('tokens')
    if not isinstance(raw_tokens, dict):
        return None, 'Missing tokens object'

    tokens = {}
    for mode in ('dark', 'light'):
        if isinstance(raw_tokens.get(mode), dict):
            cleaned = sanitize_tokens(raw_tokens[mode])
            if cleaned:
                tokens[mode] = cleaned
    if not tokens:
        return None, 'Theme defines no valid tokens'

    accent = raw.get('accent')
    if accent is not None and validate_token_value('--surface', accent) is None:
        # accent is a plain color; reuse the color validator via a color token.
        accent = None

    preview = raw.get('preview')
    if (isinstance(preview, list) and len(preview) == 4
            and all(isinstance(c, str) for c in preview)):
        # Swatches are painted as inline CSS — every one must be a real color
        # (same gate as accent), never an url()/expression() payload.
        if any(validate_token_value('--surface', c) is None for c in preview):
            return None, 'preview swatches must be valid colors'
    else:
        # Derive a reasonable preview from the tokens if absent/malformed.
        primary = tokens.get('dark') or tokens.get('light') or {}
        preview = [
            primary.get('--bg-body', '#101218'),
            primary.get('--surface', '#161922'),
            accent or '#6d7cff',
            primary.get('--text', '#e9ebf0'),
        ]

    theme = {
        'schema_version': 1,
        'slug': slug,
        'name': name.strip(),
        'author': raw.get('author') if isinstance(raw.get('author'), str) else '',
        'version': raw.get('version') if isinstance(raw.get('version'), str) else '1.0.0',
        'description': raw.get('description') if isinstance(raw.get('description'), str) else '',
        'base': base,
        'tokens': tokens,
        'accent': accent,
        'preview': preview[:4],
    }
    return theme, None
