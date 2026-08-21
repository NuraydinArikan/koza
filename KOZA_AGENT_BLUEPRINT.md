# KOZA — SPEC-TO-AGENT BLUEPRINT
**Anonimlik Öncelikli Eşler Arası Destek Platformu**

Bu doküman, AI kodlama ajanına (Cursor / Windsurf / Claude Code) verilecek tek kaynak olarak tasarlanmıştır.  
Ajan bu dosyayı okuduktan sonra ek soru sormadan Phase 1 MVP'yi baştan sona inşa edebilmelidir.

---

## 1. PROJE KİMLİĞİ VE DEĞİŞTİRİLEMEZ KISITLAMALAR

### Ne İnşa Ediyoruz?
Koza, iki yabancıyı anonim olarak sesli görüşmeye bağlayan, sohbet bittiğinde tüm verileri otomatik silen, sıfır bilgi mimarisine sahip bir eşler arası destek ağıdır.

### Asla İhlal Edilmeyecek Kurallar (Non-Negotiables)
```
❌ Sunucu hiçbir zaman düz metin mesaj içeriği görmez
❌ Kullanıcı gerçek kimliği (isim, e-posta, telefon) hiçbir zaman saklanmaz
❌ Sohbet süresi dolduğunda veriler geri dönüşü olmayan şekilde silinir
❌ PII tespiti sunucu tarafında tetikleyici ile otomatik maskelenir
✓ Ses maskeleme (formant shifting) tarayıcıda, zero-dependency çalışır
✓ Eşleşme demografik değil, semantik benzerliğe dayalıdır
✓ KVKK ve GDPR tam uyumlu
```

---

## 2. TEKNOLOJİ YIĞINI

```
Frontend:     React 18 + TypeScript + Vite
Styling:      Tailwind CSS
Database:     Supabase (PostgreSQL 15 + pgvector + pgcrypto)
Auth:         Supabase Anonymous Auth → cihaz hash tabanlı
Realtime:     Supabase Realtime (WebRTC sinyalleşme)
P2P Ses:      Native WebRTC (RTCPeerConnection)
Ses İşleme:   Web Audio API + AudioWorklet
Embedding:    OpenAI text-embedding-3-small (1536 boyut)
CI/CD:        GitHub Actions → Firebase Hosting
Test:         Vitest + @testing-library/react
```

> **Mevcut Dosya:** Proje zaten `vite.config.ts`, `tsconfig.json`, `package.json` içeriyor.  
> Yeni paket eklenecekse `npm install` çalıştır, lockfile'ı commit'le.

---

## 3. VERİTABANI KATMANI

### 3.1 Schema (Kullan: `DATABASE_SCHEMA_FIXED.sql`)

Mevcut `DATABASE_SCHEMA_FIXED.sql` dosyası production-ready'dir. Ajan bu dosyayı değiştirmemeli; migration dosyaları üzerinden ekleme yapmalıdır.

**Kritik Tablo İlişkileri:**
```
users (1) ──< session_rooms >── (1) users
session_rooms (1) ──< session_messages
session_rooms (1) ──< connection_heartbeat
topics (1) ──< session_rooms
```

**Zorunlu Index'ler (zaten mevcut):**
```sql
-- Semantik eşleşme için
CREATE INDEX idx_users_answer_embedding ON users 
  USING ivfflat(answer_embedding vector_cosine_ops) WITH (lists = 100);

-- Eşleşme kuyruğu için
CREATE INDEX idx_session_rooms_status ON session_rooms(status);
CREATE INDEX idx_session_rooms_expires_at ON session_rooms(expires_at);
```

### 3.2 Supabase Row Level Security

```sql
-- Kullanıcılar yalnızca kendi verilerini görür
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "self_only" ON users
  FOR ALL USING (id = current_setting('app.current_user_id', true)::uuid);

-- Oturum mesajları yalnızca katılımcılara görünür
ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "participants_only" ON session_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM session_rooms sr
      WHERE sr.id = session_id
        AND (sr.initiator_user_id = current_setting('app.current_user_id', true)::uuid
          OR sr.accepted_user_id  = current_setting('app.current_user_id', true)::uuid)
    )
  );
```

