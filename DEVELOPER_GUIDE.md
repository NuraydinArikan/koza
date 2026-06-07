# KOZA DEVELOPER GUIDE
**Building Koza with Agent-Driven Development**

## Getting Started

### 1. Setup Local Environment

```bash
# Clone repo
git clone https://github.com/koza-platform/koza.git
cd koza

# Install Node dependencies
npm install

# Copy environment file
cp .env.example .env.local

# Start Supabase locally (optional, for full local dev)
npm install -g supabase
supabase start

# Create local PostgreSQL database
createdb koza_dev

# Apply schema
psql koza_dev < DATABASE_SCHEMA.sql

# Run dev server
npm run dev
```

### 2. IDE Setup (Cursor or Windsurf Recommended)

**Cursor Setup:**
```
1. Install Cursor (https://cursor.com)
2. Open Koza folder
3. Enable "Composer" mode (Cmd+Shift+J)
4. Install extensions:
   - ESLint
   - Prettier
   - TypeScript Vue Plugin
```

**VS Code + Copilot Setup:**
```
1. Install GitHub Copilot extension
2. Install GitHub Copilot Chat
3. Install other extensions above
4. Settings: 
   - formatOnSave: true
   - defaultFormatter: esbenp.prettier-vscode
```

### 3. Using Claude Code (Terminal Agent)

```bash
# From terminal:
claude "Implement the Warm Hearth voice preset using formant shifting"

# Claude will:
# 1. Read current codebase
# 2. Generate implementation
# 3. Create/modify files
# 4. Run tests
# 5. Commit to git
```

---

## Architecture & File Structure

```
koza/
├── src/
│   ├── audio/
│   │   ├── voiceMasker.ts          # Main voice transformation engine
│   │   ├── formantDetector.ts       # FFT-based formant analysis
│   │   ├── voiceMasker.unit.test.ts
│   │   └── voicePresets.integration.test.ts
│   │
│   ├── rendering/
│   │   ├── avatarRenderer.ts        # 3D avatar + face tracking
│   │   ├── clayFigure.ts
│   │   ├── natureSpiritAvatar.ts
│   │   └── avatarRenderer.test.ts
│   │
│   ├── matching/
│   │   ├── semanticMatcher.ts       # LLM embedding + vector search
│   │   ├── queueManager.ts          # Multi-armed bandit matching
│   │   └── matching.integration.test.ts
│   │
│   ├── webrtc/
│   │   ├── peerConnection.ts        # WebRTC setup + ICE
│   │   ├── signalingServer.ts       # Firebase signaling
│   │   ├── turnRelay.ts
│   │   └── webrtc.integration.test.ts
│   │
│   ├── security/
│   │   ├── encryption.ts            # AES-256-GCM wrapper
│   │   ├── piiDetector.ts           # Regex + LLM-based PII detection
│   │   ├── autoMasking.ts           # Automatic redaction triggers
│   │   └── security.test.ts
│   │
│   ├── api/
│   │   ├── auth.ts                  # Device-based auth (no email/password)
│   │   ├── rooms.ts                 # Session room CRUD
│   │   ├── messages.ts              # Message encryption/decryption
│   │   ├── matching.ts              # Trigger semantic matching
│   │   └── users.ts                 # User preferences
│   │
│   ├── ui/
│   │   ├── Onboarding.tsx           # Voice/avatar selection
│   │   ├── BlindConfessional.tsx    # 1-on-1 room UI
│   │   ├── ReliefCircle.tsx         # Group room UI
│   │   ├── VoiceControl.tsx         # Preset selector
│   │   ├── AvatarDisplay.tsx        # Render masked avatar
│   │   └── components/
│   │
│   ├── store/
│   │   ├── authStore.ts            # Zustand auth state
│   │   ├── sessionStore.ts         # Current room state
│   │   └── userPrefsStore.ts       # Voice + avatar prefs
│   │
│   └── utils/
│       ├── fft.ts                  # FFT implementation
│       ├── encryption.ts           # Crypto utilities
│       └── logger.ts               # Safe logging (no PII)
│
├── tests/
│   ├── unit/
│   │   ├── voiceMasker.unit.test.ts
│   │   ├── encryption.unit.test.ts
│   │   └── piiDetector.unit.test.ts
│   │
│   ├── integration/
│   │   ├── webrtc.integration.test.ts
│   │   ├── database.integration.test.ts
│   │   └── matching.integration.test.ts
│   │
│   └── security/
│       ├── piiLeakage.security.test.ts
│       ├── encryption.security.test.ts
│       └── noDataLeaks.security.test.ts
│
├── DATABASE_SCHEMA.sql             # PostgreSQL schema
├── SYSTEM_SPECIFICATION.md         # Architecture doc
├── VOICE_MASKING_ALGORITHM.md      # Voice processing deep-dive
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .github/workflows/
    └── test-and-deploy.yml         # CI/CD pipeline
```

