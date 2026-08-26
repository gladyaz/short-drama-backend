import { Logger } from '@nestjs/common';
import {
  DEFAULT_WHATSAPP_GRAPH_VERSION,
  WHATSAPP_CLOUD_API_TIMEOUT_MS,
  WHATSAPP_GRAPH_BASE_URL,
  WhatsAppCloudApiOptions,
  WhatsAppCloudApiOtpProvider,
} from './whatsapp-cloud-api.provider';
import { WhatsAppDeliveryError } from './whatsapp-otp.types';

/**
 * WHATSAPP LOGIN V1 — the production driver, exercised against a MOCKED
 * transport. No test in this file (or anywhere in this repository) reaches
 * the network or sends a WhatsApp message: every case substitutes `fetchFn`,
 * which is why the class carries that seam at all.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE. It proves the request this client
 * builds, and its reaction to every failure mode the contract documents. It
 * cannot prove that Meta accepts that request — no offline test can, and
 * pretending otherwise is exactly the "an unexercised vendor client looks
 * identical to a working one" trap this work unit exists to avoid. The first
 * real send is an operator step (`docs/WHATSAPP_LOGIN_SETUP.md`).
 */

const OPTIONS = {
  phoneNumberId: '111122223333444',
  accessToken: 'SPEC-FIXTURE-ACCESS-TOKEN-NOT-A-REAL-CREDENTIAL',
  templateName: 'red_panda_login_otp',
  templateLanguage: 'id',
};

const INPUT = {
  phoneE164: '+6281234567890',
  code: '123456',
  expiresInSeconds: 300,
};

type ResponseSource = Response | (() => Promise<Response>);

