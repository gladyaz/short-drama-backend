import {
  HttpMidtransClient,
  MIDTRANS_PRODUCTION_API_BASE_URL,
  MIDTRANS_PRODUCTION_SNAP_BASE_URL,
  MIDTRANS_SANDBOX_API_BASE_URL,
  MIDTRANS_SANDBOX_SNAP_BASE_URL,
  MidtransGatewayError,
} from './midtrans-http.client';

/**
 * Work unit "MIDTRANS PAYMENT BACKEND FOUNDATION": transport adapter spec.
 * `fetchFn` is a recording fake — NO test in this file (or anywhere in the
 * suite) performs a real network call to any Midtrans host; the
 * sandbox/production URLs are asserted as strings passed to the fake.
 */
const SERVER_KEY = 'unit-test-server-key';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function makeFetchFake(responses: Response[]): {
  calls: RecordedCall[];
  fetchFn: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetchFn = ((url: string | URL | Request, init?: RequestInit) => {
    // The client always passes a plain string URL.
    calls.push({ url: url as string, init: init ?? {} });
    const next = queue.shift();
    if (!next) {
      return Promise.reject(new Error('fetch fake exhausted'));
    }
    return Promise.resolve(next);
  }) as typeof fetch;
  return { calls, fetchFn };
}

