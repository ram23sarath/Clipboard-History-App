/**
 * Unit Tests for Redaction Module
 * Tests SSN, credit card, and password pattern detection and redaction
 */

import { CONFIG } from '../src/config.js';

// Redaction functions (duplicated here for testing without Chrome dependencies)
const redactSensitiveData = (content) => {
    if (!content || typeof content !== 'string') {
        return { redacted: content, wasRedacted: false, redactionTypes: [] };
    }

    let redacted = content;
    const redactionTypes = [];
    const replacement = CONFIG.REDACTION.REPLACEMENT;

    // Redact Social Security Numbers
    const ssnPattern = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
    if (ssnPattern.test(redacted)) {
        ssnPattern.lastIndex = 0;
        redacted = redacted.replace(ssnPattern, replacement);
        redactionTypes.push('ssn');
    }

    // Redact Credit Card Numbers with Luhn validation
    const ccPattern = /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g;
    if (ccPattern.test(content)) {
        ccPattern.lastIndex = 0;
        redacted = redacted.replace(ccPattern, (match) => {
            const digitsOnly = match.replace(/[-\s]/g, '');
            if (isValidCreditCardFormat(digitsOnly)) {
                if (!redactionTypes.includes('credit_card')) {
                    redactionTypes.push('credit_card');
                }
                return replacement;
            }
            return match;
        });
    }

    // Redact Password Patterns
    const passwordPatterns = [
        /password\s*[:=]\s*\S+/gi,
        /pwd\s*[:=]\s*\S+/gi,
        /secret\s*[:=]\s*\S+/gi,
        /api[_-]?key\s*[:=]\s*\S+/gi,
        /token\s*[:=]\s*\S+/gi,
    ];

    for (const pattern of passwordPatterns) {
        if (pattern.test(redacted)) {
            pattern.lastIndex = 0;
            redacted = redacted.replace(pattern, replacement);
            if (!redactionTypes.includes('password')) {
                redactionTypes.push('password');
            }
        }
    }

    return {
        redacted,
        wasRedacted: redactionTypes.length > 0,
        redactionTypes,
    };
};

const isValidCreditCardFormat = (digits) => {
    if (digits.length < 13 || digits.length > 19) return false;
    if (/^(.)\1+$/.test(digits)) return false;
    return luhnCheck(digits);
};

const luhnCheck = (digits) => {
    let sum = 0;
    let isEven = false;

    for (let i = digits.length - 1; i >= 0; i--) {
        let digit = parseInt(digits[i], 10);

        if (isEven) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }

        sum += digit;
        isEven = !isEven;
    }

    return sum % 10 === 0;
};

const detectSensitiveData = (content) => {
    if (!content || typeof content !== 'string') {
        return { hasSensitive: false, types: [] };
    }

    const types = [];

    // Check SSN
    const ssnPattern = /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g;
    if (ssnPattern.test(content)) types.push('ssn');

    // Check Credit Card
    const ccPattern = /\b(?:\d{4}[-\s]?){3,4}\d{1,4}\b/g;
    if (ccPattern.test(content)) types.push('credit_card');

    // Check Passwords
    const passwordPatterns = [
        /password\s*[:=]\s*\S+/gi,
        /pwd\s*[:=]\s*\S+/gi,
        /secret\s*[:=]\s*\S+/gi,
    ];
    for (const pattern of passwordPatterns) {
        if (pattern.test(content)) {
            types.push('password');
            break;
        }
    }

    return { hasSensitive: types.length > 0, types };
};

// =============================================================================
// SSN DETECTION TESTS
// =============================================================================

describe('SSN Detection', () => {
    test('detects standard SSN format (XXX-XX-XXXX)', () => {
        const content = 'My SSN is 123-45-6789';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('ssn');
        expect(result.redacted).not.toContain('123-45-6789');
        expect(result.redacted).toContain('[REDACTED]');
    });

    test('detects SSN with spaces (XXX XX XXXX)', () => {
        const content = 'SSN: 123 45 6789';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('ssn');
    });

    test('detects SSN without separators (XXXXXXXXX)', () => {
        const content = 'My number is 123456789';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('ssn');
    });

    test('does not flag numbers that are not SSNs', () => {
        const content = 'Phone: 555-555-5555'; // Wrong format
        const result = redactSensitiveData(content);

        expect(result.redactionTypes).not.toContain('ssn');
    });

    test('handles multiple SSNs in content', () => {
        const content = 'SSN1: 111-22-3333, SSN2: 444-55-6666';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redacted).not.toContain('111-22-3333');
        expect(result.redacted).not.toContain('444-55-6666');
    });
});

// =============================================================================
// CREDIT CARD DETECTION TESTS
// =============================================================================