### 3.3 Supabase Ortam Değişkenleri

```env
# .env.local (git'e ekleme)
VITE_SUPABASE_URL=https://nunyttkgvkwivxtwrgpd.supabase.co
VITE_SUPABASE_ANON_KEY=<anon_key>
VITE_OPENAI_API_KEY=<openai_key>   # Yalnızca embedding için, backend'de kullan
```

---

## 4. KİMLİK DOĞRULAMA (ANONIM AUTH)

### Akış
```
Kullanıcı ilk açılışta:
  1. crypto.randomUUID() ile cihaz gizli anahtarı üretilir → localStorage'da saklanır
  2. SHA-256(cihaz_id + gizli_anahtar) hesaplanır → anon_hash
  3. Supabase'e INSERT INTO users (anon_hash, ...) yapılır
  4. Sonraki açılışta: anon_hash ile kullanıcı bulunur, JWT alınır
```

### Implementasyon: `src/auth/anonymousAuth.ts`

```typescript
import { createClient } from '@supabase/supabase-js';
import { sha256 } from './crypto';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export async function getOrCreateUser(): Promise<string> {
  // 1. Mevcut cihaz anahtarını al veya oluştur
  let deviceSecret = localStorage.getItem('koza_device_secret');
  if (!deviceSecret) {
    deviceSecret = crypto.randomUUID();
    localStorage.setItem('koza_device_secret', deviceSecret);
  }

  // 2. Anonim hash üret
  const deviceId = navigator.userAgent + screen.width + screen.height;
  const anonHash = await sha256(deviceId + deviceSecret);

  // 3. Kullanıcıyı bul veya oluştur (onboarding tamamlanmadıysa null embedding ile)
  const { data, error } = await supabase
    .from('users')
    .upsert({ anon_hash: anonHash }, { onConflict: 'anon_hash' })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}
```

---

## 5. KULLANICI AKIŞI (Onboarding → Eşleşme → Sohbet)

### Phase 1 MVP için 3 Ekran

```
[1. Onboarding]  →  [2. Bekleme Odası]  →  [3. Sohbet]
```

#### Ekran 1: Onboarding (`src/pages/Onboarding.tsx`)
```
Adım 1: Ses presetini seç (Warm Hearth / Gentle Breeze / Velvet Echo)
Adım 2: Avatar stilini seç (Clay Figure / Nature Spirit / Origami)
Adım 3: 3 onboarding sorusunu yanıtla (serbest metin)
Adım 4: OpenAI embedding API'si çağrılır → answer_embedding güncellenir
Adım 5: Kullanıcı "Bağlan" butonuna basar → Eşleşme kuyruğuna girer
```

#### Ekran 2: Bekleme Odası (`src/pages/WaitingRoom.tsx`)
```
- session_rooms tablosuna INSERT (status = 'waiting')
- Supabase Realtime ile aynı durumda başka kullanıcı bekleniyor mu diye dinle
- Eşleşme bulunursa → accepted_user_id güncellenir → WebRTC başlatılır
```

#### Ekran 3: Sohbet (`src/pages/Session.tsx`)
```
- WebRTC P2P ses bağlantısı
- VoiceMasker aktif (seçilen preset ile)
- Geri sayım sayacı (60 dakika)
- Süre dolunca → bağlantı kapatılır → sunucu purge tetiklenir
```

---

## 6. EŞLEŞTİRME MİMARİSİ

### `src/matching/semanticMatcher.ts`

