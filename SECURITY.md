# Security Policy

## Secrets

Never commit these files or values:

- `.env`
- `data/browser-profile/`
- Telegram Bot Token
- Layer3 password or authenticated browser cookies

The provided setup script writes `.env` with mode `600`. Restrict access to the deployment server and rotate both the Telegram token and Layer3 password if either value is exposed.

## Bot access

Only chat IDs in `TELEGRAM_ALLOWED_CHAT_IDS` are accepted. Unauthorized updates are ignored. Use a private Telegram chat and do not add the bot to public groups.

## Power operations

The Layer3 console currently exposes `Power Off`. It may interrupt disk writes. Save data and stop applications before invoking it. The project deliberately does not expose VM deletion or destructive storage operations.
