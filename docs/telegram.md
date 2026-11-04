# Telegram

Talk to the agent from your phone. `nexus telegram` runs a private bot: your messages become tasks for an agent
working in a folder you choose, and its replies, approvals and questions come back as Telegram messages and buttons.

## Set it up

Run `nexus setup` and choose **Set up a Telegram bot** at the last step:

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name, and paste the token it gives
   you. The wizard checks it with Telegram.
2. Send any message to your new bot. The wizard sees it, shows you which account sent it, and asks before allowing
   it. (You can also type your user id. [@userinfobot](https://t.me/userinfobot) tells you yours.)
3. Choose the folder the bot works in.

The token is stored in `auth.json` with owner-only permissions, like API keys; `config.json` only holds who is
allowed and the folder:

```json
{ "telegram": { "allowedUsers": [123456789], "cwd": "/home/you/projects/app" } }
```

`NEXUS_TELEGRAM_TOKEN` overrides the stored token (handy for containers).

## Run it

```sh
nexus telegram                  # works in telegram.cwd, or the current folder
nexus telegram --cwd ~/projects/other
```

It long-polls Telegram, so it works from a home network without opening a port or a webhook. Keep it running in a
terminal, `tmux`, or as a service:

```ini
# ~/.config/systemd/user/nexus-telegram.service
[Unit]
Description=NexusHarness Telegram bot
After=network-online.target

[Service]
ExecStart=%h/.local/bin/nexus telegram
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now nexus-telegram
loginctl enable-linger "$USER"   # keep it running when you are logged out
```

## Using it

Send a message to start a task. While it works, a progress message lists the steps it takes. When the task ends,
that message shows the number of steps, the speed and how full the context is. Send more messages to steer it
mid-task.

- **Approvals** (approval mode `ask` or `edits`) arrive with **Allow**, **Always** and **Deny** buttons. Instead of a
  button, you can reply with text: that denies the action and tells the agent what to do instead.
- **Questions** from the agent come with its options as buttons, or reply with your own answer.

| Command     | What it does                                                     |
| ----------- | ---------------------------------------------------------------- |
| `/new`      | Start a new conversation                                         |
| `/continue` | Pick up the latest saved conversation in the folder              |
| `/stop`     | Stop the current task                                            |
| `/status`   | Model, approval mode, sandbox, context, last speed and folder    |
| `/mode`     | Show or set approvals: `/mode ask`, `edits`, `auto` or `plan`    |
| `/model`    | Show or switch the model: `/model ollama/qwen3:8b`               |
| `/context`  | Show or set the context window: `/context 128k`, `/context auto` |
| `/compact`  | Summarise the older conversation now                             |
| `/help`     | List the commands                                                |

Conversations are saved like terminal ones, so `nexus --continue` in the same folder can pick up what you started
from your phone, and the other way round with `/continue`.

## Security

A bot that can run tools is a remote shell for whoever can talk to it, so:

- **Only allowed users get an answer, and only in private chats.** Group messages are ignored. A stranger who
  messages the bot is told their user id once (so you can add someone on purpose) and nothing else; no agent is
  started for them.
- **Only your user config decides who is allowed.** A project's `.nexusharness/config.json` cannot set `telegram`,
  even when the project is trusted.
- **The token never appears in logs or errors.** Request URLs contain it, so errors leave them out. Bot tokens are
  also redacted from tool output, like other secrets.
- **The usual approval mode and sandbox apply.** The bot works through the same approval and sandbox rules as the
  terminal. `ask` with buttons is a good default for a phone.