```typescript
import { supabase } from '../lib/supabase';

/**
 * Bekleyen kullanıcılar arasında cosine benzerliğine göre eşleşme bulur.
 * pgvector'ün <-> operatörü cosine distance döndürür (0 = aynı, 2 = zıt).
 */
export async function findMatch(userId: string): Promise<string | null> {
  const { data: currentUser } = await supabase
    .from('users')
    .select('answer_embedding')
    .eq('id', userId)
    .single();

  if (!currentUser?.answer_embedding) return null;

  // Aktif bekleyen odalar arasından semantik en yakın eşi bul
  const { data } = await supabase.rpc('find_semantic_match', {
    p_user_id: userId,
    p_embedding: currentUser.answer_embedding,
    p_limit: 1
  });

  return data?.[0]?.initiator_user_id ?? null;
}
```

**Supabase RPC Fonksiyonu** (`scripts/migrations/003_matching_rpc.sql`):
```sql
CREATE OR REPLACE FUNCTION find_semantic_match(
  p_user_id    UUID,
  p_embedding  VECTOR(1536),
  p_limit      INT DEFAULT 1
)
RETURNS TABLE(initiator_user_id UUID, session_id UUID, similarity FLOAT)
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    sr.initiator_user_id,
    sr.id AS session_id,
    1 - (u.answer_embedding <-> p_embedding) AS similarity
  FROM session_rooms sr
  JOIN users u ON u.id = sr.initiator_user_id
  WHERE sr.status = 'waiting'
    AND sr.initiator_user_id != p_user_id
    AND sr.accepted_user_id IS NULL
    AND u.answer_embedding IS NOT NULL
  ORDER BY u.answer_embedding <-> p_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
```

---

## 7. WEBRTC KATMANI

### `src/webrtc/signaling.ts`

**Sinyalleşme akışı: Supabase Realtime üzerinden**

```typescript
import { supabase } from '../lib/supabase';

export class SignalingChannel {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Initiator: SDP Offer gönder */
  async sendOffer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await supabase
      .from('session_rooms')
      .update({ webrtc_sdp_offer: JSON.stringify(sdp), status: 'connecting' })
      .eq('id', this.sessionId);
  }

  /** Accepted user: SDP Answer gönder */
  async sendAnswer(sdp: RTCSessionDescriptionInit): Promise<void> {
    await supabase
      .from('session_rooms')
      .update({ webrtc_sdp_answer: JSON.stringify(sdp) })
      .eq('id', this.sessionId);
  }

  /** ICE candidate ekle */
  async addIceCandidate(candidate: RTCIceCandidate): Promise<void> {
    const { data } = await supabase
      .from('session_rooms')
      .select('ice_candidates')
      .eq('id', this.sessionId)
      .single();

    const existing = (data?.ice_candidates as RTCIceCandidate[]) ?? [];
    await supabase
      .from('session_rooms')
      .update({ ice_candidates: [...existing, candidate.toJSON()] })
      .eq('id', this.sessionId);
  }

  /** Karşı tarafın SDP/ICE güncellemelerini dinle */
  subscribe(
    onOffer:     (sdp: RTCSessionDescriptionInit) => void,
    onAnswer:    (sdp: RTCSessionDescriptionInit) => void,
    onCandidate: (c: RTCIceCandidateInit) => void
  ) {
    return supabase
      .channel(`session:${this.sessionId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'session_rooms',
        filter: `id=eq.${this.sessionId}`
      }, (payload) => {
        const row = payload.new as Record<string, unknown>;
        if (row.webrtc_sdp_offer)  onOffer(JSON.parse(row.webrtc_sdp_offer as string));
        if (row.webrtc_sdp_answer) onAnswer(JSON.parse(row.webrtc_sdp_answer as string));
        if (Array.isArray(row.ice_candidates)) {
          (row.ice_candidates as RTCIceCandidateInit[]).forEach(onCandidate);
        }
      })
      .subscribe();
  }
}
```

### P2P Bağlantı Yöneticisi: `src/webrtc/peerConnection.ts`

```typescript
import { SignalingChannel } from './signaling';
import { VoiceMasker, VOICE_PRESETS } from '../audio/voiceMasker';

