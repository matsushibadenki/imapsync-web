# Imapsync Studio

Imapsync Studio is a local web GUI for configuring, previewing, running, and monitoring `imapsync` mailbox migrations.

It provides a safer and friendlier interface around the `imapsync` command-line tool, including connection settings, migration options, readiness checks, command preview, progress indicators, and live logs.

## Features

- Source and destination IMAP account setup
- SSL/TLS, STARTTLS, and plain IMAP port configuration
- Connection reachability test
- Dry-run-first workflow
- Common migration options such as folder subscription copy, folder auto-map, delete sync, UID comparison, and fast mode
- Date and bandwidth constraints
- Provider-safe pacing controls for large migrations
- Exclude patterns and advanced `imapsync` arguments
- Redacted command preview before execution
- Live log streaming with Server-Sent Events
- Japanese and English UI toggle
- Local draft saving without storing passwords

## Requirements

- Node.js
- npm
- `imapsync` installed and available in your shell `PATH`

Check that `imapsync` is available:

```sh
imapsync --version
```

## Setup

Install dependencies:

```sh
npm install
```

Start the local web server:

```sh
node server.js
```

Open the app:

```text
http://localhost:3000
```

You can change the port with the `PORT` environment variable:

```sh
PORT=8080 node server.js
```

## Recommended Workflow

1. Enter the source mailbox settings.
2. Enter the destination mailbox settings.
3. Use the connection test buttons to verify host and port reachability.
4. Keep dry run enabled for the first pass.
5. Click Preview to inspect the generated `imapsync` command.
6. Start the sync and watch the live logs.
7. Disable dry run only after the preview and logs look correct.

## Provider-Safe Migration

Large, continuous mailbox operations can be flagged by some providers as spam-like or suspicious account activity. Use Provider-safe mode for first runs or for consumer mail providers.

Provider-safe mode adds conservative defaults when related fields are empty:

- `--maxmessagespersecond 0.5`
- `--maxbytespersecond` when bandwidth is set
- `--maxbytesafter 50 MB`
- `--maxsleep 8`
- `--errorsmax 10`
- `--timeout1 180 --timeout2 180`

For very sensitive accounts, also consider:

- Running a dry run first
- Migrating by date range
- Setting a per-run transfer limit
- Avoiding delete sync until the final pass
- Running during normal business hours for business accounts
- Waiting between large accounts instead of migrating every mailbox at once

## Security Notes

- Passwords are sent only to the local Node.js server when previewing or running a sync.
- Command previews redact passwords.
- Password fields are not saved to local storage.
- The backend uses `spawn()` with an argument array instead of shell string execution.

Run this tool only on a trusted local machine, and avoid exposing the server to public networks.

## API Endpoints

- `GET /api/status` returns the current process state.
- `POST /api/preview` returns a redacted `imapsync` command preview.
- `POST /api/test-connection` checks TCP/TLS reachability for an IMAP endpoint.
- `POST /api/sync` starts an `imapsync` process.
- `POST /api/stop` stops the running process.
- `GET /logs` streams logs via Server-Sent Events.

## Project Structure

```text
.
├── public/
│   └── index.html
├── server.js
├── package.json
├── package-lock.json
└── README.md
```

## License

ISC
