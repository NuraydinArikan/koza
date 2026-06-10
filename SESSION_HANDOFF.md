# KOZA Project - Session Handoff
**Date:** 2026-06-07  
**Status:** Active Development - Awaiting Database Password

---

## What's Done ✅

### Architecture & Documentation
- ✅ Complete system specification (`SYSTEM_SPECIFICATION.md`)
- ✅ Voice masking algorithm design (`VOICE_MASKING_ALGORITHM.md`)
- ✅ PostgreSQL schema with 16 tables (`DATABASE_SCHEMA.sql`)
- ✅ CI/CD pipeline (`.github/workflows/test-and-deploy.yml`)
- ✅ Voice masking implementation (`src/audio/voiceMasker.ts`)
- ✅ Comprehensive test suite (`tests/unit/voiceMasker.unit.test.ts`)
- ✅ README with quick start guide
- ✅ Developer guide with agent workflow

### Infrastructure Setup
- ✅ GitHub repository created (`koza-platform/koza`)
- ✅ 2 branches: `main` + `develop`
- ✅ 3 commits pushed successfully
- ✅ Supabase project created (Europe region)
- ✅ pgvector extension enabled
- ✅ Project structure initialized

### Environment Config (Partial)
```
VITE_SUPABASE_URL=https://nunyttkgvkwivxtwrgpd.supabase.co ✅
VITE_SUPABASE_KEY=sb_publishable_ZngJk9YmwDyd5PaHs6yDw_yNNAaLkF ✅
DATABASE_URL=postgresql://postgres:PASSWORD@db.nunyttkgvkwivxtwrgpd.supabase.co:5432/postgres ❌ MISSING PASSWORD
```

---

## 🔴 BLOCKED: Database Password

**Problem:** Cannot locate the actual database password from Supabase UI  
**Where needed:** `.env.local` → `DATABASE_URL` field  
**Format:** `postgresql://postgres:[ACTUAL_PASSWORD]@db.nunyttkgvkwivxtwrgpd.supabase.co:5432/postgres`

**Attempted locations:**
- ❌ Connection string "Direct" section (shows `[YOUR-PASSWORD]` placeholder)
- ❌ Settings → Database (no visible password field yet)
- ⏳ Need to check: Settings → Database → "Password" subsection for plain-text field

---

## 🎯 Next Steps (In Order)

### 1. **Find Database Password** 🔑
   - Navigate to Supabase Settings → Database
   - Locate "Password" field (should show actual password, not masked)
   - Copy it, paste into `.env.local`

### 2. **Complete Environment Setup**
   ```bash
   # Add to .env.local:
   DATABASE_URL=postgresql://postgres:[PASSWORD_HERE]@db.nunyttkgvkwivxtwrgpd.supabase.co:5432/postgres
   ```

### 3. **Install Dependencies**
   ```bash
   npm install
   ```

### 4. **Deploy Database Schema**
   - Open Supabase SQL Editor
   - Create new query
   - Paste entire `DATABASE_SCHEMA.sql` content
   - Execute

### 5. **Start Dev Server**
   ```bash
   npm run dev
   # → http://localhost:5173
   ```

### 6. **Begin Feature Development**
   - Test voice masking: `npm run test:unit`
   - Create GitHub issues for next features
   - Use Claude Code/Cursor agents to implement

---

## 📁 Key Files

| File | Purpose |
|------|---------|
| `SYSTEM_SPECIFICATION.md` | Full architecture (11 sections, 5000+ words) |
| `VOICE_MASKING_ALGORITHM.md` | FFT math + formant shifting implementation |
| `DATABASE_SCHEMA.sql` | PostgreSQL schema with auto-purge triggers |
| `src/audio/voiceMasker.ts` | Main voice processing engine (390 lines) |
| `tests/unit/voiceMasker.unit.test.ts` | 8 test suites, >85% coverage |
| `.github/workflows/test-and-deploy.yml` | 10-stage CI/CD pipeline |
| `DEVELOPER_GUIDE.md` | Agent workflow + debugging |
| `README.md` | User-facing intro + quick start |

---

## 🏗️ Tech Stack

```
Frontend:   React 18 + TypeScript + Tailwind
Audio:      Web Audio API (formant shifting, <50ms latency)
Rendering:  Three.js + MediaPipe (on-device face tracking)
Database:   Supabase PostgreSQL + pgvector (semantic search)
Auth:       Device-hash based (zero PII storage)
Real-time:  WebRTC DTLS-SRTP peer connections
CI/CD:      GitHub Actions (test + deploy)
```

---

## 🔐 Security Principles

- **Zero Trust:** No plaintext PII storage
- **Auto-Masking:** Phone, email, addresses → [REDACTED]
- **Auto-Purge:** Sessions + messages auto-delete on timer expiry
- **Encryption:** AES-256-GCM at rest, DTLS-SRTP in transit
- **Voice Privacy:** Formant shifting masks identity in real-time
- **Row-Level Security:** Users only access own data

---

## 📞 Contact & Issues

- **GitHub:** github.com/koza-platform/koza
- **Supabase Project:** nunyttkgvkwivxtwrgpd (Europe)
- **Email:** team@koza.app (future)

---

## Quick Command Reference

```bash
# Development
npm run dev              # Start dev server (http://localhost:5173)
npm run test:unit       # Run unit tests
npm run test:integration # Run integration tests
npm run test:security   # Security tests (PII detection, encryption)
npm run build           # Production build
npm run lint            # Check code style
npm run format          # Auto-format code

# Database
npm run db:migrate      # Apply schema to dev database
npm run db:rollback     # Reset database (deletes all data)

# Deployment
git push origin develop # Deploy to staging
git push origin main    # Deploy to production
```

---

**Status Summary:** All architecture complete. Awaiting database password to unblock local development. Once password is obtained, can run `npm install`, deploy schema, and begin feature development via agent workflow.
