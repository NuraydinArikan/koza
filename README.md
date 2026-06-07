# KOZA - Anonymous Peer-to-Peer Therapy & Support Network

![Koza Badge](https://img.shields.io/badge/Koza-Anonymous%20Support-blue)
![License](https://img.shields.io/badge/license-AGPL--3.0-green)
![Status](https://img.shields.io/badge/status-Active%20Development-orange)

**Making mental health support accessible, safe, and truly anonymous.**

Koza is a peer-to-peer support platform designed with **absolute anonymity and privacy** as the foundation. Unlike traditional therapy apps or dating platforms, Koza:

- 🎭 **Masks your voice and appearance** in real-time using formant shifting and 3D avatars
- 🔐 **Encrypts everything** - server never sees your real identity or conversation content
- 🗑️ **Auto-destroys all data** - messages and sessions expire and purge automatically
- 🧠 **Matches semantically** - connects you with people who understand, not by looks
- 📞 **WebRTC P2P** - direct peer connections with relay-only signaling

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+ with pgvector extension
- Firebase project (for signaling)
- Modern browser with WebRTC support

### Installation

```bash
# Clone repository
git clone https://github.com/koza-platform/koza.git
cd koza

# Install dependencies
npm install

# Setup environment
cp .env.example .env.local

# Initialize database
npm run db:migrate

# Start development server
npm run dev
```

Visit `http://localhost:5173`

## Architecture Overview

```
User A (Masked)                     User B (Masked)
    ↓                                   ↓
[Voice Masking]                   [Voice Masking]
[Avatar Rendering]                [Avatar Rendering]
    ↓                                   ↓
[Client-Side Encryption] ←→ [WebRTC P2P Connection] ←→ [Client-Side Decryption]
    ↓                                   ↓
[Supabase/Firebase]              [Relay-Only Signaling]
[Zero-Knowledge Auth]            [No Message Content]
    ↓                                   ↓
[PostgreSQL + Triggers]          [Auto-Purge on Timer]
[Auto-Masking Filters]           [Session Destruction]
```

### Key Components

#### 1. Voice Masking (Formant Shifting)
- Real-time transformation using Web Audio API
- Presets: Warm Hearth, Gentle Breeze, Velvet Echo
- <50ms latency, zero external dependencies
- See: `src/audio/voiceMasker.ts`

#### 2. Identity-Preserving Avatars
- MediaPipe face tracking (on-device only)
- 3D avatars: Clay Figure, Nature Spirit, Origami
- Masks real appearance while preserving emotion
- See: `src/rendering/avatarRenderer.ts`

#### 3. Semantic Matching Engine
- OpenAI embeddings of onboarding answers
- pgvector for cosine similarity search
- No visual or demographic bias
- See: `src/matching/semanticMatcher.ts`

#### 4. WebRTC P2P Architecture
- DTLS-SRTP encrypted by default
- Server acts as TURN relay only (asymmetric)
- ICE candidate exchange via Firebase
- See: `src/webrtc/peerConnection.ts`

#### 5. Zero-Knowledge Database
- PostgreSQL with automatic triggers
- PII masking on insert
- Session/message auto-purge on expiry
- See: `DATABASE_SCHEMA.sql`

## Development Workflow (Agent-Driven)

Koza uses an **agentic development pipeline** with Cursor, GitHub Copilot, and Claude Code:

```
Specification (SYSTEM_SPECIFICATION.md)
        ↓
GitHub Issue (with acceptance criteria)
        ↓
Agent Reads Issue
        ↓
Claude Code / Cursor generates:
  - Database migrations
  - API endpoints
  - UI components
  - Tests + security checks
        ↓
Automated Tests Run
        ↓
PR Created (ready to merge)
        ↓
Deploy via GitHub Actions
```

### Creating a Feature

1. **Write Spec**
   ```markdown
   # Feature: Warm Hearth Voice Preset
   
   Implement formant shifting preset with:
   - F1 shift: 0.95x
   - F2 shift: 0.92x
   - Real-time latency < 50ms
   ```

2. **Create GitHub Issue** with label `agent-friendly`

3. **Invoke Agent** (in Cursor or Claude Code)
   ```
   /generate "Implement Warm Hearth voice preset per issue #42"
   ```

4. **Agent outputs:**
   - `src/audio/voiceMasker.ts` (implementation)
   - `tests/unit/voiceMasker.test.ts` (unit tests)
   - `tests/integration/voicePresets.test.ts` (integration tests)

5. **Review & Merge**
   ```bash
   git add .
   git commit -m "feat: Add Warm Hearth voice preset (#42)"
   git push
   ```

## Testing

### Unit Tests
```bash
npm run test:unit
# Tests: Voice masking, encryption, utilities
# Coverage: >85%
```

### Integration Tests
```bash
npm run test:integration
# Tests: Database triggers, WebRTC flow, matching engine
# Requires: PostgreSQL, Firebase emulator running
```

### Security Tests
```bash
npm run test:security
# Tests: PII detection, encryption, no data leaks
# Checks: No plaintext in logs, no unencrypted messages in DB
```

### All Tests + Coverage
```bash
npm run test:coverage
# Opens coverage report in browser
```

## Database

### Schema
```bash
# View full schema
cat DATABASE_SCHEMA.sql

# Apply to development database
npm run db:migrate

# Reset (warning: deletes all data)
npm run db:rollback && npm run db:migrate
```

### Key Tables
- `users` - Minimal PII, hashed auth
- `session_rooms` - Ephemeral peer connections (expire on timer)
- `session_messages` - End-to-end encrypted (auto-delete)
- `topics` - Topics for Relief Circles
- `anonymization_log` - Audit trail (no PII)

### Safety Features
- **Auto-masking**: Phone numbers, emails → [REDACTED]
- **Auto-purge**: Sessions + messages deleted at timer.end
- **Row-Level Security**: Users only see own data
- **Encryption**: Messages encrypted before storage

## Deployment

### Staging
```bash
git checkout develop
git push  # Triggers CI/CD
# → Deploys to https://staging.koza.app
```

### Production
```bash
git checkout main
git merge develop
git push  # Triggers CI/CD
# → Deploys to https://koza.app
# → Runs database migrations
# → Executes smoke tests
```

### Manual Deploy
```bash
npm run build
npm run deploy:production
```

## Configuration

### Environment Variables
```bash
# .env.local (development)
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_KEY=eyJhbGc...
VITE_FIREBASE_CONFIG={...}
DATABASE_URL=postgresql://user:pass@localhost:5432/koza

# .env.production
# (stored in GitHub Secrets)
```

### Voice Presets
Customize in `src/audio/voiceMasker.ts`:
```typescript
export const VOICE_PRESETS = {
  warm_hearth: {
    f1Ratio: 0.95,   // Lower formant
    f2Ratio: 0.92,
    f3Ratio: 0.90,
    pitchShift: -50
  },
  // ... add more presets
};
```

## Security

### Privacy-First Design
- ✅ No real names, emails, or phone numbers stored
- ✅ No IP logging (TURN relay only)
- ✅ No message history (auto-deleted)
- ✅ No metadata correlation
- ✅ Device fingerprinting (authentication only)

### Encryption
- **In Transit**: DTLS-SRTP (WebRTC native)
- **At Rest**: AES-256-GCM in PostgreSQL
- **Client**: All encryption/decryption in browser

### Compliance
- **GDPR** (EU): Automatic data deletion, no third-party sharing
- **KVKK** (Turkey): No unnecessary data collection, transparent privacy
- **Legal Positioning**: "Peer Support Network" NOT "Medical Service"

## Contributing

### Code Style
```bash
npm run lint
npm run format
npm run type-check
```

### PR Checklist
- [ ] Tests pass (`npm test`)
- [ ] No secrets in code
- [ ] No PII in logs
- [ ] Database migrations included (if needed)
- [ ] Security tests pass

### Commit Convention
```
feat: Add Warm Hearth voice preset (#42)
fix: Resolve WebRTC ICE candidate timeout
docs: Update voice masking algorithm
refactor: Simplify matching engine
test: Add security tests for PII detection
ci: Update GitHub Actions workflow
```

## Roadmap

### Phase 1 (Weeks 1-4): MVP
- [x] User onboarding + voice selection
- [x] Blind Confessional (1-on-1)
- [x] Voice masking algorithm
- [x] WebRTC P2P
- [x] Database schema + auto-purge
- [ ] Basic UI

### Phase 2 (Weeks 5-8): Features
- [ ] Relief Circles (3-4 people)
- [ ] Topic-based matching
- [ ] All avatar styles
- [ ] Web UI (complete)

### Phase 3 (Weeks 9-12): Safety
- [ ] Human moderation system
- [ ] Crisis hotline handoff
- [ ] Analytics dashboard
- [ ] Public beta

### Phase 4 (Weeks 13+): Sustainability
- [ ] Premium moderators ($4.99/mo)
- [ ] Nonprofit partnerships
- [ ] Mobile apps
- [ ] Internationalization

## Support & Contact

- 📧 **Email**: team@koza.app
- 🐛 **Issues**: GitHub Issues (no sensitive info)
- 💬 **Community**: Discord (invite-only)
- 📖 **Docs**: Read `docs/` folder

## License

Koza is licensed under **AGPL-3.0** - ensuring it remains open-source and benefits the community.

See `LICENSE` file.

## Acknowledgments

Built on the shoulders of giants:
- **Web Audio API** (Mozilla/W3C) for voice processing
- **MediaPipe** (Google) for face tracking
- **pgvector** (Supabase) for semantic search
- **WebRTC** community for peer connectivity
- **Supabase** & **Firebase** for infrastructure

---

**Koza**: Because sometimes you just need to speak freely.

*Made with ❤️ for mental wellness.*
