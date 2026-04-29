/** Ported HTTP benchmark cases (20). */

import { FluidBlankCase } from './cases';

export const CASES_HTTP_BENCH: FluidBlankCase[] = [
  { id: 'hb-http-status-for-not-found-is', category: 'inline', input: 'HTTP status for not found is _', expected: { span: 'HTTP status for not found is _', question: 'What is hTTP status for not found?', answer: '404', answerAlternates: [] } },
  { id: 'hb-http-status-for-ok-is', category: 'inline', input: 'HTTP status for OK is _', expected: { span: 'HTTP status for OK is _', question: 'What is hTTP status for OK?', answer: '200', answerAlternates: [] } },
  { id: 'hb-http-status-for-unauthorized-is', category: 'inline', input: 'HTTP status for unauthorized is _', expected: { span: 'HTTP status for unauthorized is _', question: 'What is hTTP status for unauthorized?', answer: '401', answerAlternates: [] } },
  { id: 'hb-http-status-for-forbidden-is', category: 'inline', input: 'HTTP status for forbidden is _', expected: { span: 'HTTP status for forbidden is _', question: 'What is hTTP status for forbidden?', answer: '403', answerAlternates: [] } },
  { id: 'hb-http-status-for-server-error-is', category: 'inline', input: 'HTTP status for server error is _', expected: { span: 'HTTP status for server error is _', question: 'What is hTTP status for server error?', answer: '500', answerAlternates: [] } },
  { id: 'hb-http-status-for-redirect-is', category: 'inline', input: 'HTTP status for redirect is _', expected: { span: 'HTTP status for redirect is _', question: 'What is hTTP status for redirect?', answer: '301', answerAlternates: ['302'] } },
  { id: 'hb-http-status-for-bad-request-is', category: 'inline', input: 'HTTP status for bad request is _', expected: { span: 'HTTP status for bad request is _', question: 'What is hTTP status for bad request?', answer: '400', answerAlternates: [] } },
  { id: 'hb-http-status-for-created-is', category: 'inline', input: 'HTTP status for created is _', expected: { span: 'HTTP status for created is _', question: 'What is hTTP status for created?', answer: '201', answerAlternates: [] } },
  { id: 'hb-http-status-for-too-many-requests-is', category: 'inline', input: 'HTTP status for too many requests is _', expected: { span: 'HTTP status for too many requests is _', question: 'What is hTTP status for too many requests?', answer: '429', answerAlternates: [] } },
  { id: 'hb-http-status-for-service-unavailable-is', category: 'inline', input: 'HTTP status for service unavailable is _', expected: { span: 'HTTP status for service unavailable is _', question: 'What is hTTP status for service unavailable?', answer: '503', answerAlternates: [] } },
  { id: 'hb-http-status-for-bad-gateway-is', category: 'inline', input: 'HTTP status for bad gateway is _', expected: { span: 'HTTP status for bad gateway is _', question: 'What is hTTP status for bad gateway?', answer: '502', answerAlternates: [] } },
  { id: 'hb-http-status-for-gone-is', category: 'inline', input: 'HTTP status for gone is _', expected: { span: 'HTTP status for gone is _', question: 'What is hTTP status for gone?', answer: '410', answerAlternates: [] } },
  { id: 'hb-http-status-for-moved-permanently-is', category: 'inline', input: 'HTTP status for moved permanently is _', expected: { span: 'HTTP status for moved permanently is _', question: 'What is hTTP status for moved permanently?', answer: '301', answerAlternates: [] } },
  { id: 'hb-http-200-means', category: 'inline', input: 'HTTP 200 means _', expected: { span: 'HTTP 200 means _', question: 'What is hTTP 200 means?', answer: 'OK', answerAlternates: [] } },
  { id: 'hb-http-404-means', category: 'inline', input: 'HTTP 404 means _', expected: { span: 'HTTP 404 means _', question: 'What is hTTP 404 means?', answer: 'Not Found', answerAlternates: ['Not Found'] } },
  { id: 'hb-http-500-means', category: 'inline', input: 'HTTP 500 means _', expected: { span: 'HTTP 500 means _', question: 'What is hTTP 500 means?', answer: 'Internal Server Error', answerAlternates: ['Internal Server Error'] } },
  { id: 'hb-http-301-means', category: 'inline', input: 'HTTP 301 means _', expected: { span: 'HTTP 301 means _', question: 'What is hTTP 301 means?', answer: 'Moved Permanently', answerAlternates: [] } },
  { id: 'hb-http-401-means', category: 'inline', input: 'HTTP 401 means _', expected: { span: 'HTTP 401 means _', question: 'What is hTTP 401 means?', answer: 'Unauthorized', answerAlternates: [] } },
  { id: 'hb-http-403-means', category: 'inline', input: 'HTTP 403 means _', expected: { span: 'HTTP 403 means _', question: 'What is hTTP 403 means?', answer: 'Forbidden', answerAlternates: [] } },
  { id: 'hb-http-429-means', category: 'inline', input: 'HTTP 429 means _', expected: { span: 'HTTP 429 means _', question: 'What is hTTP 429 means?', answer: 'Too Many Requests', answerAlternates: [] } },
];
