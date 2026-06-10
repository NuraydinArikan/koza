import { describe, it, expect } from 'vitest';
import { maskPii, containsPii, maskOwnName, PiiField } from './piiDetector';

// ─── phone numbers ────────────────────────────────────────────────────────────

describe('phone number masking', () => {
  it.each([
    ['bare 10 digits', 'Call me at 5551234567 tonight'],
    ['11 digits with leading 0', 'Numaram 05321234567'],
    ['international format', 'Reach me on +90 532 123 45 67'],
    ['US dashed format', 'my cell is 555-123-4567'],
    ['parenthesized area code', 'call (555) 123-4567 anytime'],
  ])('masks %s', (_label, text) => {
    const r = maskPii(text);
    expect(r.hasPii).toBe(true);
    expect(r.detectedFields).toContain('phone_number');
    expect(r.maskedText).toContain('[PHONE_REDACTED]');
    expect(r.maskedText).not.toMatch(/\d{7,}/);
  });

  it('does not mask short numbers', () => {
    const r = maskPii('I scored 95 on the test and slept 8 hours');
    expect(r.hasPii).toBe(false);
    expect(r.maskedText).toBe('I scored 95 on the test and slept 8 hours');
  });
});

// ─── emails ───────────────────────────────────────────────────────────────────

describe('email masking', () => {
  it('masks a standard email', () => {
    const r = maskPii('write to john.doe+test@gmail.com please');
    expect(r.detectedFields).toContain('email');
    expect(r.maskedText).toBe('write to [EMAIL_REDACTED] please');
  });

  it('masks multiple emails and counts them', () => {
    const r = maskPii('a@x.com and b@y.org');
    const m = r.matches.find((m) => m.field === 'email');
    expect(m?.count).toBe(2);
    expect(r.maskedText).toBe('[EMAIL_REDACTED] and [EMAIL_REDACTED]');
  });

  it('email is masked as email, not as a handle', () => {
    const r = maskPii('mail: someone@example.com');
    expect(r.detectedFields).toContain('email');
    expect(r.detectedFields).not.toContain('social_media_handle');
  });
});

// ─── social media ─────────────────────────────────────────────────────────────

describe('social media masking', () => {
  it('masks @handles', () => {
    const r = maskPii('follow me @myhandle ok?');
    expect(r.detectedFields).toContain('social_media_handle');
    expect(r.maskedText).toBe('follow me [HANDLE_REDACTED] ok?');
  });

  it('masks profile URLs', () => {
    const r = maskPii('see instagram.com/my.profile or https://x.com/someone');
    expect(r.detectedFields).toContain('social_media_url');
    expect(r.maskedText).not.toContain('my.profile');
    expect(r.maskedText).not.toContain('someone');
  });

  it('keeps handle masking at sentence start', () => {
    const r = maskPii('@cooluser42 said hi');
    expect(r.maskedText).toBe('[HANDLE_REDACTED] said hi');
  });
});

// ─── street addresses ─────────────────────────────────────────────────────────

describe('street address masking', () => {
  it('masks English addresses', () => {
    const r = maskPii('I live at 123 Main Street downtown');
    expect(r.detectedFields).toContain('street_address');
    expect(r.maskedText).toContain('[ADDRESS_REDACTED]');
    expect(r.maskedText).not.toContain('Main');
  });

  it('masks Turkish addresses', () => {
    const r = maskPii('Atatürk Caddesi No: 15 adresinde oturuyorum');
    expect(r.detectedFields).toContain('street_address');
    expect(r.maskedText).not.toContain('Atatürk');
  });

  it('masks Turkish neighborhood + street form', () => {
    const r = maskPii('Çamlık Mahallesi Gül Sokak no:7');
    expect(r.maskedText).toContain('[ADDRESS_REDACTED]');
  });
});

// ─── payment info ─────────────────────────────────────────────────────────────

