/**
 * Content Redaction Module
 * Client-side redaction of sensitive data before upload
 */

import { CONFIG } from '../config.js';

/**
 * Redact sensitive information from clipboard content
 * @param {string} content - Original clipboard content
 * @returns {{redacted: string, wasRedacted: boolean, redactionTypes: string[]}}
 */
export function redactSensitiveData(content) {
    if (!content || typeof content !== 'string') {
        return { redacted: content, wasRedacted: false, redactionTypes: [] };
    }

    let redacted = content;
    const redactionTypes = [];
    const replacement = CONFIG.REDACTION.REPLACEMENT;

    // Redact Social Security Numbers
    if (CONFIG.REDACTION.SSN_PATTERN.test(redacted)) {
        redacted = redacted.replace(CONFIG.REDACTION.SSN_PATTERN, replacement);
        redactionTypes.push('ssn');
        // Reset regex lastIndex
        CONFIG.REDACTION.SSN_PATTERN.lastIndex = 0;
    }

    // Redact Credit Card Numbers
    if (containsCreditCard(content)) {
        redacted = redacted.replace(CONFIG.REDACTION.CC_PATTERN, (match) => {
            // Additional validation: check if it looks like a real CC number
            const digitsOnly = match.replace(/[-\s]/g, '');
            if (isValidCreditCardFormat(digitsOnly)) {
                redactionTypes.push('credit_card');
                return replacement;
            }
            return match;
        });
        CONFIG.REDACTION.CC_PATTERN.lastIndex = 0;
    }

    // Redact Password Patterns
    for (const pattern of CONFIG.REDACTION.PASSWORD_PATTERNS) {
        if (pattern.test(redacted)) {
            redacted = redacted.replace(pattern, replacement);
            if (!redactionTypes.includes('password')) {
                redactionTypes.push('password');
            }
            pattern.lastIndex = 0;
        }
    }

    return {
        redacted,
        wasRedacted: redactionTypes.length > 0,
        redactionTypes,
    };
}

/**
 * Check if content contains a potential credit card number
 * @param {string} content - Content to check
 * @returns {boolean}
 */
function containsCreditCard(content) {
    CONFIG.REDACTION.CC_PATTERN.lastIndex = 0;
    return CONFIG.REDACTION.CC_PATTERN.test(content);
}

/**
 * Validate if a string of digits looks like a credit card number
 * Uses Luhn algorithm for basic validation
 * @param {string} digits - String of digits only
 * @returns {boolean}
 */
function isValidCreditCardFormat(digits) {
    // Check length (13-19 digits for credit cards)
    if (digits.length < 13 || digits.length > 19) {
        return false;
    }

    // Check for all same digits (likely not a CC)
    if (/^(.)\1+$/.test(digits)) {
        return false;
    }

    // Apply Luhn algorithm
    return luhnCheck(digits);
}

/**
 * Luhn algorithm to validate credit card numbers
 * @param {string} digits - String of digits
 * @returns {boolean}
 */
function luhnCheck(digits) {
    let sum = 0;
    let isEven = false;

    for (let i = digits.length - 1; i >= 0; i--) {
        let digit = parseInt(digits[i], 10);

        if (isEven) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }

        sum += digit;
        isEven = !isEven;
    }

    return sum % 10 === 0;
}

/**
 * Check if content might contain sensitive data
 * Quick check without full redaction
 * @param {string} content - Content to check
 * @returns {{hasSensitive: boolean, types: string[]}}
 */
export function detectSensitiveData(content) {
    if (!content || typeof content !== 'string') {
        return { hasSensitive: false, types: [] };
    }

    const types = [];

    // Check for SSN pattern
    CONFIG.REDACTION.SSN_PATTERN.lastIndex = 0;
    if (CONFIG.REDACTION.SSN_PATTERN.test(content)) {
        types.push('ssn');
    }

    // Check for credit card pattern
    CONFIG.REDACTION.CC_PATTERN.lastIndex = 0;
    if (CONFIG.REDACTION.CC_PATTERN.test(content)) {
        types.push('credit_card');
    }

    // Check for password patterns
    for (const pattern of CONFIG.REDACTION.PASSWORD_PATTERNS) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
            types.push('password');
            break;
        }
    }

    return {
        hasSensitive: types.length > 0,
        types,
    };
}

/**
 * Generate a hash of the content for duplicate detection
 * Uses simple hash - not meant for security
 * @param {string} content - Content to hash
 * @returns {string} Hash string
 */
export function hashContent(content) {
    if (!content) return '';

    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }

    return Math.abs(hash).toString(36);
}

/**
 * Truncate content if it exceeds max length
 * @param {string} content - Content to truncate
 * @param {number} maxLength - Maximum allowed length (default 10000)
 * @returns {{content: string, wasTruncated: boolean}}
 */
export function truncateContent(content, maxLength = 10000) {
    if (!content || content.length <= maxLength) {
        return { content, wasTruncated: false };
    }

    return {
        content: content.substring(0, maxLength) + '... [truncated]',
        wasTruncated: true,
    };
}