describe('Credit Card Detection', () => {
    test('detects Visa card number', () => {
        const content = 'Card: 4532015112830366';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('credit_card');
        expect(result.redacted).toContain('[REDACTED]');
    });

    test('detects Mastercard number with dashes', () => {
        const content = 'My card is 5425-2334-3010-9903';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('credit_card');
    });

    test('detects card with spaces', () => {
        const content = 'Card: 4532 0151 1283 0366';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('credit_card');
    });

    test('Luhn validation rejects invalid numbers', () => {
        // This number fails Luhn check
        const content = 'Invalid: 1234567890123456';
        const result = redactSensitiveData(content);

        // Should not redact as credit card (fails Luhn)
        expect(result.redactionTypes).not.toContain('credit_card');
    });

    test('rejects all-same-digit numbers', () => {
        const content = 'Not a card: 1111111111111111';
        const result = redactSensitiveData(content);

        expect(result.redactionTypes).not.toContain('credit_card');
    });

    test('detects American Express (15 digits)', () => {
        const content = 'AmEx: 378282246310005';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('credit_card');
    });
});

// =============================================================================
// PASSWORD PATTERN DETECTION TESTS
// =============================================================================

describe('Password Pattern Detection', () => {
    test('detects password= pattern', () => {
        const content = 'Config: password=mysecretpass123';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
        expect(result.redacted).not.toContain('mysecretpass123');
    });

    test('detects password: pattern', () => {
        const content = 'password: hunter2';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('detects PASSWORD (case insensitive)', () => {
        const content = 'PASSWORD = SuperSecret';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('detects pwd pattern', () => {
        const content = 'pwd: mypassword';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('detects secret pattern', () => {
        const content = 'secret=abc123xyz';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('detects api_key pattern', () => {
        const content = 'api_key=sk_live_abcdefghijklmnop';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('detects token pattern', () => {
        const content = 'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('password');
    });

    test('does not redact word "password" without value', () => {
        const content = 'Please enter your password';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(false);
    });
});

// =============================================================================
// MULTIPLE SENSITIVE DATA TESTS
// =============================================================================

describe('Multiple Sensitive Data Types', () => {
    test('detects and redacts multiple types', () => {
        const content = 'SSN: 123-45-6789, Card: 4532015112830366, password=secret123';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redactionTypes).toContain('ssn');
        expect(result.redactionTypes).toContain('credit_card');
        expect(result.redactionTypes).toContain('password');
        expect(result.redacted).not.toContain('123-45-6789');
        expect(result.redacted).not.toContain('4532015112830366');
        expect(result.redacted).not.toContain('secret123');
    });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('Edge Cases', () => {
    test('handles empty content', () => {
        expect(redactSensitiveData('')).toEqual({
            redacted: '',
            wasRedacted: false,
            redactionTypes: [],
        });
    });

    test('handles null content', () => {
        expect(redactSensitiveData(null)).toEqual({
            redacted: null,
            wasRedacted: false,
            redactionTypes: [],
        });
    });

    test('handles undefined content', () => {
        expect(redactSensitiveData(undefined)).toEqual({
            redacted: undefined,
            wasRedacted: false,
            redactionTypes: [],
        });
    });

    test('handles content with no sensitive data', () => {
        const content = 'Just a normal text without any sensitive information.';
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(false);
        expect(result.redacted).toBe(content);
        expect(result.redactionTypes).toHaveLength(0);
    });

    test('handles very long content', () => {
        const content = 'Normal text '.repeat(1000) + ' SSN: 123-45-6789 ' + ' more text '.repeat(1000);
        const result = redactSensitiveData(content);

        expect(result.wasRedacted).toBe(true);
        expect(result.redacted).not.toContain('123-45-6789');
    });
});

// =============================================================================
// DETECTION WITHOUT REDACTION
// =============================================================================

describe('Sensitive Data Detection', () => {
    test('detects SSN without redacting', () => {
        const result = detectSensitiveData('SSN: 123-45-6789');

        expect(result.hasSensitive).toBe(true);
        expect(result.types).toContain('ssn');
    });

    test('detects credit card without redacting', () => {
        const result = detectSensitiveData('Card: 4532 0151 1283 0366');

        expect(result.hasSensitive).toBe(true);
        expect(result.types).toContain('credit_card');
    });

    test('detects password without redacting', () => {
        const result = detectSensitiveData('password=secret');

        expect(result.hasSensitive).toBe(true);
        expect(result.types).toContain('password');
    });

    test('returns false for clean content', () => {
        const result = detectSensitiveData('Hello, world!');

        expect(result.hasSensitive).toBe(false);
        expect(result.types).toHaveLength(0);
    });
});

// =============================================================================
// LUHN ALGORITHM TESTS
// =============================================================================

describe('Luhn Algorithm', () => {
    test('validates correct Visa number', () => {
        expect(luhnCheck('4532015112830366')).toBe(true);
    });

    test('validates correct Mastercard number', () => {
        expect(luhnCheck('5425233430109903')).toBe(true);
    });

    test('validates correct AmEx number', () => {
        expect(luhnCheck('378282246310005')).toBe(true);
    });

    test('rejects invalid number', () => {
        expect(luhnCheck('1234567890123456')).toBe(false);
    });

    test('rejects modified valid number', () => {
        // Change last digit of valid Visa number
        expect(luhnCheck('4532015112830365')).toBe(false);
    });
});