describe('payment info masking', () => {
  it('masks card numbers and flags for review', () => {
    const r = maskPii('my card is 4111 1111 1111 1111 thanks');
    expect(r.detectedFields).toContain('payment_info');
    expect(r.flagForReview).toBe(true);
    expect(r.maskedText).toContain('[PAYMENT_REDACTED]');
    expect(r.maskedText).not.toContain('4111');
  });

  it('masks TR IBANs', () => {
    const r = maskPii('TR33 0006 1005 1978 6457 8413 26 hesabıma yolla');
    expect(r.detectedFields).toContain('payment_info');
    expect(r.flagForReview).toBe(true);
  });

  it('card number is masked as payment, not as phone', () => {
    const r = maskPii('4111111111111111');
    expect(r.detectedFields).toContain('payment_info');
    expect(r.detectedFields).not.toContain('phone_number');
  });

  it('does not flag for review without payment info', () => {
    expect(maskPii('email me at a@b.co').flagForReview).toBe(false);
  });
});

// ─── combined & edge cases ────────────────────────────────────────────────────

describe('combined input and edge cases', () => {
  it('masks multiple PII types in one message', () => {
    const r = maskPii(
      'Ben @gizli42, mailim x@y.com, telefonum 05001112233, 123 Oak Street adresindeyim'
    );
    const expected: PiiField[] = [
      'email',
      'social_media_handle',
      'phone_number',
      'street_address',
    ];
    for (const f of expected) expect(r.detectedFields).toContain(f);
    expect(r.maskedText).not.toMatch(/x@y\.com|05001112233|Oak/);
  });

  it('returns clean result for PII-free text', () => {
    const r = maskPii('Bugün kendimi çok yalnız hissettim, konuşmak istedim.');
    expect(r).toMatchObject({ hasPii: false, detectedFields: [], flagForReview: false });
    expect(r.maskedText).toBe('Bugün kendimi çok yalnız hissettim, konuşmak istedim.');
  });

  it('handles empty string', () => {
    expect(maskPii('').hasPii).toBe(false);
  });

  it('handles non-string input without throwing', () => {
    expect(maskPii(undefined as unknown as string).maskedText).toBe('');
    expect(maskPii(null as unknown as string).hasPii).toBe(false);
  });

  it('containsPii mirrors maskPii.hasPii', () => {
    expect(containsPii('call 5551234567')).toBe(true);
    expect(containsPii('just feelings here')).toBe(false);
  });
});

// ─── own-name masking ─────────────────────────────────────────────────────────

describe('maskOwnName', () => {
  it('masks the display name case-insensitively', () => {
    const r = maskOwnName('Merhaba ben Ayşe, AYŞE derler bana', 'Ayşe');
    expect(r.hasPii).toBe(true);
    expect(r.maskedText).toBe('Merhaba ben [NAME_REDACTED], [NAME_REDACTED] derler bana');
  });

  it('does not mask substrings of longer words', () => {
    const r = maskOwnName('Anladım seni', 'Anla');
    expect(r.hasPii).toBe(false);
  });

  it('ignores too-short or missing names', () => {
    expect(maskOwnName('hello a world', 'a').hasPii).toBe(false);
    expect(maskOwnName('hello', '').hasPii).toBe(false);
  });

  it('escapes regex metacharacters in names', () => {
    const r = maskOwnName('I am John (J.R.) here', 'John (J.R.)');
    expect(r.hasPii).toBe(true);
    expect(r.maskedText).toBe('I am [NAME_REDACTED] here');
  });
});

// ─── anonymity invariants ─────────────────────────────────────────────────────

describe('anonymity invariants', () => {
  it('result object never contains the raw PII values', () => {
    const r = maskPii('phone 5551234567 mail a@b.com');
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('5551234567');
    expect(serialized).not.toContain('a@b.com');
  });

  it('idempotent: masking twice changes nothing', () => {
    const once = maskPii('call 5551234567').maskedText;
    expect(maskPii(once).maskedText).toBe(once);
  });
});
