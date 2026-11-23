// Connector catalog view model (brief §(e) bite 2): the panel's pure
// builders — header counts, card HTML with escaping, the live-tools
// states, and the read-only law: no card carries an action.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  browseCardHtml,
  catalogHeaderModel,
  catalogPanelHtml,
  featuredCardHtml,
  toolsResultHtml,
} from '../web/marketing/app/catalog-view.mjs';

const featured = {
  kind: 'featured', entryId: 'registry-weather', registryName: 'io.github.cyanheads/nws-weather-mcp-server',
  name: 'Weather', vendorName: 'cyanheads', oneLiner: 'US forecasts and alerts', category: 'data',
  icon: 'weather', authMode: 'none', trustLabel: 'community', endpoint: 'https://nws.caseyjhand.com/mcp',
  endpointHost: 'nws.caseyjhand.com', sourceUrl: 'https://github.com/cyanheads/nws-weather-mcp-server',
  version: '0.12.1', inCatalog: true, curated: false, endpointLive: null,
};

test('header model: counts in plain words', () => {
  const model = catalogHeaderModel({ totals: { curated: 33517, listings: 71827 } });
  assert.match(model.line, /33,517 curated listings/);
  assert.match(model.line, /71,827/);
});

test('featured card: fields render, the funnel state is honest, and there is no action', () => {
  const html = featuredCardHtml(featured);
  assert.match(html, /Weather/);
  assert.match(html, /No sign-in/);
  assert.match(html, /Community listing/);
  assert.match(html, /nws\.caseyjhand\.com/);
  assert.match(html, /data-tools-for="io\.github\.cyanheads\/nws-weather-mcp-server"/);
  assert.match(html, /nightly funnel leaves its mirror row uncurated/);
  assert.ok(!/<button/.test(html), 'a read-only card carries no button');
  assert.ok(!/Connect/.test(html.replace('Connectors', '')), 'no connect action in this bite');
});

test('card HTML escapes what a listing carries', () => {
  const html = featuredCardHtml({ ...featured, name: '<script>alert(1)</script>', oneLiner: 'a "quoted" line' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;quoted&quot;/);
});

test('browse card: publisher, description, source', () => {
  const html = browseCardHtml({
    kind: 'browse', registryName: 'com.example/dr', name: 'Deep Research', publisher: 'com.example',
    description: 'Research the web', sourceUrl: 'https://github.com/example/dr', sourceKind: 'repository',
    version: '1.0.0', endpointHost: 'dr.example.com', endpointLive: true,
  });
  assert.match(html, /Deep Research/);
  assert.match(html, /com\.example/);
  assert.match(html, /href="https:\/\/github\.com\/example\/dr"/);
});

test('tools states: open lists names, auth and unreachable are plain lines', () => {
  const open = toolsResultHtml({ state: 'open', tools: [{ name: 'nws_get_forecast', description: 'f' }, { name: 'nws_get_alert', description: 'a' }] });
  assert.match(open, /2 tools, fetched live just now/);
  assert.match(open, /nws_get_forecast/);
  assert.match(toolsResultHtml({ state: 'auth', tools: [] }), /Sign-in required/);
  assert.match(toolsResultHtml({ state: 'unreachable', tools: [] }), /did not answer/);
  assert.match(toolsResultHtml({ state: 'error', tools: [] }), /not as a connector/);
});

test('the panel: featured shelf, browse shelf, and the seat pick', () => {
  const html = catalogPanelHtml({ featured: [featured], browse: [], totals: { curated: 1, listings: 2 } }, 'gemini');
  assert.match(html, /Featured/);
  assert.match(html, /From the registry mirror/);
  assert.match(html, /<option value="gemini" selected>Gemini<\/option>/);
});
