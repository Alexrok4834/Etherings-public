const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');
const invalid = () => ({ status: 400, body: { code: 'SILVER_PROGRESSION_REQUEST_INVALID' } });

// HTTP supplies only a session, Ring mint and operation reference. It never
// supplies costs, issuer authority, current chain state or ERT hold evidence.
export function createSilverProgressionHttp({ auth, progression, flow }) {
  if (typeof auth?.me !== 'function' || typeof progression?.prepare !== 'function' ||
      ['review', 'refresh', 'submit', 'status'].some(name => typeof flow?.[name] !== 'function'))
    throw new Error('Silver progression HTTP unavailable');
  const owner = async (token, body, names) => {
    if (!fields(body, names) || !UUID.test(body.operationId ?? ''))
      return { failure: invalid() };
    const session = await auth.me(token);
    return session.status === 200 ? { accountId: session.body.id } : { failure: session };
  };
  return {
    prepare: (token, mint, body) => progression.prepare(token, mint, body),
    async review(token, body) {
      const bound = await owner(token, body, ['operationId']);
      if (bound.failure) return bound.failure;
      try { return { status: 200, body: await flow.review(bound.accountId, body.operationId) }; }
      catch (error) {
        if (error.code === 'SILVER_SOL_INSUFFICIENT') return { status: 409,
          body: { code: error.code } };
        throw error;
      }
    },
    async refresh(token, body) {
      const bound = await owner(token, body, ['operationId', 'approved']);
      if (bound.failure) return bound.failure;
      try { return { status: 200, body: await flow.refresh(bound.accountId,
        body.operationId, body.approved) }; }
      catch (error) {
        if (error.code === 'SILVER_SOL_INSUFFICIENT') return { status: 409,
          body: { code: error.code } };
        throw error;
      }
    },
    async submit(token, body) {
      const bound = await owner(token, body,
        ['operationId', 'refreshed', 'userSignatureBase64']);
      if (bound.failure || typeof body.userSignatureBase64 !== 'string')
        return bound.failure ?? invalid();
      return { status: 200, body: await flow.submit(bound.accountId,
        body.operationId, body.refreshed, body.userSignatureBase64) };
    },
    async status(token, body) {
      const bound = await owner(token, body, ['operationId']);
      return bound.failure ?? { status: 200,
        body: await flow.status(bound.accountId, body.operationId) };
    },
  };
}
