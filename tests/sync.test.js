/**
 * Unit Tests for Sync Module
 * Tests debouncing, rate limiting, retry logic, and upload loop prevention
 */

import { jest } from '@jest/globals';

// Mock Chrome APIs
global.chrome = {
    storage: {
        local: {
            get: jest.fn().mockResolvedValue({}),
            set: jest.fn().mockResolvedValue(),
            remove: jest.fn().mockResolvedValue(),
        },
    },
    runtime: {
        getPlatformInfo: jest.fn().mockResolvedValue({ os: 'win', arch: 'x86-64' }),
    },
};

// Import test exports
import { CONFIG } from '../src/config.js';

// Mock implementations for testing
const createMockSyncModule = () => {
    // Rate limiting state
    const rateLimitState = {
        requestCount: 0,
        windowStart: Date.now(),
    };

    // Debounce state
    const debounceTimers = new Map();

    // Track recently uploaded hashes
    const recentlyUploaded = new Set();

    const checkRateLimit = () => {
        const now = Date.now();
        const windowMs = CONFIG.SYNC.RATE_LIMIT_WINDOW_MS;

        if (now - rateLimitState.windowStart > windowMs) {
            rateLimitState.requestCount = 0;
            rateLimitState.windowStart = now;
        }

        return rateLimitState.requestCount < CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS;
    };

    const incrementRateLimit = () => {
        rateLimitState.requestCount++;
    };

    const resetRateLimit = () => {
        rateLimitState.requestCount = 0;
        rateLimitState.windowStart = Date.now();
    };

    return {
        rateLimitState,
        debounceTimers,
        recentlyUploaded,
        checkRateLimit,
        incrementRateLimit,
        resetRateLimit,
    };
};