---

## Core Concepts

### 1. Voice Masking (Formant Shifting)

**How it works:**
```typescript
// User speaks: "I'm burnt out"
// 
// Audio → Windowing → FFT → Detect Formants → Shift → IFFT → Overlap-Add → Output
//
// Result: Same emotion, different voice identity
```

**Key files:**
- `src/audio/voiceMasker.ts` - Main processor
- `src/audio/formantDetector.ts` - FFT + peak finding
- `VOICE_MASKING_ALGORITHM.md` - Math details

**Testing voice masking:**
```bash
npm run test:unit -- voiceMasker.unit.test.ts
# Tests:
# - Hann window correctness
# - FFT and IFFT symmetry
# - Formant shift ratios
# - Latency < 50ms
```

### 2. Avatar Rendering (Identity Privacy)

**How it works:**
```typescript
// Browser: Face tracking via MediaPipe (on-device)
// MediaPipe detects: 468 face landmarks
// Map to 3D avatar points (no real face shown)
// Animate avatar based on detected expression
// Send avatar state only, never raw video
```

**Key files:**
- `src/rendering/avatarRenderer.ts`
- `src/rendering/clayFigure.ts`
- `src/rendering/natureSpiritAvatar.ts`

**Avatar pipeline:**
```
User Camera → MediaPipe (on-device) → Landmark Detection
                                            ↓
                                    Clay Figure Avatar
                                    (3D mesh)
                                            ↓
                                    WebGL Rendering
                                            ↓
                                    Send animation state only
                                    (no video, no image)
```

### 3. Semantic Matching (No Visual Bias)

**How it works:**
```typescript
// User A onboarding: "I'm burnt out from work, my boss doesn't listen"
// Embed with OpenAI: [0.234, -0.156, ..., 0.432]  // 1536-dim vector
//
// Database: Find similar users using pgvector
// SELECT * FROM users 
// WHERE answer_embedding <-> [vector] < 0.3
// ORDER BY <-> ASC
// LIMIT 5
//
// Result: 5 users with similar struggles (no photos, names, or ages)
```

**Key files:**
- `src/matching/semanticMatcher.ts`
- `src/matching/queueManager.ts` (Thompson sampling)

### 4. WebRTC Peer Connection (No Server Middleman)

**How it works:**
```
User A                    Signaling Server (Firebase)              User B
  ↓                              ↓                                   ↓
Generate SDP offer       ← Store SDP offer →                        ↓
  ↓                              ↓                                   ↓
  ← Retrieve SDP answer ← Store SDP answer →   Generate SDP answer
  ↓                              ↓                                   ↓
Exchange ICE candidates  ← TURN relay candidates →
  ↓                              ↓                                   ↓
═════════════════════════════════════════════════════════════════════
║        Direct P2P Connection (DTLS-SRTP Encrypted)              ║
║                                                                   ║
║  Audio/Video Stream (Encrypted by Browser)                      ║
║  Server sees: ??? (no decryption)                               ║
║                                                                   ║
═════════════════════════════════════════════════════════════════════
```

**Key files:**
- `src/webrtc/peerConnection.ts`
- `src/webrtc/signalingServer.ts` (Firebase integration)

### 5. Zero-Knowledge Database

**How it works:**
```sql
-- User types: "Call me at 555-1234"
--
-- 1. Browser encrypts before sending
INSERT INTO session_messages (
  content_encrypted  -- AES-256-GCM encrypted
)

-- 2. PostgreSQL trigger fires
trigger: detect_and_mask_pii()

-- 3. Detected: Phone number
UPDATE session_messages SET 
  has_pii_detected = true,
  pii_detected_fields = ['phone_number'],
  content_masked_version = 'Call me at [PHONE_REDACTED]'

-- 4. Auto-purge scheduled
UPDATE session_messages SET 
  expires_at = now() + INTERVAL '1 hour'

-- 5. At timer expiry:
DELETE FROM session_messages WHERE expires_at <= now()
```

