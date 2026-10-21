/**
 * Test helpers — mount the REAL MCP servers in-process.
 *
 * Earlier this file carried copies of the tool implementations. Copies drift, and a test
 * that exercises a copy proves nothing about the thing that ships, so it imports the
 * actual packages instead.
 */
export { register as registerCrm } from '@macp/mcp-fake-crm';
export { register as registerEsp, resetState as resetEspState } from '@macp/mcp-fake-esp';
export { register as registerAnalytics } from '@macp/mcp-analytics';