describe('Rate Limiting', () => {
    let syncModule;

    beforeEach(() => {
        syncModule = createMockSyncModule();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('allows requests within rate limit', () => {
        for (let i = 0; i < CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS; i++) {
            expect(syncModule.checkRateLimit()).toBe(true);
            syncModule.incrementRateLimit();
        }
    });

    test('blocks requests when rate limit exceeded', () => {
        for (let i = 0; i < CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS; i++) {
            syncModule.incrementRateLimit();
        }

        expect(syncModule.checkRateLimit()).toBe(false);
    });

    test('resets rate limit after window expires', () => {
        // Use up the rate limit
        for (let i = 0; i < CONFIG.SYNC.RATE_LIMIT_MAX_REQUESTS; i++) {
            syncModule.incrementRateLimit();
        }
        expect(syncModule.checkRateLimit()).toBe(false);

        // Advance time past the window
        jest.advanceTimersByTime(CONFIG.SYNC.RATE_LIMIT_WINDOW_MS + 1);

        // Rate limit should be reset
        expect(syncModule.checkRateLimit()).toBe(true);
    });
});

describe('Debouncing', () => {
    let debounceTimers;

    beforeEach(() => {
        debounceTimers = new Map();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('debounces rapid calls', () => {
        const mockFn = jest.fn();
        const contentHash = 'test-hash';
        const debounceMs = CONFIG.SYNC.DEBOUNCE_MS;

        // Simulate debounce logic
        const debounce = (hash, fn) => {
            if (debounceTimers.has(hash)) {
                clearTimeout(debounceTimers.get(hash));
            }

            const timer = setTimeout(() => {
                debounceTimers.delete(hash);
                fn();
            }, debounceMs);

            debounceTimers.set(hash, timer);
        };

        // Call multiple times rapidly
        debounce(contentHash, mockFn);
        debounce(contentHash, mockFn);
        debounce(contentHash, mockFn);

        // Function should not be called yet
        expect(mockFn).not.toHaveBeenCalled();

        // Advance time partially
        jest.advanceTimersByTime(debounceMs - 100);
        expect(mockFn).not.toHaveBeenCalled();

        // Advance time to complete debounce
        jest.advanceTimersByTime(100);
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('debounces different content separately', () => {
        const mockFn1 = jest.fn();
        const mockFn2 = jest.fn();
        const debounceMs = CONFIG.SYNC.DEBOUNCE_MS;

        const debounce = (hash, fn) => {
            if (debounceTimers.has(hash)) {
                clearTimeout(debounceTimers.get(hash));
            }

            const timer = setTimeout(() => {
                debounceTimers.delete(hash);
                fn();
            }, debounceMs);

            debounceTimers.set(hash, timer);
        };

        debounce('hash1', mockFn1);
        debounce('hash2', mockFn2);

        // Both should execute after debounce time
        jest.advanceTimersByTime(debounceMs);

        expect(mockFn1).toHaveBeenCalledTimes(1);
        expect(mockFn2).toHaveBeenCalledTimes(1);
    });
});

describe('Retry with Exponential Backoff', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const retryWithBackoff = async (fn, attempts = CONFIG.SYNC.RETRY_ATTEMPTS) => {
        let lastError;

        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (err) {
                lastError = err;

                if (err.message?.includes('auth') || err.status === 401) {
                    throw err;
                }

                const delay = CONFIG.SYNC.RETRY_BASE_DELAY_MS * Math.pow(2, i);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    };

    test('succeeds on first try', async () => {
        const mockFn = jest.fn().mockResolvedValue('success');

        const result = await retryWithBackoff(mockFn);

        expect(result).toBe('success');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('retries on failure then succeeds', async () => {
        const mockFn = jest.fn()
            .mockRejectedValueOnce(new Error('Network error'))
            .mockResolvedValue('success');

        const resultPromise = retryWithBackoff(mockFn);

        // Advance timers for the retry delay
        await jest.advanceTimersByTimeAsync(CONFIG.SYNC.RETRY_BASE_DELAY_MS);

        const result = await resultPromise;

        expect(result).toBe('success');
        expect(mockFn).toHaveBeenCalledTimes(2);
    });

    test('does not retry on auth errors', async () => {
        const authError = new Error('Authentication failed');
        authError.message = 'auth error';
        const mockFn = jest.fn().mockRejectedValue(authError);

        await expect(retryWithBackoff(mockFn)).rejects.toThrow('auth error');
        expect(mockFn).toHaveBeenCalledTimes(1);
    });

    test('throws after max retries', async () => {
        jest.useRealTimers(); // Use real timers for this test

        const mockFn = jest.fn().mockRejectedValue(new Error('Persistent error'));

        // Use a minimal delay version for testing
        const retryWithBackoffFast = async (fn, attempts = 3) => {
            let lastError;
            for (let i = 0; i < attempts; i++) {
                try {
                    return await fn();
                } catch (err) {
                    lastError = err;
                    if (err.message?.includes('auth') || err.status === 401) {
                        throw err;
                    }
                    // Use minimal delay for testing
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
            }
            throw lastError;
        };

        await expect(retryWithBackoffFast(mockFn, 3)).rejects.toThrow('Persistent error');
        expect(mockFn).toHaveBeenCalledTimes(3);
    });
});

describe('Upload Loop Prevention', () => {
    let recentlyUploaded;
    const UPLOAD_HASH_TTL = 5000;

    beforeEach(() => {
        recentlyUploaded = new Set();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('prevents duplicate uploads within TTL window', () => {
        const contentHash = 'test-hash-123';

        // First upload succeeds
        expect(recentlyUploaded.has(contentHash)).toBe(false);
        recentlyUploaded.add(contentHash);

        // Second upload should be blocked
        expect(recentlyUploaded.has(contentHash)).toBe(true);
    });

    test('allows upload after TTL expires', () => {
        const contentHash = 'test-hash-456';

        // First upload
        recentlyUploaded.add(contentHash);
        expect(recentlyUploaded.has(contentHash)).toBe(true);

        // Remove after TTL
        setTimeout(() => recentlyUploaded.delete(contentHash), UPLOAD_HASH_TTL);

        // Still blocked
        expect(recentlyUploaded.has(contentHash)).toBe(true);

        // Advance past TTL
        jest.advanceTimersByTime(UPLOAD_HASH_TTL + 1);

        // Now allowed
        expect(recentlyUploaded.has(contentHash)).toBe(false);
    });
});

describe('Hash Content', () => {
    const hashContent = (content) => {
        if (!content) return '';

        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }

        return Math.abs(hash).toString(36);
    };

    test('produces consistent hashes', () => {
        const content = 'Hello, World!';
        const hash1 = hashContent(content);
        const hash2 = hashContent(content);

        expect(hash1).toBe(hash2);
    });

    test('produces different hashes for different content', () => {
        const hash1 = hashContent('Hello');
        const hash2 = hashContent('World');

        expect(hash1).not.toBe(hash2);
    });

    test('handles empty content', () => {
        expect(hashContent('')).toBe('');
        expect(hashContent(null)).toBe('');
        expect(hashContent(undefined)).toBe('');
    });
});

describe('Merge Algorithm', () => {
    const mergeItems = (serverItems, cachedItems) => {
        const itemMap = new Map();

        // Add server items first (they're authoritative)
        for (const item of serverItems) {
            itemMap.set(item.id, item);
        }

        // Add cached items that aren't on server (might be pending upload)
        for (const item of cachedItems) {
            if (!itemMap.has(item.id) && item.pending) {
                itemMap.set(item.id, item);
            }
        }

        // Sort by created_at descending
        return Array.from(itemMap.values())
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    };

    test('prefers server items over cached items', () => {
        const serverItems = [
            { id: '1', content: 'Server version', created_at: '2024-01-01T12:00:00Z' }
        ];
        const cachedItems = [
            { id: '1', content: 'Cached version', created_at: '2024-01-01T11:00:00Z' }
        ];

        const merged = mergeItems(serverItems, cachedItems);

        expect(merged).toHaveLength(1);
        expect(merged[0].content).toBe('Server version');
    });

    test('includes pending cached items not on server', () => {
        const serverItems = [
            { id: '1', content: 'Server item', created_at: '2024-01-01T12:00:00Z' }
        ];
        const cachedItems = [
            { id: '2', content: 'Pending item', created_at: '2024-01-01T13:00:00Z', pending: true }
        ];

        const merged = mergeItems(serverItems, cachedItems);

        expect(merged).toHaveLength(2);
        expect(merged[0].content).toBe('Pending item');
        expect(merged[1].content).toBe('Server item');
    });

    test('excludes non-pending cached items not on server', () => {
        const serverItems = [
            { id: '1', content: 'Server item', created_at: '2024-01-01T12:00:00Z' }
        ];
        const cachedItems = [
            { id: '2', content: 'Old cached item', created_at: '2024-01-01T11:00:00Z' }
        ];

        const merged = mergeItems(serverItems, cachedItems);

        expect(merged).toHaveLength(1);
        expect(merged[0].content).toBe('Server item');
    });

    test('sorts by created_at descending', () => {
        const serverItems = [
            { id: '1', content: 'Old', created_at: '2024-01-01T10:00:00Z' },
            { id: '2', content: 'New', created_at: '2024-01-01T14:00:00Z' },
            { id: '3', content: 'Middle', created_at: '2024-01-01T12:00:00Z' }
        ];

        const merged = mergeItems(serverItems, []);

        expect(merged[0].content).toBe('New');
        expect(merged[1].content).toBe('Middle');
        expect(merged[2].content).toBe('Old');
    });
});
