# Mana AI — Your AI. Your World.

**Mana AI** is a personal AI assistant and friend designed to deliver short, warm, and accurate answers, learn your preferences over time, and provide real-time web search with source citations whenever current information is needed.

---

## ✨ Highlights

### 1. Personal AI Friend
- **Warm & Casual**: Communicates naturally like a trusted friend—direct, conversational, and helpful without robotic filler or formal preamble.
- **Context & Continuity**: Remembers who you are and what you're discussing, avoiding unnecessary repetition.
- **Honest & Direct**: Honest when uncertain; never invents facts.

### 2. Useful Long-Term Memory
- **Learns Preferences**: Automatically remembers your name, coding preferences, topics of interest, and corrections.
- **Mana's Memory & Preferences**: Click the 🧠 icon in the header or sidebar to inspect, add, edit, or delete stored memories anytime.
- **Persistent Across Chats**: Starting a new chat clears the conversation window without wiping your long-term preferences.

### 3. Continuous Improvement System
- **Real Feedback**: Click **👍 Helpful** or **👎 Not helpful** on any answer.
- **Inline Corrections**: Add quick feedback to teach Mana AI how to improve future answers.
- **Feedback Store**: Feedback and corrections are persisted locally and applied to future answers.

### 4. Intelligent Real-Time Web Search
- **Smart Auto-Detection**: Searches the live web only when live information is needed (cricket scores, breaking news, weather, prices, technical docs).
- **Zero-Key DuckDuckGo Search**: Instant live web search works out of the box with zero API keys or subscriptions required.
- **Real Image Search**: Requests for existing photos and visual references return a responsive, source-attributed gallery; generated images remain a separate feature.
- **Search Privacy**: Auto, On, and Off follow the composer setting. Off prevents image searches and pauses remote image previews.
- **Source Links**: Image cards link to the originating website and original image. Image rights are not implied; check each site's license and reuse terms.

### 5. Original Minimalist ChatGPT Interface
- **Eagle Logo**: Theme-aware Mana AI eagle mark with a black wordmark.
- **Floating Input Capsule**: Sleek bottom input bar with auto-expanding textarea, 🌐 live search toggle, and circular send button.
- **No Clutter**: All legal disclaimers, Terms & Conditions, and onboarding interruptions have been completely removed.

### 6. Local File Upload and Analysis
- Use **+ → Upload files**, drag files into the conversation, or paste an image. Multiple files can be staged together.
- Uploads are stored under `DATA_DIR/conversation-files` (or `server/data/conversation-files` by default), indexed to the owning user and conversation, and retained across local restarts.
- Supported formats: PNG/JPG/JPEG/WEBP, text/Markdown, CSV, XLS/XLSX, DOC/DOCX, and PDF. Per-file limit: 15 MB; up to five staged files at once, 50 files per conversation, and 100 MB total per conversation.
- PDF text is indexed with page references. Up to 500 pages are processed per PDF; larger files are marked partial. Scanned PDF pages and image text use bundled, local English OCR. OCR is not sent to an external service.
- Spreadsheet extraction includes every worksheet (including hidden sheets), cell addresses, formulas, and cached/displayed values. Formulas are read, not recalculated.
- Private file contents are only used with local Ollama or Built-in AI. Image questions require a local Ollama model advertising vision support. Cloud-provider requests are blocked while a conversation has uploads.
- File uploads are disabled on cloud/serverless deployments so private files are not uploaded to remote storage. Run Mana AI locally to use this feature.

| Format/capability | Support |
|---|---|
| TXT, MD, CSV, XLS, XLSX, DOCX, and PDF text (up to 500 pages) | Text extraction and conversation-scoped retrieval |
| Scanned PDF and image OCR | Local English OCR; scanned PDF rendering depends on the local PDF renderer |
| Image understanding | Local Ollama vision model only; model capability is checked before sending |
| Legacy DOC | Partial; text extraction is supported, but complex Word layout/embedded objects may be incomplete |
| PDF/Word diagrams and image-heavy layouts | Partial; layout and embedded visual interpretation are not guaranteed |

Run the isolated parser/format regression tests with `npm run test:files`. This test uses a temporary data directory.

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run dev server (backend on 3001, frontend on 5173)
npm run dev
```

Open: **http://localhost:5173**

### Hosted Ollama

The default and primary provider is Ollama with `qwen2.5:3b` at `http://127.0.0.1:11434` for local development; no tunnel is needed locally. Optional hybrid fallback is controlled on the server with `AI_FALLBACK_ENABLED=true`, `AI_FALLBACK_PROVIDER=gemini`, `GEMINI_API_KEY`, and `GEMINI_MODEL`. Ollama connection failures, gateway availability errors, and timeouts may use Gemini only when enabled and a valid key is configured; authentication, invalid-request, and rate-limit errors do not trigger fallback. `OLLAMA_CONNECTION_TIMEOUT_MS` controls the Ollama request timeout (default: 8000 ms). Fallback handles a request without changing the saved provider selection, and status events identify when Gemini handled it.

For a hosted Mana AI deployment, configure `AI_API_BASE_URL` (or `OLLAMA_BASE_URL`) to the owner's HTTPS authenticated Ollama gateway and set `OLLAMA_API_KEY` in the server environment. The browser never receives this key. Never expose Ollama's port 11434 directly. If Ollama and enabled Gemini fallback are both unavailable, Mana AI returns a clear error.

---

© 2026 Mana AI — *Your AI. Your World.*