function snapCreatedResponse(): Response {
  return new Response(
    JSON.stringify({
      token: 'snap-token-1',
      redirect_url:
        'https://app.sandbox.midtrans.com/snap/v3/redirection/snap-token-1',
    }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('HttpMidtransClient', () => {
  describe('sandbox/production endpoint separation', () => {
    it('CRITICAL: isProduction=false targets the SANDBOX Snap and Core API hosts', async () => {
      const { calls, fetchFn } = makeFetchFake([
        snapCreatedResponse(),
        new Response(JSON.stringify({ status_code: '404' }), { status: 200 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await client.createSnapTransaction({
        orderId: 'sd-a',
        grossAmountIdr: 49000,
        expiryMinutes: 60,
      });
      await client.getTransactionStatus('sd-a');

      expect(calls[0].url).toBe(
        `${MIDTRANS_SANDBOX_SNAP_BASE_URL}/snap/v1/transactions`,
      );
      expect(calls[1].url).toBe(
        `${MIDTRANS_SANDBOX_API_BASE_URL}/v2/sd-a/status`,
      );
    });

    it('CRITICAL: isProduction=true targets the PRODUCTION hosts (URL selection only — never called for real in this suite)', async () => {
      const { calls, fetchFn } = makeFetchFake([
        snapCreatedResponse(),
        new Response(JSON.stringify({ status_code: '404' }), { status: 200 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: true,
        fetchFn,
      });

      await client.createSnapTransaction({
        orderId: 'sd-b',
        grossAmountIdr: 19000,
        expiryMinutes: 60,
      });
      await client.getTransactionStatus('sd-b');

      expect(calls[0].url).toBe(
        `${MIDTRANS_PRODUCTION_SNAP_BASE_URL}/snap/v1/transactions`,
      );
      expect(calls[1].url).toBe(
        `${MIDTRANS_PRODUCTION_API_BASE_URL}/v2/sd-b/status`,
      );
    });
  });

  describe('authentication and request shape', () => {
    it('sends Basic base64(SERVER_KEY + ":") and the verified Snap body fields', async () => {
      const { calls, fetchFn } = makeFetchFake([snapCreatedResponse()]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await client.createSnapTransaction({
        orderId: 'sd-auth',
        grossAmountIdr: 129000,
        expiryMinutes: 1440,
      });

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(
        `Basic ${Buffer.from(`${SERVER_KEY}:`).toString('base64')}`,
      );
      expect(headers['Content-Type']).toBe('application/json');

      // The client always passes `JSON.stringify(...)` output — a string.
      const body = JSON.parse(calls[0].init.body as string) as {
        transaction_details: { order_id: string; gross_amount: number };
        expiry: { unit: string; duration: number };
        credit_card: { secure: boolean };
      };
      expect(body.transaction_details).toEqual({
        order_id: 'sd-auth',
        gross_amount: 129000,
      });
      expect(body.expiry).toEqual({ unit: 'minutes', duration: 1440 });
      expect(body.credit_card).toEqual({ secure: true });
      expect(calls[0].init.redirect).toBe('error');
    });

    it('parses the verified {token, redirect_url} response', async () => {
      const { fetchFn } = makeFetchFake([snapCreatedResponse()]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await expect(
        client.createSnapTransaction({
          orderId: 'sd-parse',
          grossAmountIdr: 49000,
          expiryMinutes: 60,
        }),
      ).resolves.toEqual({
        token: 'snap-token-1',
        redirectUrl:
          'https://app.sandbox.midtrans.com/snap/v3/redirection/snap-token-1',
      });
    });
  });

  describe('failure handling never leaks the Server Key', () => {
    it('non-2xx Snap create throws MidtransGatewayError carrying only the HTTP status', async () => {
      const { fetchFn } = makeFetchFake([
        new Response('{"error_messages":["denied"]}', { status: 401 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      const failure = client.createSnapTransaction({
        orderId: 'sd-fail',
        grossAmountIdr: 49000,
        expiryMinutes: 60,
      });
      await expect(failure).rejects.toBeInstanceOf(MidtransGatewayError);
      await failure.catch((error: MidtransGatewayError) => {
        expect(error.httpStatus).toBe(401);
        expect(String(error)).not.toContain(SERVER_KEY);
        expect(String(error)).not.toContain(
          Buffer.from(`${SERVER_KEY}:`).toString('base64'),
        );
      });
    });

    it('a transport error surfaces as a fixed, secret-free message (never the undici error)', async () => {
      const fetchFn = (() =>
        Promise.reject(
          new Error(`connect ECONNREFUSED with Authorization ${SERVER_KEY}`),
        )) as unknown as typeof fetch;
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      const failure = client.getTransactionStatus('sd-transport');
      await expect(failure).rejects.toBeInstanceOf(MidtransGatewayError);
      await failure.catch((error: MidtransGatewayError) => {
        expect(String(error)).not.toContain(SERVER_KEY);
        expect(String(error)).toContain('transport error or timeout');
      });
    });

    it('a non-JSON success body throws a shape error', async () => {
      const { fetchFn } = makeFetchFake([
        new Response('<html>oops</html>', { status: 201 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await expect(
        client.createSnapTransaction({
          orderId: 'sd-html',
          grossAmountIdr: 49000,
          expiryMinutes: 60,
        }),
      ).rejects.toThrow(/non-JSON body/);
    });
  });

  describe('getTransactionStatus', () => {
    it('maps a found transaction to normalized fields', async () => {
      const { fetchFn } = makeFetchFake([
        new Response(
          JSON.stringify({
            status_code: '200',
            order_id: 'sd-found',
            transaction_id: 'mid-tx-9',
            transaction_status: 'settlement',
            fraud_status: 'accept',
            gross_amount: '49000.00',
            some_future_field: 'tolerated',
          }),
          { status: 200 },
        ),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await expect(client.getTransactionStatus('sd-found')).resolves.toEqual({
        found: true,
        orderId: 'sd-found',
        transactionId: 'mid-tx-9',
        transactionStatus: 'settlement',
        fraudStatus: 'accept',
        statusCode: '200',
        grossAmount: '49000.00',
      });
    });

    it('HTTP 404 resolves { found: false } (customer never started paying — not an error)', async () => {
      const { fetchFn } = makeFetchFake([
        new Response('{"status_code":"404"}', { status: 404 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await expect(client.getTransactionStatus('sd-miss')).resolves.toEqual({
        found: false,
      });
    });

    it('a 200 body carrying status_code "404" also resolves { found: false }', async () => {
      const { fetchFn } = makeFetchFake([
        new Response(
          JSON.stringify({
            status_code: '404',
            status_message: "Transaction doesn't exist.",
          }),
          { status: 200 },
        ),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await expect(client.getTransactionStatus('sd-miss2')).resolves.toEqual({
        found: false,
      });
    });

    it('URL-encodes the order id into the status path', async () => {
      const { calls, fetchFn } = makeFetchFake([
        new Response('{"status_code":"404"}', { status: 404 }),
      ]);
      const client = new HttpMidtransClient({
        serverKey: SERVER_KEY,
        isProduction: false,
        fetchFn,
      });

      await client.getTransactionStatus('sd-a/b');
      expect(calls[0].url).toBe(
        `${MIDTRANS_SANDBOX_API_BASE_URL}/v2/sd-a%2Fb/status`,
      );
    });
  });
});
