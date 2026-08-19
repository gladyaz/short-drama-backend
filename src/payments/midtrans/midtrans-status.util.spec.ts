import { resolveMidtransTransactionStatus } from './midtrans-status.util';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": provider-status
 * resolution per the verified official contract — success requires
 * settlement/capture + fraud accept (when present) + status_code 200;
 * everything weaker never becomes PAID.
 */
describe('resolveMidtransTransactionStatus', () => {
  describe('success semantics (verified three-field check)', () => {
    it('settlement + status_code 200 (no fraud_status) resolves PAID', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'settlement',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'PAID' });
    });

    it('capture + fraud accept + status_code 200 resolves PAID', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'capture',
          fraudStatus: 'accept',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'PAID' });
    });

    it('settlement + fraud accept + status_code 200 resolves PAID', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'settlement',
          fraudStatus: 'accept',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'PAID' });
    });

    it('CRITICAL: capture + fraud challenge is PENDING, never PAID', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'capture',
          fraudStatus: 'challenge',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'PENDING' });
    });

    it('CRITICAL: capture + fraud deny is FAILED, never PAID', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'capture',
          fraudStatus: 'deny',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'FAILED' });
    });

    it('CRITICAL: an unrecognized fraud_status on a success shape is ignored (fail closed)', () => {
      const resolution = resolveMidtransTransactionStatus({
        transactionStatus: 'settlement',
        fraudStatus: 'totally-new-verdict',
        statusCode: '200',
      });
      expect(resolution.kind).toBe('ignored');
    });

    it('CRITICAL: settlement without status_code 200 is ignored (fail closed)', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'settlement',
          statusCode: '201',
        }).kind,
      ).toBe('ignored');
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'settlement',
        }).kind,
      ).toBe('ignored');
    });
  });

  describe('non-success statuses', () => {
    it('pending resolves PENDING', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'pending',
          statusCode: '201',
        }),
      ).toEqual({ kind: 'transition', target: 'PENDING' });
    });

    it('authorize resolves PENDING (reserved funds are not success)', () => {
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'authorize',
          statusCode: '200',
        }),
      ).toEqual({ kind: 'transition', target: 'PENDING' });
    });

    it('deny resolves FAILED', () => {
      expect(
        resolveMidtransTransactionStatus({ transactionStatus: 'deny' }),
      ).toEqual({ kind: 'transition', target: 'FAILED' });
    });

    it('failure resolves FAILED', () => {
      expect(
        resolveMidtransTransactionStatus({ transactionStatus: 'failure' }),
      ).toEqual({ kind: 'transition', target: 'FAILED' });
    });

    it('cancel resolves CANCELED', () => {
      expect(
        resolveMidtransTransactionStatus({ transactionStatus: 'cancel' }),
      ).toEqual({ kind: 'transition', target: 'CANCELED' });
    });

    it('expire resolves EXPIRED', () => {
      expect(
        resolveMidtransTransactionStatus({ transactionStatus: 'expire' }),
      ).toEqual({ kind: 'transition', target: 'EXPIRED' });
    });

    it('refund and partial_refund resolve REFUNDED', () => {
      expect(
        resolveMidtransTransactionStatus({ transactionStatus: 'refund' }),
      ).toEqual({ kind: 'transition', target: 'REFUNDED' });
      expect(
        resolveMidtransTransactionStatus({
          transactionStatus: 'partial_refund',
        }),
      ).toEqual({ kind: 'transition', target: 'REFUNDED' });
    });

    it('an unknown transaction_status is ignored, never a transition', () => {
      const resolution = resolveMidtransTransactionStatus({
        transactionStatus: 'some-future-status',
        statusCode: '200',
      });
      expect(resolution.kind).toBe('ignored');
    });
  });
});