export class KozaPeerConnection {
  private pc: RTCPeerConnection;
  private signaling: SignalingChannel;
  private masker: VoiceMasker;

  private static ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // Production'da TURN sunucusu ekle (Twilio/Xirsys)
  ];

  constructor(sessionId: string, presetName: keyof typeof VOICE_PRESETS) {
    this.pc = new RTCPeerConnection({ iceServers: KozaPeerConnection.ICE_SERVERS });
    this.signaling = new SignalingChannel(sessionId);
    const ctx = new AudioContext();
    this.masker = new VoiceMasker(ctx, VOICE_PRESETS[presetName]);
  }

  async startAsInitiator(stream: MediaStream): Promise<void> {
    await this.masker.initializeProcessor(stream);
    stream.getTracks().forEach(track => this.pc.addTrack(track, stream));

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.addIceCandidate(e.candidate);
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signaling.sendOffer(offer);

    this.signaling.subscribe(
      () => {}, // Offer zaten biz gönderdik
      async (answer) => {
        await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      },
      async (candidate) => {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    );
  }

  async startAsAccepted(stream: MediaStream): Promise<void> {
    await this.masker.initializeProcessor(stream);
    stream.getTracks().forEach(track => this.pc.addTrack(track, stream));

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signaling.addIceCandidate(e.candidate);
    };

    this.signaling.subscribe(
      async (offer) => {
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.signaling.sendAnswer(answer);
      },
      () => {},
      async (candidate) => {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    );
  }

  onRemoteStream(callback: (stream: MediaStream) => void): void {
    this.pc.ontrack = (e) => {
      if (e.streams[0]) callback(e.streams[0]);
    };
  }

  close(): void {
    this.masker.stop();
    this.pc.close();
  }
}
```

---

## 8. SES MASKELEME KATMANI

> **Mevcut Dosya:** `src/audio/voiceMasker.ts` zaten implemente edilmiş.  
> Ajan bu dosyayı değiştirme; yalnızca entegrasyon noktalarında kullan.

### Özet: Üç Preset

| Preset | F1 | F2 | F3 | Etki |
|--------|-----|-----|-----|------|
| `warm_hearth`   | ×0.95 | ×0.92 | ×0.90 | Daha alçak, sıcak ton |
| `gentle_breeze` | ×1.05 | ×1.08 | ×1.10 | Daha yüksek, hafif ton |
| `velvet_echo`   | ×0.98 | ×1.02 | ×0.99 | Nötr, işlenmiş his |

### AudioWorklet Modülü: `public/voice-masker-processor.js`

```javascript
// AudioWorklet off-main-thread çalışır — latency < 5ms
class VoiceMaskerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.shiftRatio = 0.95; // Varsayılan: warm_hearth
    this.port.onmessage = (e) => {
      if (e.data.type === 'SET_PRESET') {
        const avg = (e.data.preset.f1Ratio + e.data.preset.f2Ratio + e.data.preset.f3Ratio) / 3;
        this.shiftRatio = avg;
      }
    };
  }

  process(inputs, outputs) {
    const input  = inputs[0][0];
    const output = outputs[0][0];
    if (!input) return true;

    // Basit frekans ölçekleme (gerçek FFT AudioContext.createAnalyser üzerinden)
    for (let i = 0; i < output.length; i++) {
      const srcIdx = Math.floor(i / this.shiftRatio);
      output[i] = srcIdx < input.length ? input[srcIdx] : 0;
    }
    return true;
  }
}

