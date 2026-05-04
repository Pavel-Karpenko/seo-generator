# SEO Generator

Generates complete SEO content for product pages using a local LLM via Ollama and Flowise. Accepts a product name, category, and keywords — returns a structured JSON with title, meta description, H1, body description, and bullet points.

## What you get

```json
{
  "title": "Wireless Noise-Cancelling Headphones | Premium Sound",
  "meta_description": "Experience crystal-clear audio with 40h battery life. Shop wireless headphones with active noise cancellation. Free shipping. Order now.",
  "h1": "Wireless Noise-Cancelling Headphones for Immersive Sound",
  "description": "Designed for audiophiles and remote workers alike, these headphones deliver...",
  "bullets": [
    "Active noise cancellation blocks up to 35dB of ambient sound",
    "40-hour battery life with fast-charge (10 min = 3 hours)",
    "Foldable design with premium carrying case included",
    "Compatible with all Bluetooth 5.0 devices"
  ]
}
```

## Why it's useful

- **E-commerce teams** — generate SEO copy for hundreds of products without a copywriter
- **Developers** — drop-in API for any product catalog or CMS
- **Privacy-first** — runs fully locally, no data sent to external AI providers
- **Scalable** — BullMQ queue protects the LLM from overload; multiple NestJS instances share the same Redis and queue

---

## Architecture

```
POST /api/generate-seo  →  BullMQ (Redis)  →  Worker  →  Flowise  →  Ollama
                                                   ↓
                                          Redis pub/sub
                                                   ↓
GET /api/seo/:jobId/stream  ←────────── SSE stream (tokens)
```

- **NestJS** handles HTTP, validation, and SSE streaming
- **BullMQ** (concurrency: 2) queues requests so Ollama is never overloaded
- **Flowise** orchestrates the LLM chain with prompt templating and Redis-backed chat history
- **Ollama** runs `qwen2.5:3b` locally — fast, lightweight, good at structured JSON output

---

## Requirements

- Node.js 20+
- Docker & Docker Compose
- [Ollama](https://ollama.com) installed on the host machine

---

## Setup

### 1. Install Ollama

Download and install from [ollama.com](https://ollama.com/download), then pull the model:

```bash
ollama pull qwen2.5:3b
```

Verify it works:

```bash
ollama run qwen2.5:3b "say hello in JSON"
```

> `qwen2.5:3b` requires ~2 GB RAM and runs well on Apple Silicon and modern laptops.

### 2. Start Redis and Flowise

```bash
docker compose up redis flowise -d
```

Wait for Flowise to be ready (usually ~20 seconds):

```bash
docker compose logs -f flowise
# Look for: "Flowise Server is listening..."
```

### 3. Import the Flowise chatflow

1. Open Flowise at [http://localhost:3001](http://localhost:3001)
   - Default credentials: `admin` / `flowise_password`
2. Click **Add New** → **Import** → select `flowise/seo-chatflow.json`
3. In the chatflow, click on the **ChatOllama** node and confirm:
   - Base URL: `http://host.docker.internal:11434`
   - Model: `qwen2.5:3b`
4. Click **Save** and then **Deploy**
5. Copy the **Chatflow ID** from the URL bar (the UUID after `/chatflows/`)

### 4. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in the chatflow ID:

```env
FLOWISE_CHATFLOW_ID=your-chatflow-uuid-here
```

### 5. Install dependencies and start the API

```bash
npm install
npm run start:dev
```

The API is now running at [http://localhost:3000](http://localhost:3000).

---

## Usage

### Generate SEO content

```bash
curl -s -X POST http://localhost:3000/api/generate-seo \
  -H "Content-Type: application/json" \
  -d '{
    "product_name": "Wireless Noise-Cancelling Headphones",
    "category": "Electronics",
    "keywords": ["noise cancelling", "wireless", "bluetooth", "premium audio"]
  }' | jq
```

Response (202 Accepted):

```json
{
  "jobId": "a1b2c3d4-...",
  "streamUrl": "/api/seo/a1b2c3d4-.../stream"
}
```

### Stream the result (SSE)

```bash
curl -N http://localhost:3000/api/seo/a1b2c3d4-.../stream
```

You will receive a stream of events:

```
data: {"type":"token","data":"{\n  \"title\":"}

data: {"type":"token","data":"\"Wireless Noise-Cancelling"}

...

data: {"type":"complete","data":{"title":"...","meta_description":"...","h1":"...","description":"...","bullets":[...]}}

data: {"type":"done"}
```

### With session history (multi-turn)

Pass a `session_id` to maintain chat history across requests:

```bash
curl -s -X POST http://localhost:3000/api/generate-seo \
  -H "Content-Type: application/json" \
  -d '{
    "product_name": "Wireless Headphones Pro",
    "category": "Electronics",
    "keywords": ["premium", "studio quality"],
    "session_id": "user-123-session-abc"
  }'
```

### Health check

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "redis": "ok",
  "flowise": "ok",
  "uptime": 142
}
```

---

## Running with Docker (full stack)

Build and run everything including the NestJS app:

```bash
# Copy and fill in your chatflow ID first
cp .env.example .env

docker compose up --build -d
```

> Make sure Ollama is running on the host before starting the stack.  
> Flowise connects to it via `host.docker.internal:11434`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `FLOWISE_BASE_URL` | `http://localhost:3001` | Flowise API base URL |
| `FLOWISE_CHATFLOW_ID` | — | **Required.** ID of the imported chatflow |
| `FLOWISE_API_KEY` | — | Optional API key if Flowise auth is enabled |
| `FLOWISE_TIMEOUT_MS` | `90000` | Timeout for LLM calls (ms) |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `QUEUE_CONCURRENCY` | `2` | Max concurrent Ollama requests |

---

## Project structure

```
src/
├── seo/              # Controller, service, DTO, Zod schema
├── flowise/          # HTTP client with SSE parser and typed errors
├── queue/            # BullMQ processor (worker)
├── common/           # Exception filter, interceptors (timeout, correlation-id)
├── config/           # Config factories for app / flowise / redis
└── health/           # Health check endpoint
flowise/
└── seo-chatflow.json # Importable Flowise chatflow
```

## License

MIT