**Key files:**
- `DATABASE_SCHEMA.sql` - Full schema
- `src/security/piiDetector.ts`
- `src/security/autoMasking.ts`

---

## Common Development Tasks

### Task 1: Add a New Voice Preset

**File:** `src/audio/voiceMasker.ts`

```typescript
export const VOICE_PRESETS: Record<string, VoicePreset> = {
  // ... existing presets
  
  // NEW: Add this
  midnight_whisper: {
    name: 'midnight_whisper',
    f1Ratio: 0.88,    // Very low formant
    f2Ratio: 0.85,
    f3Ratio: 0.87,
    pitchShift: -150  // Very deep voice
  }
};
```

**Test:** `tests/unit/voiceMasker.unit.test.ts`

```typescript
test('should handle midnight_whisper preset', () => {
  const masker = new VoiceMasker(
    audioContext,
    VOICE_PRESETS.midnight_whisper
  );
  
  // Verify formant ratios
  expect(masker['currentPreset'].f1Ratio).toBe(0.88);
  
  // Verify latency
  // ... test processing time
});
```

### Task 2: Add a New Avatar Style

**File:** `src/rendering/geometricAvatar.ts` (new file)

```typescript
export class GeometricAvatar extends AvatarBase {
  private mesh: THREE.Mesh;
  
  constructor(scene: THREE.Scene) {
    super(scene);
    this.createGeometry();
  }
  
  private createGeometry() {
    const geometry = new THREE.IcosahedronGeometry(1, 4);
    const material = new THREE.MeshPhongMaterial({ color: 0x888888 });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
  }
  
  updateExpression(landmarks: Landmark[]) {
    // Map face landmarks to mesh deformation
  }
}
```

### Task 3: Add Database Migration

**File:** `migrations/2024_06_07_add_new_feature.sql`

```sql
-- Migration: Add new_feature_flag to users table

ALTER TABLE users ADD COLUMN new_feature_flag BOOLEAN DEFAULT false;

CREATE INDEX idx_users_new_feature ON users(new_feature_flag);

-- Rollback: ALTER TABLE users DROP COLUMN new_feature_flag;
```

**Apply migration:**
```bash
npm run db:migrate
```

### Task 4: Add a Test

**File:** `tests/security/noPhoneNumbersLogged.security.test.ts`

```typescript
describe('Security: PII Logging Prevention', () => {
  test('should never log phone numbers', async () => {
    const logCapture = [];
    const originalLog = console.log;
    console.log = (msg) => logCapture.push(msg);
    
    // Simulate PII in message
    const message = 'Call me at 555-1234';
    
    // Process through system
    await processMessage(message);
    
    // Verify no phone in logs
    const combined = logCapture.join(' ');
    expect(combined).not.toMatch(/555-1234/);
    expect(combined).not.toMatch(/\d{3}-\d{4}/);
    
    console.log = originalLog;
  });
});

// Run:
// npm run test:security -- noPhoneNumbersLogged.security.test.ts
```

---

## Testing

### Run Tests Locally

```bash
# All tests
npm test

# Only unit tests
npm run test:unit

# Only integration tests (requires PostgreSQL)
npm run test:integration

# Only security tests
npm run test:security

# With coverage
npm run test:coverage

# Watch mode
npm run test -- --watch
```

### Writing Tests

**Unit Test Pattern:**
```typescript
// file.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { MyComponent } from './file';

describe('MyComponent', () => {
  beforeEach(() => {
    // Setup
  });
  
  test('should do X when Y', () => {
    const result = myFunction(input);
    expect(result).toBe(expected);
  });
});
```

**Integration Test Pattern:**
```typescript
import { test, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

test('should create session and auto-purge', async () => {
  const db = createClient(...);
  
  // Setup: Create session
  const { data: session } = await db.from('session_rooms').insert({...});
  
  // Act: Wait for expiry
  await new Promise(r => setTimeout(r, 5000));
  
  // Assert: Verify purge
  const { data: purged } = await db
    .from('session_rooms')
    .select('is_purged')
    .eq('id', session.id);
  
  expect(purged[0].is_purged).toBe(true);
});
```

---

## Debugging

### Enable Detailed Logging

```typescript
// In .env.local
VITE_LOG_LEVEL=debug

// In code
import { logger } from '@/utils/logger';
logger.debug('Processing voice', { preset, sampleRate });
```

