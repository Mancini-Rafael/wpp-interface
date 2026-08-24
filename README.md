# wpp-interface

WhatsApp bridge service that connects a WhatsApp account to an external AI agent via HTTP.

## What it does

- Connects to WhatsApp using the [Baileys](https://github.com/WhiskeySockets/Baileys) library (multi-device API, no browser required).
- Listens for incoming messages on a personal chat and/or a specific group chat.
- Forwards text messages to a configurable agent endpoint (`AGENT_URL`) over HTTP.
- Transcribes voice/audio messages through a configurable OpenAI-compatible transcription endpoint before forwarding.
- Exposes an HTTP API so the agent can send replies back through WhatsApp.
- Supports group chat with configurable trigger-word routing (`TRIGGER_WORD`).

## HTTP API

| Endpoint       | Method | Description                          |
|----------------|--------|--------------------------------------|
| `POST /send`   | POST   | Send a message to a WhatsApp JID    |
| `GET /health`   | GET    | Connection status                    |

### `POST /send`

```json
{ "jid": "5511999999999@s.whatsapp.net", "text": "Hello!" }
```

## Environment Variables

| Variable         | Required | Description                                      |
|------------------|----------|--------------------------------------------------|
| `MY_WA_JID`      | Yes      | Your WhatsApp JID (e.g. `5511...@s.whatsapp.net`) |
| `GROUP_JID`      | No       | Group JID to listen on. Only messages containing `TRIGGER_WORD` are forwarded. |
| `TRIGGER_WORD`   | No       | Group trigger word (default: `@agent`)            |
| `AGENT_URL`      | No       | Agent HTTP endpoint (default: `http://localhost:8788/message`) |
| `PORT`           | No       | HTTP server port (default: `8789`)                |
| `DISCOVER_MODE`  | No       | Set to `true` to log all incoming JIDs            |
| `TRANSCRIPTION_URL`     | No | Transcription endpoint (default: `https://api.openai.com/v1/audio/transcriptions`) |
| `TRANSCRIPTION_MODEL`   | No | Transcription model (default: `whisper-1`)        |
| `TRANSCRIPTION_API_KEY` | No | Bearer token for the transcription endpoint. Required for audio/voice messages. Falls back to `OPENAI_API_KEY`. |

### Using a different transcription provider

`TRANSCRIPTION_URL` accepts any endpoint that speaks the OpenAI
`/audio/transcriptions` contract — a multipart `file` + `model` request returning
`{ "text": "..." }`. Point it at Groq, a self-hosted whisper.cpp server, or anything
else that matches:

```sh
TRANSCRIPTION_URL=https://api.groq.com/openai/v1/audio/transcriptions
TRANSCRIPTION_MODEL=whisper-large-v3
TRANSCRIPTION_API_KEY=gsk_...
```

## Setup

1. Copy `.env.example` to `.env` and fill in your values.
2. Run with Docker Compose: `docker compose up`
3. Scan the QR code printed in the terminal with your WhatsApp app.
4. Auth state is persisted in `auth_info/` — subsequent restarts won't require re-scanning.

## Running locally (without Docker)

```sh
npm install
npm run dev   # uses nodemon for auto-restart
```

## License

MIT — see [LICENSE](LICENSE).
