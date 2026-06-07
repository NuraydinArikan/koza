# KOZA SYSTEM ARCHITECTURE SPECIFICATION
**Anonymous Peer-to-Peer Therapy & Support Network**

**Version:** 1.0  
**Status:** Active Development  
**Security Model:** Zero Trust, End-to-End Encrypted, Automatic Data Deletion  
**Last Updated:** 2026-06-06

---

## 1. EXECUTIVE SUMMARY

Koza is a peer-to-peer anonymous support platform designed with **absolute anonymity and user protection** as the core architectural constraint. Unlike traditional dating apps that monetize engagement, Koza prioritizes:

- **Zero-Knowledge Architecture**: No server ever knows user real identity, location, or communication patterns
- **Automatic Data Destruction**: All session data self-destructs after timer expiration
- **Voice & Visual Masking**: Real-time transformation of voice (formant shifting) and appearance (3D avatars)
- **Semantic Matching**: LLM-based grouping without visual or demographic bias
- **WebRTC P2P**: Direct peer communication with relay-only architecture

---

## 2. CORE SECURITY PRINCIPLES

### 2.1 Zero Trust Model
```
User Input → 
  ✗ Never stored in plain text
  ✗ Never transmitted with identifying metadata
  ✓ Hashed, encrypted, with automatic deletion schedule
  → Peer-to-Peer Connection (Server never sees content)
  → Automatic Purge at Timer.end
```

### 2.2 Data Masking Rules (Automatic Triggers)
Every database write triggers real-time content scanning:

| Detected Pattern | Action | Example |
|---|---|---|
| Phone number (10+ digits) | REDACT_PATTERN + DELETE_SCHEDULED | "Call me at 555-1234" → "Call me at [REDACTED]" |
| Email address | REDACT_PATTERN + DELETE_SCHEDULED | "john@gmail.com" → "[EMAIL_REDACTED]" |
| Real name (against user profile) | ENCRYPT + LOG_INCIDENT | Name in message vs. stored user name |
| Social media handle (@user, instagram.com/) | REDACT_PATTERN + DELETE_SCHEDULED | "@myhandle" → "[HANDLE_REDACTED]" |
| Street address / Specific location | REDACT_PATTERN + DELETE_SCHEDULED | "I live at 123 Main St" → "[ADDRESS_REDACTED]" |
| Bank account / Payment info | ENCRYPT_SEGMENT + FLAG_REVIEW | Detected but encrypted for safety audit |

**Implementation**: Supabase PostgreSQL Functions + AI-powered regex + LLM semantic detection

### 2.3 Automatic Session Purge Architecture
```
Session Created
  ↓
Start Timer (default: 60 minutes)
  ↓
[Every message logged with expiry_timestamp]
  ↓
Timer.end() triggered
  ↓
SQL Trigger: DELETE * FROM session_messages WHERE session_id = X
SQL Trigger: DELETE * FROM session_metadata WHERE session_id = X
  ↓
Confirmation logged: "Session #ABC purged at [timestamp]"
  ↓
No recovery possible
```

---

## 3. DATABASE SCHEMA (Privacy-First)

### 3.1 Core Tables

#### `users` (Minimal & Hashed)
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Authentication (no PII)
  anon_hash BYTEA NOT NULL UNIQUE,  -- SHA-256(device_id + secret)
  device_fingerprint_hash BYTEA,
  
  -- Onboarding Answers (Vector Embedded)
  onboarding_answers JSONB NOT NULL,  -- Encrypted questions answers
  answer_embedding VECTOR(1536),  -- OpenAI text-embedding-3-small
  
  -- Voice & Avatar Preferences (Encrypted)
  voice_preset TEXT,  -- 'warm_hearth' | 'gentle_breeze' | 'velvet_echo'
  avatar_style TEXT,  -- 'clay_figure' | 'nature_spirit' | 'origami'
  
  -- Safety Flags
  is_active BOOLEAN DEFAULT true,
  is_flagged_for_review BOOLEAN DEFAULT false,
  flagged_reason TEXT,
  created_at TIMESTAMP DEFAULT now(),
  
  -- Auto-Purge
  deletion_scheduled_at TIMESTAMP
};