registerProcessor('voice-masker-processor', VoiceMaskerProcessor);
```

---

## 9. GÜVENLİK KATMANI

### 9.1 PII Maskeleme (Veritabanı Tetikleyicisi)

> **Mevcut:** `DATABASE_SCHEMA_FIXED.sql` içindeki `detect_and_mask_pii()` ve `mask_pii_in_text()` fonksiyonları zaten çalışır durumda.

**Tespit Edilen Paternler:**
- `\d{10,}` → Telefon numarası → `[PHONE_REDACTED]`
- `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` → E-posta → `[EMAIL_REDACTED]`
- `@[a-zA-Z0-9_]{2,}` → Sosyal medya handle → `[HANDLE_REDACTED]`
- `\d+\s+(street|ave|boulevard|...)` → Adres → `[ADDRESS_REDACTED]`

### 9.2 İstemci Tarafı PII Detektörü

> **Mevcut Dosya:** `src/safety/piiDetector.ts` zaten implemente edilmiş.  
> Onboarding yanıtları gönderilmeden önce bu detektörden geçirilmeli.

```typescript
// Kullanım örneği:
import { PiiDetector } from '../safety/piiDetector';

const detector = new PiiDetector();
const result = detector.scan(userAnswer);

if (result.hasPii) {
  showWarning('Lütfen kişisel bilgi paylaşma.');
  // Gönderimi engelle veya maskelenmiş versiyonu gönder
}
```

### 9.3 Uçtan Uca Şifreleme

Tüm mesaj içerikleri veritabanına yazılmadan önce şifrelenir:

```typescript
// src/lib/encryption.ts
export async function encryptMessage(text: string, sessionKey: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(sessionKey), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: encoder.encode('koza-salt'), iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encoder.encode(text)
  );
  // IV + ciphertext birleştir
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}
```

---

## 10. DOSYA YAPISI

```
koza/
├── public/
│   └── voice-masker-processor.js      ← AudioWorklet (YENI - oluştur)
│
├── src/
│   ├── auth/
│   │   └── anonymousAuth.ts           ← YENI
│   │
│   ├── audio/
│   │   ├── voiceMasker.ts             ← MEVCUT (değiştirme)
│   │   └── voiceMasker.unit.test.ts   ← MEVCUT
│   │
│   ├── lib/
│   │   ├── supabase.ts                ← YENI (client singleton)
│   │   └── encryption.ts             ← YENI
│   │
│   ├── matching/
│   │   └── semanticMatcher.ts        ← MEVCUT + RPC entegrasyonu ekle
│   │
│   ├── pages/
│   │   ├── Onboarding.tsx             ← YENI
│   │   ├── WaitingRoom.tsx            ← YENI
│   │   └── Session.tsx                ← YENI
│   │
│   ├── safety/
│   │   └── piiDetector.ts            ← MEVCUT (değiştirme)
│   │
│   ├── webrtc/
│   │   ├── signaling.ts              ← MEVCUT + revize et
│   │   └── peerConnection.ts         ← YENI
│   │
│   ├── App.tsx                        ← MEVCUT + routing ekle
│   └── main.tsx                       ← MEVCUT
│
├── scripts/migrations/
│   ├── 002_auto_purge_architecture.sql  ← MEVCUT
│   └── 003_matching_rpc.sql            ← YENI (find_semantic_match fonksiyonu)
│
├── DATABASE_SCHEMA_FIXED.sql          ← MEVCUT (değiştirme)
├── .github/workflows/test-and-deploy.yml ← MEVCUT
└── KOZA_AGENT_BLUEPRINT.md            ← BU DOSYA
```

---

## 11. PHASE 1 MVP — İMPLEMENTASYON SIRASI

Ajanın bu sırayla ilerlemesi gerekir:

```
[ ] 1. src/lib/supabase.ts          — Supabase client singleton
[ ] 2. src/lib/encryption.ts        — AES-GCM şifreleme/çözme yardımcıları
[ ] 3. src/auth/anonymousAuth.ts    — getOrCreateUser() fonksiyonu
[ ] 4. scripts/migrations/003_matching_rpc.sql — find_semantic_match RPC
[ ] 5. src/webrtc/peerConnection.ts — KozaPeerConnection sınıfı
[ ] 6. public/voice-masker-processor.js — AudioWorklet modülü
[ ] 7. src/pages/Onboarding.tsx     — 3 adımlı onboarding akışı
[ ] 8. src/pages/WaitingRoom.tsx    — Eşleşme bekleme ekranı
[ ] 9. src/pages/Session.tsx        — Aktif sohbet ekranı (WebRTC + sayaç)
[ ] 10. src/App.tsx                 — React Router ile 3 sayfa routing
[ ] 11. npm run test:unit           — Tüm unit testler geçmeli
[ ] 12. npm run build               — Build hatasız tamamlanmalı
```

---

## 12. TEST GEREKSİNİMLERİ

### Yeni Eklenmesi Gereken Testler

```
src/auth/anonymousAuth.unit.test.ts
  ✓ İlk açılışta yeni kullanıcı oluşturur
  ✓ İkinci açılışta aynı kullanıcıyı döndürür (localStorage persistence)
  ✓ Farklı cihaz sırları farklı hash üretir