/** A Cloud API success body, in Meta's documented shape. */
function acceptedResponse(): Response {
  return new Response(
    JSON.stringify({
      messaging_product: 'whatsapp',
      contacts: [{ input: '6281234567890', wa_id: '6281234567890' }],
      messages: [{ id: 'wamid.SPECFIXTURE', message_status: 'accepted' }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** A Cloud API error body, in Meta's documented shape. */
function errorResponse(status: number, code?: number): Response {
  const error =
    code === undefined
      ? { message: 'spec fixture', type: 'OAuthException' }
      : {
          message: 'spec fixture',
          type: 'OAuthException',
          code,
          fbtrace_id: 'SPECFIXTURE',
        };
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  init: RequestInit;
  /**
   * The request body captured as a STRING at record time. Narrowed here
   * rather than stringified at the assertion site: `RequestInit['body']` is
   * `BodyInit | null`, whose `String()` would be a `[object Object]` waiting
   * to happen — and this client always sends `JSON.stringify` output.
   */
  body: string;
}

/** Records the single call this client makes, and answers with `response`. */
function recordingFetch(response: ResponseSource): {
  fetchFn: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = (url: string, init: RequestInit & { body: string }) => {
    calls.push({ url, init, body: init.body });
    return typeof response === 'function'
      ? response()
      : Promise.resolve(response);
  };
  return { fetchFn: record, calls };
}

function buildProvider(
  overrides: Partial<WhatsAppCloudApiOptions> = {},
  fetchFn?: typeof fetch,
): WhatsAppCloudApiOtpProvider {
  return new WhatsAppCloudApiOtpProvider({ ...OPTIONS, ...overrides, fetchFn });
}

interface SentTemplateBody {
  messaging_product: string;
  recipient_type: string;
  to: string;
  type: string;
  template: {
    name: string;
    language: { code: string };
    components: Array<{ type: string; [key: string]: unknown }>;
  };
}

/** The parsed JSON body of the one recorded request. */
function sentBody(calls: RecordedCall[]): SentTemplateBody {
  return JSON.parse(calls[0].body) as SentTemplateBody;
}

describe('WhatsAppCloudApiOtpProvider', () => {
  describe('construction', () => {
    it.each([
      'phoneNumberId',
      'accessToken',
      'templateName',
      'templateLanguage',
    ] as const)(
      'refuses to be constructed without %s, naming the field',
      (field) => {
        expect(() => buildProvider({ [field]: '' })).toThrow(
          new RegExp(`"${field}" is missing or empty`),
        );
      },
    );

    it('treats a whitespace-only value as missing', () => {
      expect(() => buildProvider({ templateName: '   ' })).toThrow(
        /"templateName" is missing or empty/,
      );
    });

    it('never puts the access token in the construction error', () => {
      let message = '';
      try {
        buildProvider({ templateName: '' });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toContain(OPTIONS.accessToken);
    });
  });

  describe('the request it builds', () => {
    it('POSTs to the pinned Graph version and phone-number id', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);

      expect(calls[0].url).toBe(
        `${WHATSAPP_GRAPH_BASE_URL}/${DEFAULT_WHATSAPP_GRAPH_VERSION}/${OPTIONS.phoneNumberId}/messages`,
      );
      expect(calls[0].init.method).toBe('POST');
    });

    it('honours an explicitly configured Graph version', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({ graphVersion: 'v23.0' }, fetchFn).sendOtp(INPUT);

      expect(calls[0].url).toContain('/v23.0/');
    });

    it('falls back to the pinned version when one is blank', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({ graphVersion: '  ' }, fetchFn).sendOtp(INPUT);

      expect(calls[0].url).toContain(`/${DEFAULT_WHATSAPP_GRAPH_VERSION}/`);
    });

    it('percent-encodes the interpolated URL segments', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({ phoneNumberId: '111/../../evil' }, fetchFn).sendOtp(
        INPUT,
      );

      // The traversal must not survive into real path segments.
      expect(calls[0].url).not.toContain('/../');
      expect(calls[0].url).toContain('111%2F..%2F..%2Fevil');
    });

    it('sends the access token as a Bearer credential', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);

      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${OPTIONS.accessToken}`);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('bounds the request with a timeout and refuses redirects', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);

      expect(calls[0].init.redirect).toBe('error');
      expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
      expect(WHATSAPP_CLOUD_API_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it('builds the documented authentication-template payload', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);
      const body = sentBody(calls);

      expect(body.messaging_product).toBe('whatsapp');
      expect(body.recipient_type).toBe('individual');
      expect(body.type).toBe('template');
      expect(body.template.name).toBe(OPTIONS.templateName);
      expect(body.template.language).toEqual({
        code: OPTIONS.templateLanguage,
      });
    });

    it('strips the leading + from the destination number', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);

      expect(sentBody(calls).to).toBe('6281234567890');
    });

    it('carries the code TWICE — body parameter and OTP button', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({}, fetchFn).sendOtp(INPUT);

      expect(sentBody(calls).template.components).toEqual([
        { type: 'body', parameters: [{ type: 'text', text: INPUT.code }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: INPUT.code }],
        },
      ]);
    });

    it('omits the button component when the template has no OTP button', async () => {
      const { fetchFn, calls } = recordingFetch(acceptedResponse());

      await buildProvider({ templateHasOtpButton: false }, fetchFn).sendOtp(
        INPUT,
      );
      const components = sentBody(calls).template.components;

      expect(components).toHaveLength(1);
      expect(components[0].type).toBe('body');
    });
  });

  describe('success', () => {
    it('resolves when the provider acknowledges a message id', async () => {
      const { fetchFn } = recordingFetch(acceptedResponse());

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['no messages array', { messaging_product: 'whatsapp' }],
      ['an empty messages array', { messages: [] }],
      ['a message with no id', { messages: [{ message_status: 'accepted' }] }],
      ['a message with a blank id', { messages: [{ id: '' }] }],
    ])(
      'CRITICAL: treats a 200 with %s as UNDELIVERED, never as success',
      async (_label, body) => {
        const { fetchFn } = recordingFetch(
          new Response(JSON.stringify(body), { status: 200 }),
        );

        await expect(
          buildProvider({}, fetchFn).sendOtp(INPUT),
        ).rejects.toMatchObject({ kind: 'provider_unavailable' });
      },
    );

    it('treats a 200 with a non-JSON body as undelivered', async () => {
      const { fetchFn } = recordingFetch(
        new Response('<html>not json</html>', { status: 200 }),
      );

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).rejects.toBeInstanceOf(WhatsAppDeliveryError);
    });
  });

  describe('failure classification', () => {
    it.each([500, 502, 503, 504])(
      'HTTP %s is provider_unavailable (Meta is broken, not this number)',
      async (status) => {
        const { fetchFn } = recordingFetch(errorResponse(status));

        await expect(
          buildProvider({}, fetchFn).sendOtp(INPUT),
        ).rejects.toMatchObject({
          kind: 'provider_unavailable',
          httpStatus: status,
        });
      },
    );

    it.each([401, 403, 429])(
      'HTTP %s is provider_unavailable — it breaks login for everyone',
      async (status) => {
        const { fetchFn } = recordingFetch(errorResponse(status));

        await expect(
          buildProvider({}, fetchFn).sendOtp(INPUT),
        ).rejects.toMatchObject({ kind: 'provider_unavailable' });
      },
    );

    it.each([
      [132001, 'template does not exist'],
      [132015, 'template is paused'],
      [132012, 'template parameter format mismatch'],
      [100, 'invalid parameter'],
      [190, 'access token expired'],
    ])(
      'provider error %i (%s) is provider_unavailable, not a recipient problem',
      async (code) => {
        const { fetchFn } = recordingFetch(errorResponse(400, code));

        await expect(
          buildProvider({}, fetchFn).sendOtp(INPUT),
        ).rejects.toMatchObject({ kind: 'provider_unavailable' });
      },
    );

    it.each([
      [131026, 'message undeliverable to this recipient'],
      [131052, 'media download error'],
      [130472, 'recipient is in a messaging experiment'],
    ])(
      'provider error %i (%s) is recipient_rejected — the ONLY per-number class',
      async (code) => {
        const { fetchFn } = recordingFetch(errorResponse(400, code));

        await expect(
          buildProvider({}, fetchFn).sendOtp(INPUT),
        ).rejects.toMatchObject({ kind: 'recipient_rejected' });
      },
    );

    it('an UNRECOGNIZED 4xx error code fails loud, not quiet', async () => {
      const { fetchFn } = recordingFetch(errorResponse(400, 999999));

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).rejects.toMatchObject({ kind: 'provider_unavailable' });
    });

    it('a 4xx with no readable body fails loud', async () => {
      const { fetchFn } = recordingFetch(
        new Response('nonsense', { status: 400 }),
      );

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).rejects.toMatchObject({ kind: 'provider_unavailable' });
    });

    it('a transport error is provider_unavailable and carries no status', async () => {
      const { fetchFn } = recordingFetch(() =>
        Promise.reject(new Error('ECONNRESET')),
      );

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).rejects.toMatchObject({
        kind: 'provider_unavailable',
        httpStatus: undefined,
      });
    });

    it('a TIMEOUT is provider_unavailable', async () => {
      const { fetchFn } = recordingFetch(() =>
        Promise.reject(
          Object.assign(new Error('The operation was aborted'), {
            name: 'TimeoutError',
          }),
        ),
      );

      await expect(
        buildProvider({}, fetchFn).sendOtp(INPUT),
      ).rejects.toMatchObject({ kind: 'provider_unavailable' });
    });
  });

  describe('secret and PII discipline', () => {
    /** Every way this client can fail, so no path escapes the leak check. */
    const FAILURES: Array<[string, ResponseSource]> = [
      ['5xx', errorResponse(500)],
      ['401', errorResponse(401)],
      ['429', errorResponse(429)],
      ['template error', errorResponse(400, 132001)],
      ['recipient rejected', errorResponse(400, 131026)],
      ['unreadable 4xx', new Response('nonsense', { status: 400 })],
      ['unrecognized 200', new Response('{}', { status: 200 })],
      ['transport error', () => Promise.reject(new Error('ECONNRESET'))],
    ];

    it.each(FAILURES)(
      'CRITICAL: a %s failure never leaks the token, the code, or the full number',
      async (_label, response) => {
        const { fetchFn } = recordingFetch(response);

        let message = '';
        try {
          await buildProvider({}, fetchFn).sendOtp(INPUT);
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toBe('');
        expect(message).not.toContain(OPTIONS.accessToken);
        expect(message).not.toContain(INPUT.code);
        expect(message).not.toContain(INPUT.phoneE164);
        expect(message).not.toContain('6281234567890');
      },
    );

    it('CRITICAL: no log line carries the code, the token, or the full number', async () => {
      const written: string[] = [];
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((value: unknown) => {
          written.push(String(value));
        });

      try {
        for (const [, response] of FAILURES) {
          const { fetchFn } = recordingFetch(response);
          await buildProvider({}, fetchFn)
            .sendOtp(INPUT)
            .catch(() => undefined);
        }
      } finally {
        errorSpy.mockRestore();
      }

      expect(written.length).toBeGreaterThan(0);
      const all = written.join('\n');
      expect(all).not.toContain(OPTIONS.accessToken);
      expect(all).not.toContain(INPUT.code);
      expect(all).not.toContain(INPUT.phoneE164);
      expect(all).not.toContain('6281234567890');
      // The last four digits ARE permitted — they are what makes a report
      // actionable without identifying anyone.
      expect(all).toContain('...7890');
    });
  });
});