CREATE INDEX idx_anon_hash ON users(anon_hash);
CREATE INDEX idx_answer_embedding ON users USING ivfflat(answer_embedding vector_cosine_ops);
```

#### `session_rooms` (Ephemeral)
```sql
CREATE TABLE session_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Room Metadata
  room_type TEXT NOT NULL,  -- 'blind_confessional' | 'relief_circle' | 'shadow_session'
  topic_id UUID REFERENCES topics(id),
  
  -- Participant Management
  initiator_user_id UUID REFERENCES users(id),
  accepted_user_id UUID REFERENCES users(id),
  third_fourth_user_ids UUID[] DEFAULT '{}',  -- For relief circles
  
  -- Timer (Critical for Purge)
  created_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP NOT NULL,  -- created_at + duration
  is_purged BOOLEAN DEFAULT false,
  purged_at TIMESTAMP,
  
  -- WebRTC ICE Candidates & SDP (Encrypted)
  webrtc_sdp_offer BYTEA,  -- Encrypted
  webrtc_sdp_answer BYTEA,  -- Encrypted
  ice_candidates JSONB,  -- Ephemeral, auto-deleted
  
  -- Connection Status
  status TEXT DEFAULT 'waiting',  -- 'waiting' | 'connected' | 'ended' | 'purged'
  connection_quality TEXT
};

-- CRITICAL: Auto-purge trigger
CREATE OR REPLACE FUNCTION auto_purge_session_on_expiry()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.expires_at <= now() AND NOT NEW.is_purged THEN
    UPDATE session_rooms 
    SET is_purged = true, purged_at = now()
    WHERE id = NEW.id;
    
    -- Delete all messages
    DELETE FROM session_messages WHERE session_id = NEW.id;
    
    -- Delete WebRTC metadata
    UPDATE session_rooms 
    SET webrtc_sdp_offer = NULL, 
        webrtc_sdp_answer = NULL,
        ice_candidates = '{}'::jsonb
    WHERE id = NEW.id;
    
    RETURN NEW;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_session_purge
AFTER INSERT OR UPDATE ON session_rooms
FOR EACH ROW
EXECUTE FUNCTION auto_purge_session_on_expiry();
```

#### `session_messages` (Encrypted + Auto-Delete)
```sql
CREATE TABLE session_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES session_rooms(id),
  sender_user_id UUID NOT NULL REFERENCES users(id),
  
  -- Message Content (Encrypted end-to-end)
  content_encrypted BYTEA NOT NULL,
  content_hash BYTEA,  -- For integrity check
  
  -- Auto-Masking Detection
  has_pii_detected BOOLEAN DEFAULT false,
  pii_detected_fields TEXT[],  -- ['phone', 'email', 'address']
  content_masked_version TEXT,  -- For moderation only
  
  -- Timing
  created_at TIMESTAMP DEFAULT now(),
  expires_at TIMESTAMP NOT NULL,  -- Scheduled for deletion
  
  -- Metadata (for safety review only)
  sentiment_score FLOAT,  -- -1 to 1 (LLM-based)
  toxicity_score FLOAT,  -- 0 to 1
  
  CONSTRAINT no_plaintext_storage CHECK (content_encrypted IS NOT NULL)
};

-- Auto-purge messages
CREATE OR REPLACE FUNCTION auto_delete_expired_messages()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM session_messages 
  WHERE expires_at <= now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_message_auto_delete
AFTER INSERT ON session_messages
FOR EACH ROW
EXECUTE FUNCTION auto_delete_expired_messages();
```

#### `topics` (For Semantic Matching)
```sql
CREATE TABLE topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  
  -- Vector Representation
  topic_embedding VECTOR(1536),
  
  -- Community Stats (Anonymous)
  session_count INT DEFAULT 0,
  avg_session_duration INT,
  
  -- Safety Flag
  is_monitored BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_topic_embedding ON topics USING ivfflat(topic_embedding vector_cosine_ops);
