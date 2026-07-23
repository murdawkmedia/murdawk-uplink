# Security Policy

## Reporting A Vulnerability

Please report suspected vulnerabilities privately through GitHub's **Report a vulnerability** security-advisory flow. Do not open a public issue containing credentials, private object URLs, logs, or reproduction data from a real storage account.

Include the affected version, expected behavior, observed behavior, and a minimal fictional reproduction when possible.

## Credential Boundary

Murdawk Uplink delegates DigitalOcean Spaces authentication to rclone. Credentials remain in the user's local rclone configuration, commonly:

```text
%APPDATA%\rclone\rclone.conf
```

The app persists non-secret connection metadata such as the rclone profile name, Space name, endpoint, and display name. It must not persist raw access keys or secret keys in application settings, job records, logs, manifests, or this repository.

Never commit:

- DigitalOcean access keys, API tokens, or secret keys
- `rclone.conf`, `s3cmd.ini`, or `.env` files
- exported connection packages
- local event manifests or media inventories
- run logs, private object URLs, or personal filesystem paths

Rotate a credential immediately if it appears in a screenshot, log, issue, chat, or commit.

## Connection Packages

Connection exports omit credentials and navigation history by default. Including credentials requires an explicit warning acknowledgement and a password of at least 12 characters. Key-bearing packages use scrypt and AES-256-GCM; an incorrect password or modified package is rejected before profile creation.

There is no password or key recovery. Send a package and its password through separate channels. Treat every exported package as private, even when it does not contain credentials.

## Local Automation

Automation binds only to `127.0.0.1` and requires a revocable bearer key protected with Electron `safeStorage`. API keys and MCP configuration values are shown once and cannot be revealed later.

The local API and MCP adapter allow browsing, activity reads, queue reads, and queue preparation. They do not expose credentials, start real uploads, or provide remote delete, move, rename, or connection-export operations.

## Downloads, Previews, And Logs

Downloads and previews use read-only rclone operations. Private previews are copied into an app-owned bounded cache, and the renderer never receives Spaces credentials. Durable logs are local, bounded, and credential-redacted, but should still be treated as private diagnostic material.

Transfer completion requires verification. A reported rclone progress value of 100 percent is not by itself a successful result.
