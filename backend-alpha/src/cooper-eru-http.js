const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => ({ status: 400, body: { code: 'COOPER_ERU_REQUEST_INVALID' } });
const fields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');

// HTTP only supplies a session and operation ID. All costs, wallet binding,
// chain config and signing authority remain in the existing guarded flow.
export function createCooperEruHttp({ auth, levelUp, flow }) {
  if (typeof auth?.me !== 'function' || typeof levelUp?.prepareEru !== 'function' ||
      ['review', 'refresh', 'submit', 'status'].some(name =>
        typeof flow?.[name] !== 'function')) throw new Error('Cooper ERU HTTP unavailable');
  const owner = async token => {
    const session = await auth.me(token);
    return session.status === 200 ? { accountId: session.body.id } : { failure: session };
  };
  const operation = async (token, body, names) => {
    if (!fields(body, names) || typeof body.operationId !== 'string' ||
        !UUID.test(body.operationId)) return { failure: invalid() };
    return owner(token);
  };
  return {
    prepare: (token, ringId, body) => levelUp.prepareEru(token, ringId, body),
    async review(token, body) {
      const bound = await operation(token, body, ['operationId']);
      return bound.failure ?? { status: 200,
        body: await flow.review(bound.accountId, body.operationId) };
    },
    async refresh(token, body) {
      const bound = await operation(token, body, ['approved', 'operationId']);
      if (bound.failure) return bound.failure;
      return { status: 200, body: await flow.refresh(bound.accountId,
        body.operationId, body.approved) };
    },
    async submit(token, body) {
      const bound = await operation(token, body,
        ['operationId', 'refreshed', 'userSignatureBase64']);
      if (bound.failure || typeof body.userSignatureBase64 !== 'string')
        return bound.failure ?? invalid();
      return { status: 200, body: await flow.submit(bound.accountId,
        body.operationId, body.refreshed, body.userSignatureBase64) };
    },
    async status(token, body) {
      const bound = await operation(token, body, ['operationId']);
      return bound.failure ?? { status: 200,
        body: await flow.status(bound.accountId, body.operationId) };
    },
  };
}
