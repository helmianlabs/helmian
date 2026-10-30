// Connector contract. Every connector implements these methods; tests run the
// same contract suite against each implementation.
export const CONNECTOR_METHODS = Object.freeze(['readContext', 'proposeWrite', 'applyWrite', 'health']);

export function assertConnector(connector) {
  for (const method of CONNECTOR_METHODS) {
    if (typeof connector?.[method] !== 'function') {
      throw new TypeError(`connector is missing method: ${method}`);
    }
  }
  return connector;
}
