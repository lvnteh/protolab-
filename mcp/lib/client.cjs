// mcp/lib/client.cjs
// Thin HTTP wrapper over the deployed /api/v1 surface. One method per endpoint;
// no business logic. Auth is a static bearer token. fetch/FormData/Blob are
// Node globals (>=18); fetchImpl is injectable for tests. Non-2xx responses
// throw an Error carrying .status and the parsed .body so callers format them.
class ProtoshareClient {
  constructor({ baseUrl, token, fetchImpl } = {}) {
    if (!token) throw new Error('A PROTOSHARE_TOKEN is required to talk to the remote.');
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, ''); // trim trailing slash
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  get _authHeader() { return { Authorization: `Bearer ${this.token}` }; }

  async _request(path, { method = 'GET', headers = {}, body } = {}) {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { ...this._authHeader, ...headers },
      body,
    });
    if (res.ok === false || (res.status && res.status >= 400)) {
      let parsed = null;
      try { parsed = await res.json(); } catch { /* non-JSON error body */ }
      const err = new Error(`Request ${method} ${path} failed with ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return res;
  }

  async list() {
    return (await this._request('/api/v1/prototypes')).json();
  }

  async feedback(id) {
    return (await this._request(`/api/v1/prototypes/${id}/feedback`)).json();
  }

  async source(id, version) {
    const q = version != null ? `?version=${encodeURIComponent(version)}` : '';
    return (await this._request(`/api/v1/prototypes/${id}/source${q}`)).text();
  }

  async versions(id) {
    return (await this._request(`/api/v1/prototypes/${id}/versions`)).json();
  }

  async pushVersion(id, { buffer, filename, note, baseVersion } = {}) {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'text/html' }), filename || 'prototype.html');
    if (note != null && note !== '') form.append('note', String(note));
    if (baseVersion != null) form.append('baseVersion', String(baseVersion));
    // NB: do NOT set Content-Type — fetch derives the multipart boundary from FormData.
    return (await this._request(`/api/v1/prototypes/${id}/versions`, { method: 'POST', body: form })).json();
  }

  async publish(id, version) {
    const payload = version != null ? { version } : {};
    return (await this._request(`/api/v1/prototypes/${id}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
  }
}

module.exports = { ProtoshareClient };