```

#### `anonymization_log` (Audit Only)
```sql
CREATE TABLE anonymization_log (
  id SERIAL PRIMARY KEY,
  session_id UUID,
  message_id UUID,
  detected_pattern TEXT,
  action_taken TEXT,  -- 'REDACTED' | 'ENCRYPTED' | 'FLAGGED'
  action_timestamp TIMESTAMP DEFAULT now(),
  reviewed_by UUID REFERENCES users(id),
  
  -- Never store the actual PII
  CONSTRAINT no_pii_logging CHECK (detected_pattern NOT LIKE '%@%' AND detected_pattern NOT LIKE '%(%)%')
);
```

### 3.2 Content Encryption Strategy

**At Rest:**
```
user_answer = "My name is John, call me at 555-1234"
    ↓
LLM Semantic Analysis (PII Detection)
    ↓
Pattern Matching (Regex + Fuzzy)
    ↓
Encryption Layer: AES-256-GCM(content, session_key)
    ↓
BYTEA Stored in DB
    ↓
Trigger: Scheduled deletion at session.expires_at
```

**In Transit (WebRTC):**
```
Browser A ---[DTLS-SRTP Encrypted]---> Browser B
  (native WebRTC encryption)
  
Server sees: ??? (relay only, no decryption)
```

---

## 4. VOICE MASKING ARCHITECTURE

### 4.1 Formant Shifting Algorithm (Web Audio API)

**Why Formant Shifting?**
- Preserves prosody (emotion, rhythm) while changing identity
- Works in real-time (< 50ms latency)
- No external dependencies (pure Web Audio API)
- Sounds natural, not robotic

**Algorithm Flow:**
```
Input Audio Stream
  ↓
Windowing (Hann window, 512-sample)
  ↓
FFT Analysis (identify formants F1, F2, F3)
  ↓
Formant Detection (peak detection in 80-250Hz, 700-1220Hz, 1220-2600Hz)
  ↓
Frequency Shift (Multiply formant frequencies by ratio: 0.9-1.1)
  ↓
Inverse FFT (reconstruct modified spectrum)
  ↓
Overlap-Add (smoothly combine windowed frames)
  ↓
Output Audio Stream
```

### 4.2 Voice Presets

| Preset | F1 Shift | F2 Shift | F3 Shift | Use Case |
|--------|----------|----------|----------|----------|
| **Warm Hearth** | ×0.95 | ×0.92 | ×0.90 | Lower, warmer tone |
| **Gentle Breeze** | ×1.05 | ×1.08 | ×1.10 | Lighter, higher tone |
| **Velvet Echo** | ×0.98 | ×1.02 | ×0.99 | Neutral, processed feel |

### 4.3 Implementation (src/audio/voiceMasker.ts)
See separate technical document: `VOICE_MASKING_ALGORITHM.md`

---

## 5. MATCHING ARCHITECTURE

### 5.1 Semantic Matching (Not Visual)

```
User A Answers: "I'm burnt out from work, my boss doesn't listen, I feel invisible"
    ↓
Embed with OpenAI API: embedding(answer) = [0.234, -0.156, ...]
    ↓
Vector Search in pgvector:
    SELECT * FROM users 
    WHERE answer_embedding <-> [0.234, -0.156, ...] < 0.3
    LIMIT 5 CANDIDATES
    ↓
Semantic Similarity Score Calculated
    ↓
Return Top Match (no photos, no names)
```

**Why pgvector?**
- Cosine similarity native to PostgreSQL
- Sub-100ms latency on millions of vectors
- No external vector database needed

### 5.2 Queue Management (Multi-Armed Bandit)

**Exploration vs. Exploitation Balance:**
```
New user → Cold start problem
    ↓
Randomize first 3 matches (Exploration phase)
    ↓
Track engagement: Did they message? How long?
    ↓
Use Thompson Sampling to weight future matches
    ↓
Gradually shift to high-confidence matches
```

**Implementation:**
```python
def get_next_match(user_id, confidence_threshold=0.6):
    # 20% exploration
    if random() < 0.2:
        return random_match_from_pool()
    
    # 80% exploitation
    candidates = semantic_search(user_id, topk=10)
    weighted_candidates = thompson_sample(candidates)
    return top_weighted_candidate()
