const STATUSES = new Set(['queued', 'accepted', 'sent', 'delivered', 'undelivered', 'failed', 'unknown']);
export const normalizeStatus = (status) => STATUSES.has(status) ? status : 'unknown';

export class SmsError extends Error {
  constructor(message, ambiguous = false) {
    super(message);
    this.ambiguous = ambiguous;
  }
}

const ERROR_GUIDANCE = {
  20003: 'Twilio authentication failed. Check the Account SID and current Auth Token, then restart the API.',
  21211: 'The recipient phone number is invalid. Use international E.164 format.',
  21408: 'SMS is not enabled for the destination country. Check Twilio Messaging Geographic Permissions.',
  21606: 'The sender number is not an SMS-capable number on this Twilio account. Check TWILIO_FROM_NUMBER.',
  21608: 'This trial account cannot send to that recipient. Verify the recipient in Twilio Console first.',
  21610: 'The recipient has opted out. They must choose to opt back in through Twilio before receiving further messages.',
  21612: 'Twilio cannot route this sender to the destination. Check sender and country-specific requirements.',
  21614: 'The recipient number is not a valid mobile number for SMS.',
  21617: 'The message is too long for the SMS provider.',
  21619: 'Twilio requires a message body.',
  21621: 'This sender number is not verified for this Twilio account.',
  21660: 'The sender number does not match the Twilio account.',
  30003: 'The recipient handset is unreachable. Delivery failed.',
  30004: 'The destination carrier blocked the message.',
  30005: 'The destination number is unknown to the carrier.',
  30006: 'The destination is a landline or an unreachable carrier.',
  30007: 'The carrier filtered the message. Check Twilio messaging compliance requirements.',
  30008: 'The carrier reported an unknown delivery failure.',
  30034: 'US A2P sender registration is required. Complete the applicable registration in Twilio Console.',
  63038: 'The Twilio account exceeded its daily messaging limit.',
};

export function providerError(code, httpStatus) {
  const numericCode = typeof code === 'number' && Number.isSafeInteger(code) && code > 0 ? code : null;
  const guidance = ERROR_GUIDANCE[numericCode]
    || (httpStatus === 401 || httpStatus === 403 ? ERROR_GUIDANCE[20003]
      : httpStatus === 429 ? 'Twilio rate limit reached. Wait before retrying.'
      : 'This app has no specific explanation for this provider error. The account owner must open Twilio Console → Monitor → Logs → Messaging and check the failed message’s error details. If no explanation is available, contact Twilio support with this error code.');
  return `${numericCode ? `Twilio error ${numericCode}` : `SMS provider${httpStatus ? ` HTTP ${httpStatus}` : ' error'}`}: ${guidance}`;
}

export function createTwilioTransport({ accountSid, authToken, fromNumber }) {
  const base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages`;
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, ...options.headers },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
    } catch {
      throw new SmsError('SMS provider did not confirm the request. Delivery is unknown; do not immediately retry.', true);
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new SmsError(providerError(data?.code, response.status), response.status >= 500);
    }
    try {
      const data = await response.json();
      if (!/^SM[a-fA-F0-9]{32}$/.test(data.sid || '')) throw new Error('Invalid provider response');
      return { sid: data.sid, status: normalizeStatus(data.status), error: data.error_code ? providerError(data.error_code) : null };
    } catch {
      throw new SmsError('SMS provider returned an invalid confirmation. Delivery is unknown.', true);
    }
  }
  return {
    send: ({ to, body }) => request(`${base}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: fromNumber, Body: body }),
    }),
    getStatus: (sid) => request(`${base}/${encodeURIComponent(sid)}.json`),
  };
}
