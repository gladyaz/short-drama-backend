import {
  canTransitionPaymentOrder,
  isPaymentOrderStatus,
  OPEN_PAYMENT_ORDER_STATUSES,
  PAYMENT_ORDER_STATUSES,
  PaymentOrderStatus,
  paymentOrderStatusesAllowingTransitionTo,
} from './payment-state.constants';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": pure state-machine spec.
 * The CAS `where` clauses in `PaymentNotificationService` are derived from
 * this relation, so these assertions ARE the monotonicity guarantees —
 * anything asserted impossible here matches 0 rows at the database.
 */
describe('payment state machine', () => {
  describe('canTransitionPaymentOrder — allowed edges', () => {
    const allowed: Array<[PaymentOrderStatus, PaymentOrderStatus]> = [
      ['CREATED', 'PENDING'],
      ['CREATED', 'PAID'],
      ['CREATED', 'FAILED'],
      ['CREATED', 'EXPIRED'],
      ['CREATED', 'CANCELED'],
      ['PENDING', 'PAID'],
      ['PENDING', 'FAILED'],
      ['PENDING', 'EXPIRED'],
      ['PENDING', 'CANCELED'],
      ['FAILED', 'PENDING'],
      ['FAILED', 'PAID'],
      ['FAILED', 'EXPIRED'],
      ['EXPIRED', 'PAID'],
      ['CANCELED', 'PAID'],
      ['PAID', 'REFUNDED'],
    ];

    it.each(allowed)('%s -> %s is allowed', (from, to) => {
      expect(canTransitionPaymentOrder(from, to)).toBe(true);
    });
  });

  describe('CRITICAL: PAID never downgrades', () => {
    const nonRefund = PAYMENT_ORDER_STATUSES.filter(
      (status) => status !== 'REFUNDED' && status !== 'PAID',
    );

    it.each(nonRefund.map((s) => [s]))('PAID -> %s is impossible', (target) => {
      expect(canTransitionPaymentOrder('PAID', target)).toBe(false);
    });

    it('a regressive pending after settlement matches no PENDING-admitting state', () => {
      expect(paymentOrderStatusesAllowingTransitionTo('PENDING')).not.toContain(
        'PAID',
      );
    });
  });

  describe('CRITICAL: REFUNDED is terminal', () => {
    it.each(PAYMENT_ORDER_STATUSES.map((s) => [s]))(
      'REFUNDED -> %s is impossible',
      (target) => {
        expect(canTransitionPaymentOrder('REFUNDED', target)).toBe(false);
      },
    );
  });

  describe('regressive/invalid edges', () => {
    it('nothing transitions into CREATED', () => {
      expect(paymentOrderStatusesAllowingTransitionTo('CREATED')).toEqual([]);
    });

    it('EXPIRED cannot regress to PENDING', () => {
      expect(canTransitionPaymentOrder('EXPIRED', 'PENDING')).toBe(false);
    });

    it('CANCELED cannot regress to PENDING or FAILED', () => {
      expect(canTransitionPaymentOrder('CANCELED', 'PENDING')).toBe(false);
      expect(canTransitionPaymentOrder('CANCELED', 'FAILED')).toBe(false);
    });

    it('REFUNDED is reachable only from PAID', () => {
      expect(paymentOrderStatusesAllowingTransitionTo('REFUNDED')).toEqual([
        'PAID',
      ]);
    });
  });

  describe('paymentOrderStatusesAllowingTransitionTo — the PAID CAS set', () => {
    it('admits every non-paid, non-refunded state and nothing else', () => {
      expect(
        [...paymentOrderStatusesAllowingTransitionTo('PAID')].sort(),
      ).toEqual(['CANCELED', 'CREATED', 'EXPIRED', 'FAILED', 'PENDING'].sort());
    });
  });

  describe('open-slot bookkeeping', () => {
    it('exactly CREATED and PENDING hold the openOrderKey slot', () => {
      expect([...OPEN_PAYMENT_ORDER_STATUSES]).toEqual(['CREATED', 'PENDING']);
    });
  });

  describe('isPaymentOrderStatus', () => {
    it('accepts every canonical status', () => {
      for (const status of PAYMENT_ORDER_STATUSES) {
        expect(isPaymentOrderStatus(status)).toBe(true);
      }
    });

    it('rejects raw provider strings and junk', () => {
      expect(isPaymentOrderStatus('settlement')).toBe(false);
      expect(isPaymentOrderStatus('paid')).toBe(false);
      expect(isPaymentOrderStatus('')).toBe(false);
    });
  });
});