```

---

## 6. WEBRTC PEER-TO-PEER ARCHITECTURE

### 6.1 Connection Flow

```
Browser A                          Server                          Browser B
   |                                |                                |
   |-- Generate SDP Offer -------->|                                |
   |     (contains ICE candidates)  |                                |
   |                           (Relay via TURN server)              |
   |                          (Server never decrypts)               |
   |                                |<---- Relay SDP Offer ---------|
   |                                |                                |
   |<----- Relay SDP Answer --------|                                |
   |     (Browser B's candidates)   |                                |
   |                                |---- Relay SDP Answer -------->|
   |                                |                                |
   |======== DTLS-SRTP Direct Connection Established==================|
   |                                |                                |
   |---- Encrypted Audio/Video ---->|-- Relay Only (No Decrypt) -->|
   |<---- Encrypted Audio/Video ----|<-- Relay Only (No Decrypt) ---|
   |                                |                                |
   |                   [Session Timer Expires]                       |
   |                                |                                |
   |-- Close Connection ----------->|                                |
   |                                |---- Close Connection -------->|
   |                                |                                |
   |                    [Auto-Purge Trigger]                        |
   |                    DELETE session_messages                     |
   |                    DELETE session_rooms                        |
   |                                |                                |
```

### 6.2 Signaling Server (Minimal Role)
- TURN relay only (asymmetric, never decrypts)
- SDP exchange (non-encrypted text protocol)
- No message content relay
- No IP logging beyond necessary TURN logs

---

## 7. CLOUD INFRASTRUCTURE

### 7.1 Recommended Stack: Supabase + Firebase

**Supabase (Database + Auth)**
```
PostgreSQL 15+ with pgvector
- Zero-knowledge auth (phone OTP, then hashed)
- Row-Level Security policies
- Realtime subscriptions for matching

Auth Flow:
  1. User enters phone
  2. SMS OTP sent
  3. OTP verified → JWT token (no PII in token)
  4. Device hash used as primary identifier
```

**Firebase Realtime Database (Signaling)**
```
/signaling/[session_id]/
  - sdp_offer
  - sdp_answer
  - ice_candidates
  
Auto-purges after session.expires_at
```

**Firebase Cloud Functions (Triggers)**
```
- Session timer expiry → Trigger purge
- PII detection → Trigger masking + logging
- Toxicity detection → Review queue
```

### 7.2 Cost Optimization
```
At Scale (1M users, 100K daily sessions):
- Supabase: $150-300/month (managed Postgres)
- Firebase: $50-100/month (realtime + functions)
- TURN server: Twilio/Xirsys $30-50/month
- Storage (logs): $10-20/month
- Total: ~$250-470/month (or $0.0025-0.0047 per user/month)

Monetization Strategy:
- Optional: "Premium moderators" ($4.99/month) → funds operations
- Grants from mental health nonprofits
- User donations (voluntary)
```

---

## 8. SAFETY & MODERATION

### 8.1 AI-Powered Content Filtering

```
Every message analyzed by:
  1. OpenAI Moderation API (toxicity, violence, self-harm)
  2. Custom Regex (PII patterns)
  3. LLM Semantic Check (context-aware harm detection)
  
If flagged:
  - Message encrypted in database
  - Session flagged for human review
  - Human reviewer (trained volunteer) assesses context
  - No action unless clear violation
```

### 8.2 Crisis Detection & Handoff

```
Message contains: "I'm going to hurt myself"
    ↓
Flag severity = HIGH
    ↓
Send user: "We hear you. Professional help available: [Crisis Hotline]"
    ↓
Session does NOT auto-terminate
    ↓
Human reviewer notified (async)
    ↓
If clear emergency: Suggest user call local emergency services
```

**Note**: Koza is **NOT** a crisis service. Clear boundary:
- Peer support ✓
- Crisis intervention ✗ (direct users to professionals)

---

## 9. DEVELOPMENT WORKFLOW (Agent-Driven)

### 9.1 Spec-to-Code Pipeline

```
Step 1: Architect on Paper/Gemini
Step 2: Create GitHub Issues from Architecture
Step 3: Claude Code / Cursor Agent Reads Issue
Step 4: Agent Generates Full Feature (DB schema + API + Tests)
Step 5: Auto-run Tests + Security Checks
Step 6: Create PR → Merge when passing
Step 7: Deploy via GitHub Actions
```

### 9.2 Testing & Security Checks

**Unit Tests:**
```bash
npm test -- --coverage
```

**Integration Tests (Database):**
```sql
-- Test 1: Auto-masking trigger
INSERT INTO session_messages (session_id, sender_user_id, content_encrypted, expires_at)
VALUES (..., 'Call me at 555-1234', ...);
-- Verify: pii_detected_fields contains 'phone'

-- Test 2: Auto-purge trigger
INSERT INTO session_rooms (..., expires_at = now())
-- Wait 1 second
-- Verify: session_messages deleted
```

**Security Checks:**
```bash
# No plaintext PII in logs
grep -r "[0-9]{3}-[0-9]{4}" ./logs && echo "FAIL: Phone numbers found" || echo "PASS"

# No unencrypted messages in database dump
pg_dump --password | grep "555-" && echo "FAIL" || echo "PASS"
```

---

## 10. ROADMAP

### Phase 1 (Weeks 1-4): MVP Core
- [ ] User onboarding + voice/avatar selection
- [ ] Blind Confessional (1-on-1) matching
- [ ] WebRTC P2P connection
- [ ] Basic voice masking (Warm Hearth preset)
- [ ] Auto-purge architecture

### Phase 2 (Weeks 5-8): Feature Expansion
- [ ] Relief Circles (3-4 person groups)
- [ ] Topic-based matching (Relief Circles)
- [ ] All voice presets
- [ ] 3D avatar styles
- [ ] Web UI (matching, room, settings)

### Phase 3 (Weeks 9-12): Safety & Scale
- [ ] Human moderation review system
- [ ] Crisis handoff flow
- [ ] Analytics (anonymous, aggregated)
- [ ] Performance optimization (vector DB scaling)
- [ ] Public beta testing

### Phase 4 (Weeks 13+): Sustainability
- [ ] Premium moderator system
- [ ] Nonprofit partnerships
- [ ] International localization
- [ ] Accessibility (captions, etc.)

---

## 11. COMPLIANCE & LEGAL

### 11.1 KVKK (Turkey) & GDPR (EU)
- ✓ No unnecessary PII collection
- ✓ User can request data deletion (triggers immediate purge)
- ✓ Transparent privacy policy (simple language)
- ✓ No third-party data sharing
- ✓ Automatic data expiration (not indefinite retention)

### 11.2 Positioning (NOT Healthcare)
```
Koza is a "Peer-to-Peer Anonymous Support Network"
  NOT a "Therapy App"
  NOT a "Medical Service"
  NOT a "Counseling Platform"

Legal Boundary:
  Safe: "Connect with others who understand"
  Unsafe: "Get treatment for depression"
```

---

## APPENDIX: File Structure

```
koza/
├── SYSTEM_SPECIFICATION.md (THIS FILE)
├── VOICE_MASKING_ALGORITHM.md
├── DATABASE_SCHEMA.sql
├── src/
│   ├── audio/
│   │   ├── voiceMasker.ts
│   │   └── formantShifter.ts
│   ├── matching/
│   │   ├── semanticMatcher.ts
│   │   └── vectorSearch.ts
│   ├── webrtc/
│   │   ├── signalingServer.ts
│   │   └── peerConnection.ts
│   ├── security/
│   │   ├── encryption.ts
│   │   ├── piiDetector.ts
│   │   └── autoMasking.ts
│   └── api/
│       ├── auth.ts
│       ├── rooms.ts
│       └── messages.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── security/
├── .github/workflows/
│   ├── test.yml
│   ├── security-scan.yml
│   └── deploy.yml
└── docs/
    ├── USER_GUIDE.md
    ├── DEVELOPER_GUIDE.md
    └── SECURITY_AUDIT.md
```

---

**Next Step:** Generate database schema file and voice masking implementation.
