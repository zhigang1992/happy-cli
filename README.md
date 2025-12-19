# Happy CLI (Fork)

> **This is a personal fork of [happy-cli](https://github.com/slopus/happy-cli) from the amazing [Happy](https://happy.engineering) project.**
>
> All credit goes to the original authors. I've made some tweaks for my own self-hosted setup, but my changes are too scattered and experimental to submit upstream. If you're looking for the official version, please visit [github.com/slopus/happy-cli](https://github.com/slopus/happy-cli).

## Fork Changes

- Renamed package to `@zhigang1992/happy-cli` for personal npm publishing
- Changed default server URLs to `happy-server.reily.app` and `happy.reily.app`
- Switched from yarn to bun
- Lazy download of tools to reduce package size (~110MB to ~186KB)
- Added image attachment support in messages
- Improved push notifications with folder name
- Various bug fixes and improvements

---

# Happy

Code on the go controlling claude code from your mobile device.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy-coder
```

## Usage

```bash
happy
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device
3. Allow real-time session sharing between Claude Code and your mobile app

## Commands

- `happy auth` – Manage authentication
- `happy codex` – Start Codex mode
- `happy connect` – Store AI vendor API keys in Happy cloud
- `happy notify` – Send a push notification to your devices
- `happy daemon` – Manage background service
- `happy doctor` – System diagnostics & troubleshooting

## Options

- `-h, --help` - Show help
- `-v, --version` - Show version
- `-m, --model <model>` - Claude model to use (default: sonnet)
- `-p, --permission-mode <mode>` - Permission mode: auto, default, or plan
- `--claude-env KEY=VALUE` - Set environment variable for Claude Code
- `--claude-arg ARG` - Pass additional argument to Claude CLI

## Environment Variables

- `HAPPY_SERVER_URL` - Custom server URL (default: https://happy-server.reily.app)
- `HAPPY_WEBAPP_URL` - Custom web app URL (default: https://happy.reily.app)
- `HAPPY_HOME_DIR` - Custom home directory for Happy data (default: ~/.happy)
- `HAPPY_DISABLE_CAFFEINATE` - Disable macOS sleep prevention (set to `true`, `1`, or `yes`)
- `HAPPY_EXPERIMENTAL` - Enable experimental features (set to `true`, `1`, or `yes`)

## Requirements

- Node.js >= 20.0.0
  - Required by `eventsource-parser@3.0.5`, which is required by
  `@modelcontextprotocol/sdk`, which we used to implement permission forwarding
  to mobile app
- Claude CLI installed & logged in (`claude` command available in PATH)

## License

MIT
