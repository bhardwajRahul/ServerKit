# Giving Claude Code Direct Access to Your Server via MCP

## The Problem

Your current workflow:
```
You → Push to GitHub → Wait → SSH to server → Pull → Test → Report back → Repeat
```

This is slow and error-prone. With MCP, it becomes:
```
You → Claude runs commands directly on server → Instant feedback
```

---

## What is MCP?

**MCP (Model Context Protocol)** is a way to give Claude Code access to external tools and resources. Think of it as plugins that extend what Claude can do.

For server access, you'd set up an MCP server that lets Claude:
- Run bash commands on your remote server
- Read/write files on the server
- Check Docker status, nginx configs, logs, etc.

---

## Option 1: Faro + Agent Bridge (Recommended)

[Faro](https://github.com/jhd3197/Faro) is our own desktop client for SFTP, FTP, SSH, and S3-compatible storage. Its **Agent Bridge** lends the SSH session you've already authenticated in Faro to Claude Code (or any MCP agent) — no SSH keys handed to the agent, no server-side daemon, no extra MCP packages to install.

If you already use Faro to manage your servers, this is a two-minute setup.

### Step 1: Install Faro

Grab the installer for your platform from the [Releases page](https://github.com/jhd3197/Faro/releases) (macOS `.dmg`, Windows `.exe`/`.msi`, Linux `.AppImage`/`.deb`/`.rpm`).

### Step 2: Connect to Your Server

Add your server in Faro (New Connection → SFTP/SSH) and connect once, so the session is authenticated. Faro can import existing profiles from `~/.ssh/config`, FileZilla, or PuTTY.

### Step 3: Start the Agent Bridge

1. Open the **Bridge panel** (status-bar pill) and hit **Start**.
2. Flip on **Allow agent access** for the session you want to share.
3. Copy the one-liner the panel generates and run it in your project:

```bash
claude mcp add --transport http faro http://127.0.0.1:<port>/mcp \
  --header "Authorization: Bearer <token>"
```

That's it — Claude Code auto-discovers the Faro tools (`faro_exec`, `faro_list_sessions`, file read/write, sync, diff, search, log tailing, and more).

### Why this is the recommended path

| Guardrail | What it means |
|-----------|---------------|
| 🔒 Localhost only | The bridge binds to `127.0.0.1` on a random port — never exposed to the network |
| 🔑 Bearer token | Per-launch token required on every request |
| ☑️ Per-session opt-in | No connection is reachable until you explicitly allow it |
| 🙋 Per-command approval | Each command pops a prompt in Faro and blocks until you click Approve (configurable) |
| 📋 Live audit log | Every command, approval, and denial is logged in the panel |
| 🔐 Zero credential sharing | The agent borrows your authenticated session — it never sees your keys or passwords |

---

## Option 2: faro-cli (Scripting & Terminal Use)

`faro-cli` is the standalone CLI that ships with every Faro release (or build it with `cargo build -p faro-cli --release`). It reuses your saved Faro GUI profiles, so there's nothing to reconfigure — useful when you want server access from scripts or a plain terminal rather than through MCP:

```bash
# File ops — any backend, using your saved profiles
faro-cli profiles list
faro-cli ls prod:/var/log
faro-cli cp ./report.pdf prod:/var/www/uploads
faro-cli sync ./site prod:/var/www/site --mirror --dry-run

# Compare and search — remote↔remote works too
faro-cli diff prod:/etc staging:/etc --hash
faro-cli search prod:/var/log "OutOfMemory" --content --regex

# Run commands over a saved SSH profile
faro-cli exec prod 'systemctl status api'

# Drive the running Agent Bridge (goes through Faro's approval + console)
faro-cli agent exec prod 'journalctl -u api -n 100'
faro-cli agent exec prod --detach 'apt-get -y upgrade'   # background job
```

Path syntax: bare paths are local, `name:/path` references a saved profile.

### Bonus: machines without SSH — Faro Agent

For a box with no SSH server at all (a Windows PC, a Mac, a locked-down LXC), install Faro's own agent and pair it with a 6-digit code over an encrypted, key-pinned link:

```bash
curl -fsSL https://github.com/jhd3197/Faro/releases/latest/download/install-agentd.sh | sh
```

The paired machine shows up in Faro like any other connection — browsable, and reachable by the Agent Bridge and `faro-cli` just like an SSH server.

---

## Option 3: ServerKit "Open in Faro" Extension

The [serverkit-faro](https://github.com/jhd3197/serverkit-faro) extension adds an **"Open in Faro"** button to your ServerKit panel's Services, Domains, and WordPress pages. Clicking it opens Faro with the connection editor prefilled for that site (a `faro://connect?...` deep link — it never connects on its own and never carries credentials).

Workflow: ServerKit panel → click "Open in Faro" → connect → start the Agent Bridge → Claude Code has access. No manual host/path copying.

---

## Alternative: Generic SSH MCP Servers

If you don't want to use Faro, you can wire Claude Code to your server over plain SSH instead. These work, but they mean managing SSH keys and MCP packages yourself, and they lack Faro's approval prompts and audit log.

### A. SSH MCP server package

```bash
npm install -g @anthropic/mcp-ssh
```

Add to your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "serverkit-server": {
      "command": "npx",
      "args": [
        "-y",
        "@anthropic/mcp-ssh",
        "--host", "your-server-ip-or-hostname",
        "--user", "your-username",
        "--key", "C:\\Users\\Juan\\.ssh\\id_rsa"
      ]
    }
  }
}
```

### B. Plain SSH as the MCP command

The simplest variant — just open an SSH session as an MCP tool:

```json
{
  "mcpServers": {
    "serverkit-server": {
      "command": "ssh",
      "args": [
        "-o", "StrictHostKeyChecking=no",
        "-i", "C:\\Users\\Juan\\.ssh\\id_rsa",
        "user@your-server-ip",
        "bash"
      ]
    }
  }
}
```

### C. MCP server running on the server itself

Run an MCP server on the Linux box as a systemd service and reach it through an SSH tunnel (`ssh -L 3100:localhost:3100 user@your-server -N`). Never expose an MCP port directly to the internet.

### SSH key setup (required for all of the above)

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "claude-serverkit"

# Copy to server
ssh-copy-id user@your-server-ip

# Test connection
ssh user@your-server-ip "echo 'SSH works!'"
```

---

## Security Considerations

| Risk | Mitigation |
|------|------------|
| Full server access | Create a dedicated user with limited sudo rights |
| SSH key exposure | With Faro the agent never sees your keys; otherwise use a dedicated key, not your main one |
| Accidental destructive commands | Faro asks for approval before each command runs |
| Network exposure | Faro's bridge is localhost-only; for generic MCP always use SSH tunnels, never expose MCP directly |

### Create a Limited User (Recommended)

```bash
# On your server
sudo useradd -m -s /bin/bash claude-mcp
sudo usermod -aG docker claude-mcp  # For Docker access

# Limit sudo to specific commands
sudo visudo -f /etc/sudoers.d/claude-mcp
```

Add:
```
claude-mcp ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart nginx, /usr/bin/systemctl reload nginx, /usr/bin/nginx -t, /usr/bin/docker *, /usr/bin/docker-compose *
```

---

## What Claude Can Do With Server Access

Once configured, you can say things like:

- "Check if the Flask app container is running on the server"
- "Show me the nginx config for my-app"
- "Tail the nginx error logs for the last 50 lines"
- "Run docker ps and show me what's listening on port 8080"
- "Check why I'm getting 502 errors"
- "Deploy the latest changes from the repo"

---

## Quick Test

After setup, restart Claude Code and try:

```
"Use Faro to run 'docker ps' on my server"
```

If configured correctly, Claude will run that command on your server (through Faro's approval prompt) and show you the output.

---

## Next Steps

1. Install [Faro](https://github.com/jhd3197/Faro/releases) and connect to your server
2. Start the Agent Bridge and paste the generated `claude mcp add` one-liner
3. Restart Claude Code
4. Test with a simple command

Let me know which option you want to try and I can help you set it up step by step!