src/webrtc/peerConnection.unit.test.ts
  ✓ close() çağrıldığında VoiceMasker.stop() tetiklenir
  ✓ ICE candidate biriktirilir ve sinyalleşme kanalına iletilir

src/lib/encryption.unit.test.ts
  ✓ Şifrelenmiş metin düz metinden farklıdır
  ✓ Şifre çözme orijinal metni geri verir
  ✓ Farklı session key'ler farklı ciphertext üretir
```

### Mevcut CI Testi (Geçmesi Zorunlu)
```bash
npm run test:unit
npx tsc --noEmit
npm run build
```

CI ayrıca PostgreSQL'de schema + migration + PII tetikleyici + auto-purge testlerini çalıştırır.

---

## 13. BAŞARI KRİTERLERİ (Phase 1 Tamamlandı Sayılır)

```
✓ İki farklı tarayıcı sekmesi açılır, her biri onboarding'i tamamlar
✓ Eşleşme kuyruğuna girildiğinde < 5 saniyede eşleşme bulunur
✓ Ses bağlantısı kurulur; her iki taraf da karşı sesi duyar
✓ Her iki tarafın sesi formant shifting ile maskelenir
✓ 60 dakika sayacı dolar → bağlantı kapanır → DB purge çalışır
✓ Supabase'de session_messages tablosu boş kalır (purge başarılı)
✓ PII içeren mesaj (örn. "05321234567") → has_pii_detected = true
✓ npm run test:unit → 0 başarısız test
✓ GitHub Actions → tüm job'lar yeşil
```

---

## 14. AJANA NOTLAR

1. **Schema değiştirme:** `DATABASE_SCHEMA_FIXED.sql` dokunulmaz. Yeni şeyler için `scripts/migrations/00X_*.sql` oluştur.

2. **Supabase bağlantısı:** Supabase şu an duraklatılmış olabilir (koza-prod). Lokal dev için `supabase start` ile lokal Supabase kullanılabilir, ya da Supabase dashboard'dan proje uyandırılır.

3. **OpenAI key:** Embedding çağrısı `VITE_OPENAI_API_KEY` ile yapılır; bu key'i kod içinde hard-code etme, sadece `import.meta.env` üzerinden oku.

4. **WebRTC TURN:** Phase 1 için Google STUN yeterli. Aynı ağdaki cihazlar bağlanır. Production'a geçişte Twilio/Xirsys TURN eklenir.

5. **Ses latency hedefi:** `< 50ms` toplam (FFT + WebRTC). AudioWorklet main thread'i bloke etmez; ScriptProcessorNode fallback'i kabul edilebilir ama AudioWorklet tercih edilir.

6. **PII detektörü:** İstemci tarafı (`piiDetector.ts`) bir uyarı katmanıdır; sunucu tarafı PostgreSQL tetikleyicisi asıl güvencedir. İkisi birbirini destekler.

---

*Bu doküman Koza projesinin SINGLE SOURCE OF TRUTH'udur. Herhangi bir mimari karar bu dokümana aykırıysa, bu doküman güncellenmeden uygulamaya geçilmez.*
