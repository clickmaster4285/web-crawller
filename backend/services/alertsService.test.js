/**
 * Unit tests for the alerts engine's pure mapping logic (Phase 4). The
 * Mongo-backed paths (listAlerts, markRead, markAllRead, dismiss) are covered
 * by the live-Mongo E2E smoke instead — this suite runs under `npm test`
 * with no database.
 */
const {
  mapEventToAlert,
  pctChange,
  severityForPriceChange
} = require('./alertsService');

const event = (overrides = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  origin: 'https://store.example.com',
  key: 'store.example.com',
  name: 'Widget Pro',
  url: 'https://store.example.com/products/widget-pro',
  at: new Date('2026-08-05T10:00:00Z'),
  ...overrides
});

describe('mapEventToAlert', () => {
  test('added → new_product (low)', () => {
    const a = mapEventToAlert(event({ type: 'added', old: null, new: { price: 10, available: true } }));
    expect(a.type).toBe('new_product');
    expect(a.severity).toBe('low');
    expect(a.title).toContain('Widget Pro');
    expect(a.competitor).toBe('store.example.com');
    expect(a.time).toBe('2026-08-05T10:00:00.000Z');
  });

  test('removed → removed (high)', () => {
    const a = mapEventToAlert(event({ type: 'removed', old: { price: 10, available: true }, new: null }));
    expect(a.type).toBe('removed');
    expect(a.severity).toBe('high');
  });

  test('price drop carries negative % + signed amount', () => {
    const a = mapEventToAlert(
      event({ type: 'price_changed', old: { price: 100, available: true }, new: { price: 80, available: true } })
    );
    expect(a.type).toBe('price_drop');
    expect(a.priceChangePct).toBeCloseTo(-20);
    expect(a.priceChangeAmount).toBe(-20);
    expect(a.detail).toContain('−20.0%');
  });

  test('price rise carries positive % + signed amount', () => {
    const a = mapEventToAlert(
      event({ type: 'price_changed', old: { price: 100, available: true }, new: { price: 125, available: true } })
    );
    expect(a.type).toBe('price_rise');
    expect(a.priceChangePct).toBeCloseTo(25);
    expect(a.priceChangeAmount).toBe(25);
    expect(a.detail).toContain('+25.0%');
  });

  test('stock restock vs out-of-stock', () => {
    const back = mapEventToAlert(
      event({ type: 'stock_changed', old: { price: 10, available: false }, new: { price: 10, available: true } })
    );
    expect(back.type).toBe('stock');
    expect(back.severity).toBe('low');
    expect(back.title).toContain('Back in stock');

    const gone = mapEventToAlert(
      event({ type: 'stock_changed', old: { price: 10, available: true }, new: { price: 10, available: false } })
    );
    expect(gone.severity).toBe('medium');
    expect(gone.title).toContain('Out of stock');
  });

  test('unparseable price change → null (no bogus alert)', () => {
    expect(mapEventToAlert(event({ type: 'price_changed', old: { price: 100 }, new: {} }))).toBeNull();
    expect(mapEventToAlert(event({ type: 'price_changed', old: null, new: { price: 80 } }))).toBeNull();
  });

  test('unknown type → null', () => {
    expect(mapEventToAlert(event({ type: 'nope' }))).toBeNull();
  });
});

describe('severity + pct helpers', () => {
  test('pctChange math and null guards', () => {
    expect(pctChange(100, 80)).toBeCloseTo(-20);
    expect(pctChange(100, 115)).toBeCloseTo(15);
    expect(pctChange(0, 10)).toBeNull();
    expect(pctChange(100, NaN)).toBeNull();
  });

  test('severity tiers by magnitude', () => {
    expect(severityForPriceChange(-25)).toBe('high');
    expect(severityForPriceChange(15)).toBe('high');
    expect(severityForPriceChange(-8)).toBe('medium');
    expect(severityForPriceChange(4.9)).toBe('low');
    expect(severityForPriceChange(null)).toBe('low');
  });
});