### Browser DevTools

**Chrome DevTools → Sources:**
```
1. Set breakpoint in voiceMasker.ts
2. Speak into mic
3. Breakpoint hits
4. Inspect FFT spectrum, formants, etc.
```

**Performance Profiling:**
```
1. DevTools → Performance
2. Start recording
3. Speak into mic
4. Stop recording
5. Analyze: Should be < 50ms per frame
```

### Database Debugging

```bash
# Connect to local database
psql koza_dev

# View session messages
SELECT id, created_at, has_pii_detected 
FROM session_messages 
LIMIT 5;

# Check auto-purge status
SELECT id, expires_at, is_purged 
FROM session_rooms 
ORDER BY created_at DESC 
LIMIT 5;

# Verify triggers
\df+ auto_purge_session
```

---

## Performance Optimization

### Web Audio API

**Latency targets:**
```
Hann Window:     ~2ms
FFT (2048):      ~5ms
Formant Detect:  ~3ms
Formant Shift:   ~2ms
IFFT:            ~5ms
Overlap-Add:     ~1ms
Total:           ~18ms ✓ (under 50ms target)
```

**If latency is high:**
```typescript
// 1. Reduce FFT size (less accurate but faster)
const fft = new FFT(1024);  // was 2048

// 2. Reduce formant detection precision
// (search fewer frequency bins)

// 3. Use AudioWorklet instead of ScriptProcessorNode
// (off-main-thread processing)
```

### Database Queries

**Optimize semantic search:**
```sql
-- Add index on vector column
CREATE INDEX idx_answer_embedding ON users USING ivfflat(
  answer_embedding vector_cosine_ops
) WITH (lists = 100);

-- Query should be < 100ms on 1M rows
EXPLAIN (ANALYZE) 
SELECT * FROM users 
WHERE answer_embedding <-> '[...]'::vector < 0.3
LIMIT 5;
```

### Build Size

```bash
# Check bundle size
npm run analyze

# If too large (> 2MB):
# 1. Tree-shake unused code: npm run build -- --minify
# 2. Lazy-load components: React.lazy()
# 3. Remove unused dependencies
```

---

## Submitting Pull Requests

### Before You Push

```bash
# 1. Format code
npm run format

# 2. Lint
npm run lint

# 3. Type check
npm run type-check

# 4. Run tests
npm test

# 5. Security audit
npm run security:audit
```

### PR Template

```markdown
## Description
Briefly describe what this PR does.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation

## Testing
Describe how to test this change.

## Checklist
- [ ] Tests pass
- [ ] No new secrets/PII in code
- [ ] Documentation updated
- [ ] Security tests pass (if applicable)
```

### Example PR

```
Title: feat: Add Warm Hearth voice preset

Description:
Implements the Warm Hearth voice preset using formant shifting 
(0.95x F1, 0.92x F2, 0.90x F3, -50 cent pitch shift).

Testing:
- All voiceMasker unit tests pass
- Real-time latency verified < 50ms on device
- Perceptual testing: naturalness 8/10, emotion clarity 9/10

Checklist:
✅ Tests pass
✅ No PII in code or logs
✅ Voice masking security tests pass
```

---

## Troubleshooting

### "Microphone not working"
```
1. Check browser permissions
2. Verify https (required for getUserMedia)
3. Check browser support: https://caniuse.com/webrtc
4. Test with: npm run test:integration -- webrtc
```

### "WebRTC connection fails"
```
1. Check Firebase signaling running
2. Verify TURN relay available
3. Check firewall (STUN ports 3478, TURN ports 3478-3479)
4. Logs: check connection_heartbeat table
```

### "Auto-purge not working"
```
1. Verify PostgreSQL triggers created:
   psql koza_dev -c "\df+ auto_purge_session"
   
2. Check scheduled deletion job running:
   SELECT pg_stat_activity FROM pg_stat_activity;
   
3. Manually trigger purge:
   psql koza_dev -c "SELECT auto_purge_session();"
```

---

## Resources

- **Web Audio API**: https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API
- **WebRTC**: https://www.w3.org/TR/webrtc/
- **pgvector**: https://github.com/pgvector/pgvector
- **MediaPipe**: https://developers.google.com/mediapipe
- **OpenAI API**: https://platform.openai.com/docs

---

**Questions?** Open an issue on GitHub or reach out to team@koza.app
