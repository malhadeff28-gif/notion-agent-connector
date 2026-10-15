// Integrate these helpers into an existing authenticated product backend.
// Determine the customer's management key using your signed-in user's identity.
// Never accept a customer/tenant ID from an agent as an authorization decision.
export function customerConnector(baseUrl, managementKey) {
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(baseUrl + path, {
      method, headers: { Authorization: 'Bearer ' + managementKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    return data;
  };
  return {
    // Navigate the user's browser to connect_url; it sets the OAuth binding cookie.
    beginConnection: () => request('/v1/notion/connect', 'POST'),
    listConnections: () => request('/v1/connections'),
    issueAgentKey: (connectionId, label, role = 'read') => request('/v1/keys', 'POST', { connection_id: connectionId, label, role }),
    revokeAgentKey: keyId => request('/v1/keys/' + keyId, 'DELETE'),
    disconnect: connectionId => request('/v1/connections/' + connectionId, 'DELETE'),
    audit: () => request('/v1/audit')
  };
}
