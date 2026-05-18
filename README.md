# Hermes Agent Constellation

A dynamic, cyberpunk-styled network visualization of your [Hermes Agent](https://github.com/NousResearch/hermes-agent) ecosystem. Shows all agents across multiple machines, their connections, models, roles, and platform status — auto-updating from live config data.

![Constellation Preview](preview.png)

## Features

- **Multi-machine** — visualize agents across Mac, Windows, Linux
- **Auto-refreshing** — HTML polls `agents.json` every 60 seconds
- **Live data** — collector scripts read real Hermes configs (SOUL.md, config.yaml, honcho.json, gateway_state.json)
- **Interactive** — click any node to see agent details (model, provider, voice, toolsets, connections)
- **Animated** — glowing nodes, pulsing edges, traveling data dots, scanline effect
- **Zero dependencies** — pure HTML/CSS/Canvas, no build step

## Architecture

```
Machine A (Mac)         Machine B (Win/WSL)        Machine C (Linux)
┌─────────────────┐     ┌─────────────────┐        ┌─────────────────┐
│ collect_agents.py│     │ collect_agents.py│        │ collect_agents.py│
│ reads:           │     │ reads:           │        │ reads:           │
│  ~/.hermes/      │     │  ~/.hermes/      │        │  ~/.hermes/      │
│   SOUL.md        │     │   SOUL.md        │        │   SOUL.md        │
│   config.yaml    │     │   config.yaml    │        │   config.yaml    │
│   gateway_state  │     │   gateway_state  │        │   gateway_state  │
│   profiles/*     │     │   profiles/*     │        │   profiles/*     │
└────────┬────────┘     └────────┬────────┘        └────────┬────────┘
         │ writes                │ writes                    │ writes
         ▼                       ▼                           ▼
   mac_agents.json         win_agents.json           linux_agents.json
         │                       │                           │
         └───────────────────────┼───────────────────────────┘
                                 │ merge_agents.py
                                 ▼
                           agents.json
                                 │
                                 ▼
                      GitHub Actions Pages
                                 │
                                 ▼
                    https://countzer0.github.io/constellation/
```

## How Updates Flow

Each machine runs `constellation-update.sh` on a cron (hourly). The script:

1. **Pulls** the latest from `origin/main` (picks up other machines' recent updates)
2. **Collects** local agent data into `<machine>_agents.json` (only overwrites its own file)
3. **Merges** all `*_agents.json` files into `agents.json`
4. **Commits and pushes** to `main`
5. GitHub Actions deploys the updated page automatically

This means each machine only needs to know its own config — the repo carries the other machines' data between them.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
cd ~/.hermes/constellation
```

### 2. Configure for this machine

Edit `constellation-update.sh` — set the defaults at the top:

```bash
MACHINE="${1:-linux}"         # mac, win, or linux
DEFAULT_NAME="${2:-CLU}"      # Your default agent's display name
```

### 3. Test it manually

```bash
bash constellation-update.sh
```

This will:
- Collect your machine's data into `<machine>_agents.json`
- Merge all available machine files into `agents.json`
- Commit and push if there are changes

### 4. Set up the cron job

**Option A: System crontab (recommended)**

```bash
# Hourly update
(crontab -l 2>/dev/null; echo '0 * * * * /bin/bash ~/.hermes/constellation/constellation-update.sh >> /tmp/constellation-update.log 2>&1') | crontab -
```

**Option B: Hermes cron**

In a Hermes session:
```
Create a cron job: run ~/.hermes/constellation/constellation-update.sh every hour
```

## Machine Reference

| Machine | Tag | Hostname | Default Agent | Profiles | File |
|---------|-----|----------|---------------|----------|------|
| MacBook Pro | `mac` | Countzer0s-MacBook-Pro | Count Zer0 | buddha, hiro, wintermute | `mac_agents.json` |
| Win/WSL | `win` | Cyberspace-Seven | CLU | ares, caac | `win_agents.json` |
| Linux server | `linux` | ubuntu-4gb-hil-1 | CLU | silveroak | `linux_agents.json` |

## Adding a New Machine

1. Clone the repo on the new machine:
   ```bash
   git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
   ```
2. Edit `constellation-update.sh` — set `MACHINE` and `DEFAULT_NAME`
3. Run `bash constellation-update.sh` to test
4. Set up the crontab (see above)

The new machine's data will automatically appear in the merged `agents.json` on next push.

## Adding a New Agent (Profile)

1. Create a profile directory: `~/.hermes/profiles/myagent/`
2. Add `SOUL.md` with identity info (Name, Title, Voice, Role)
3. Add `config.yaml` with model/provider settings
4. Re-run `bash constellation-update.sh` — the collector auto-discovers profiles

## GitHub Pages Setup

Already configured via `.github/workflows/pages.yml`. Every push to `main` triggers a deploy.

1. Go to repo Settings → Pages
2. Source: "GitHub Actions"
3. Done — live at `https://countzer0.github.io/constellation/`

## File Reference

| File | Purpose |
|------|---------|
| `collect_agents.py` | Reads local Hermes configs, outputs machine-specific JSON |
| `merge_agents.py` | Merges multiple machine JSON files into one `agents.json` |
| `constellation-update.sh` | All-in-one: collect → merge → commit → push |
| `agents.json` | The merged data source (auto-generated, do not edit) |
| `index.html` | Interactive visualization (loads `agents.json` at runtime) |
| `*_agents.json` | Per-machine data (auto-generated by collector) |

## CLI Reference

### collect_agents.py

```
python3 collect_agents.py [OPTIONS]

Options:
  --machine TAG     Machine identifier: mac, win, linux, etc.
  --default-name    Display name for the default agent (e.g., "CLU")
  -o, --output      Output file path (default: stdout)
```

### merge_agents.py

```
python3 merge_agents.py INPUT1 INPUT2 [INPUT3 ...] [OPTIONS]

Options:
  -o, --output      Output file path (default: stdout)
```

## Customization

### Changing colors

Edit the `COLOR_MAP` in `collect_agents.py`:

```python
COLOR_MAP = {
    "count":      "#00e5ff",  # cyan
    "hiro":       "#ff2d7b",  # pink
    "buddha":     "#ffd700",  # yellow
    "wintermute": "#b24dff",  # purple
    "clu":        "#ff8c00",  # orange
    "caac":       "#ff6b6b",  # red
    "ares":       "#e055ff",  # magenta
}
```

## View

https://countzer0.github.io/constellation/

## License

MIT
