const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalid = () => ({ status: 400, body: { code: 'COOPER_BREEDING_REQUEST_INVALID' } });
const fields = (body, names) => body && typeof body === 'object' &&
  !Array.isArray(body) && Object.keys(body).sort().join(',') === names.sort().join(',');

export function createCooperBreedingHttp({ auth, breeding, flow }) {
  if (typeof auth?.me !== 'function' ||
      typeof breeding?.preview !== 'function' ||
      typeof breeding?.prepare !== 'function' ||
      ['review', 'refresh', 'submit', 'status'].some(name =>
        typeof flow?.[name] !== 'function'))
    throw new Error('Cooper breeding HTTP unavailable');
  const owner = async token => {
    const session = await auth.me(token);
    return session.status === 200 ? { accountId: session.body.id } :
      { failure: session };
  };
  const operation = async (token, body, names) => {
    if (!fields(body, names) || !UUID.test(body.operationId ?? ''))
      return { failure: invalid() };
    return owner(token);
  };
  return {
    preview: (token, ringId, body) => breeding.preview(token, ringId, body),
    prepare: (token, ringId, body) => breeding.prepare(token, ringId, body),
    async review(token, body) {
      const bound = await operation(token, body, ['operationId']);
      return bound.failure ?? { status: 200,
        body: await flow.review(bound.accountId, body.operationId) };
    },
    async refresh(token, body) {
      const bound = await operation(token, body, ['operationId', 'approved']);
      return bound.failure ?? { status: 200,
        body: await flow.refresh(bound.accountId, body.operationId, body.approved) };
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
